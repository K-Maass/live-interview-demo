//! When to rebuild a capture stream. A CoreAudio stream or process tap can stop delivering without an
//! error after sleep/wake, and the system tap's aggregate device is pinned to the output device chosen at
//! start, so a headphone switch can silence it. The capture threads ask this watch once per tick; it
//! holds no device handles, so the decision is unit-tested here and the device calls stay in the sources.
use std::time::{Duration, Instant};

/// No new frames for this long, after frames had been flowing, counts as a stall. Sources deliver
/// silence continuously while healthy, so a quiet room does not stall.
pub const STALL_AFTER: Duration = Duration::from_secs(3);
/// How often a capture thread consults the watch.
pub const TICK: Duration = Duration::from_millis(500);
/// After a stream opens, its device's format is not compared until this long has passed: an aggregate
/// device's nominal rate can settle shortly after it starts. The first reading after that becomes the
/// reference for the device rate.
pub const FORMAT_SETTLE: Duration = Duration::from_secs(1);
/// At most this many format rebuilds within [`FORMAT_REBUILD_WINDOW`]; past that, format changes stop
/// triggering rebuilds for the rest of the stream so a persistent mismatch cannot churn the lane.
pub const MAX_FORMAT_REBUILDS: usize = 3;
pub const FORMAT_REBUILD_WINDOW: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RebuildReason {
    /// The device the stream follows is no longer the system default.
    DefaultDeviceChanged,
    /// Frames stopped arriving (sleep/wake, device removed, driver reset).
    Stalled,
    /// The stream reported an error.
    StreamError,
    /// The device kept its identifier but changed its sample rate or channel layout (AirPods moving to
    /// the hands-free profile when a call opens their microphone). The resampler ratio is fixed when the
    /// stream opens, so continuing would resample at the wrong ratio and drift the lane's timeline.
    FormatChanged,
}

impl RebuildReason {
    pub fn detail(self) -> &'static str {
        match self {
            Self::DefaultDeviceChanged => "The audio device changed; reopening capture",
            Self::Stalled => "Audio stopped arriving; reopening capture",
            Self::StreamError => "The audio device reported an error; reopening capture",
            Self::FormatChanged => "The audio device changed its sample rate; reopening capture",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchAction {
    Keep,
    Rebuild(RebuildReason),
}

/// The input shape a stream was opened with: what the resampler and downmix were built for.
/// `device_rate` is the device's nominal rate when it is read separately from the stream format (the
/// system tap's aggregate device is clocked by the output device), otherwise `None`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaptureFormat {
    pub sample_rate: u32,
    pub channels: u32,
    pub device_rate: Option<u32>,
}

impl CaptureFormat {
    pub fn new(sample_rate: f64, channels: u32) -> Self {
        Self { sample_rate: sample_rate.round() as u32, channels, device_rate: None }
    }
    pub fn with_device_rate(mut self, rate: Option<f64>) -> Self {
        self.device_rate = rate.filter(|r| r.is_finite() && *r > 0.0).map(|r| r.round() as u32);
        self
    }
}

/// Whether a stream opened with `opened` must be rebuilt because the device now reports `observed`.
/// An unreadable format (`None`) is not a change: a vanished device is the stall check's job, and a
/// transient read failure must not churn a healthy lane. A device rate is compared only when both sides
/// could read it.
pub fn format_requires_rebuild(opened: Option<CaptureFormat>, observed: Option<CaptureFormat>) -> bool {
    let (Some(opened), Some(observed)) = (opened, observed) else {
        return false;
    };
    if opened.sample_rate != observed.sample_rate || opened.channels != observed.channels {
        return true;
    }
    matches!((opened.device_rate, observed.device_rate), (Some(a), Some(b)) if a != b)
}

pub struct StreamWatch {
    device: Option<String>,
    format: Option<CaptureFormat>,
    follows_default: bool,
    frames: u64,
    last_progress: Instant,
    delivered: bool,
    attempts: u32,
    not_before: Option<Instant>,
    format_settle_until: Option<Instant>,
    format_rebuilds: std::collections::VecDeque<Instant>,
    format_suspended: bool,
    suspension_reported: bool,
}

/// Wait between rebuild attempts: 1 s doubling to 30 s, so a missing device is not hammered.
pub fn rebuild_backoff(attempts: u32) -> Duration {
    Duration::from_secs(1u64 << attempts.min(5)).min(Duration::from_secs(30))
}

impl StreamWatch {
    /// `device` is the identifier the stream opened; `follows_default` is whether it should move with the
    /// system default (no device was chosen by name, or the source is the system output tap).
    pub fn new(device: Option<String>, follows_default: bool, now: Instant) -> Self {
        Self {
            device,
            format: None,
            follows_default,
            frames: 0,
            last_progress: now,
            delivered: false,
            attempts: 0,
            not_before: None,
            format_settle_until: Some(now + FORMAT_SETTLE),
            format_rebuilds: std::collections::VecDeque::new(),
            format_suspended: false,
            suspension_reported: false,
        }
    }

    /// Records the format the stream was opened with, so a later [`Self::observe_format`] can detect a
    /// change under the same device identifier.
    pub fn with_format(mut self, format: Option<CaptureFormat>) -> Self {
        self.format = format;
        self
    }

    /// [`Self::observe_format`] without a format reading.
    #[cfg(test)]
    pub fn observe(
        &mut self,
        now: Instant,
        frames: u64,
        current_default: Option<&str>,
        stream_error: bool,
    ) -> WatchAction {
        self.observe_format(now, frames, current_default, stream_error, None)
    }

    /// [`Self::observe`] plus the device's current format (`None` when unreadable or not checked).
    pub fn observe_format(
        &mut self,
        now: Instant,
        frames: u64,
        current_default: Option<&str>,
        stream_error: bool,
        observed_format: Option<CaptureFormat>,
    ) -> WatchAction {
        if frames != self.frames {
            self.frames = frames;
            self.last_progress = now;
            self.delivered = true;
            self.attempts = 0;
        }
        let reason = if stream_error {
            Some(RebuildReason::StreamError)
        } else if self.follows_default
            && current_default.is_some_and(|current| self.device.as_deref() != Some(current))
        {
            Some(RebuildReason::DefaultDeviceChanged)
        } else if self.format_changed(now, observed_format) {
            Some(RebuildReason::FormatChanged)
        } else if self.delivered && now.saturating_duration_since(self.last_progress) >= STALL_AFTER {
            // Before the first frame the source's own startup check reports (for example a missing
            // permission); rebuilding would not help there.
            Some(RebuildReason::Stalled)
        } else {
            None
        };
        match reason {
            Some(_) if self.not_before.is_some_and(|at| now < at) => WatchAction::Keep,
            Some(RebuildReason::FormatChanged) => {
                while self
                    .format_rebuilds
                    .front()
                    .is_some_and(|at| now.saturating_duration_since(*at) >= FORMAT_REBUILD_WINDOW)
                {
                    self.format_rebuilds.pop_front();
                }
                if self.format_rebuilds.len() >= MAX_FORMAT_REBUILDS {
                    // Keep recording on the current stream; stalls and errors still rebuild it.
                    self.format_suspended = true;
                    return WatchAction::Keep;
                }
                self.format_rebuilds.push_back(now);
                WatchAction::Rebuild(RebuildReason::FormatChanged)
            }
            Some(reason) => WatchAction::Rebuild(reason),
            None => WatchAction::Keep,
        }
    }

    /// Whether the device's format differs from the one the stream was built for. Not checked while the
    /// stream settles or after the rebuild cap was reached. The first reading after settling adopts the
    /// device's settled nominal rate when the stream format itself (rate and channels) still matches.
    fn format_changed(&mut self, now: Instant, observed: Option<CaptureFormat>) -> bool {
        if self.format_suspended || self.format_settle_until.is_some_and(|at| now < at) {
            return false;
        }
        if let (Some(opened), Some(seen)) = (self.format, observed) {
            if self.format_settle_until.take().is_some()
                && opened.sample_rate == seen.sample_rate
                && opened.channels == seen.channels
            {
                self.format = Some(seen);
            }
        }
        format_requires_rebuild(self.format, observed)
    }

    /// True once, when format rebuilds were just suspended by the cap, so the caller logs it a single time.
    pub fn take_format_suspension(&mut self) -> bool {
        if self.format_suspended && !self.suspension_reported {
            self.suspension_reported = true;
            return true;
        }
        false
    }

    /// Records a rebuild attempt. On success the stream follows `device` and gets a fresh stall window.
    pub fn rebuilt(&mut self, now: Instant, device: Option<String>, succeeded: bool) {
        self.rebuilt_with_format(now, device, None, succeeded);
    }

    /// [`Self::rebuilt`] that also records the format the reopened stream was built for.
    pub fn rebuilt_with_format(
        &mut self,
        now: Instant,
        device: Option<String>,
        format: Option<CaptureFormat>,
        succeeded: bool,
    ) {
        self.attempts = self.attempts.saturating_add(1);
        self.not_before = Some(now + rebuild_backoff(self.attempts));
        self.last_progress = now;
        if succeeded {
            self.device = device;
            if format.is_some() {
                self.format = format;
            }
            self.format_settle_until = Some(now + FORMAT_SETTLE);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn at(start: Instant, ms: u64) -> Instant {
        start + Duration::from_millis(ms)
    }
    #[test]
    fn flowing_frames_and_a_quiet_room_are_kept() {
        let t = Instant::now();
        let mut watch = StreamWatch::new(Some("Built-in".into()), true, t);
        for tick in 1..20u64 {
            assert_eq!(watch.observe(at(t, tick * 500), tick * 8000, Some("Built-in"), false), WatchAction::Keep);
        }
    }
    #[test]
    fn frames_that_stop_after_flowing_trigger_a_rebuild() {
        let t = Instant::now();
        let mut watch = StreamWatch::new(None, false, t);
        assert_eq!(watch.observe(at(t, 500), 8000, None, false), WatchAction::Keep);
        assert_eq!(watch.observe(at(t, 3000), 8000, None, false), WatchAction::Keep);
        assert_eq!(
            watch.observe(at(t, 3600), 8000, None, false),
            WatchAction::Rebuild(RebuildReason::Stalled)
        );
    }
    #[test]
    fn a_source_that_never_delivered_is_left_to_its_startup_check() {
        let t = Instant::now();
        let mut watch = StreamWatch::new(None, false, t);
        assert_eq!(watch.observe(at(t, 10_000), 0, None, false), WatchAction::Keep);
    }
    #[test]
    fn a_new_default_device_rebuilds_only_a_stream_that_follows_the_default() {
        let t = Instant::now();
        let mut following = StreamWatch::new(Some("Speakers".into()), true, t);
        assert_eq!(
            following.observe(at(t, 500), 10, Some("AirPods"), false),
            WatchAction::Rebuild(RebuildReason::DefaultDeviceChanged)
        );
        let mut chosen = StreamWatch::new(Some("USB Mic".into()), false, t);
        assert_eq!(chosen.observe(at(t, 500), 10, Some("AirPods"), false), WatchAction::Keep);
        // An unreadable default is not a change.
        assert_eq!(following.observe(at(t, 600), 20, None, false), WatchAction::Keep);
    }
    #[test]
    fn a_stream_error_rebuilds() {
        let t = Instant::now();
        let mut watch = StreamWatch::new(None, false, t);
        assert_eq!(
            watch.observe(at(t, 100), 0, None, true),
            WatchAction::Rebuild(RebuildReason::StreamError)
        );
    }
    #[test]
    fn failed_rebuilds_back_off_and_a_successful_one_follows_the_new_device() {
        let t = Instant::now();
        let mut watch = StreamWatch::new(Some("Speakers".into()), true, t);
        watch.rebuilt(at(t, 0), Some("AirPods".into()), false);
        // Still on the old device and inside the backoff: no hammering.
        assert_eq!(watch.observe(at(t, 1000), 0, Some("AirPods"), false), WatchAction::Keep);
        assert_eq!(
            watch.observe(at(t, 2100), 0, Some("AirPods"), false),
            WatchAction::Rebuild(RebuildReason::DefaultDeviceChanged)
        );
        watch.rebuilt(at(t, 2100), Some("AirPods".into()), true);
        assert_eq!(watch.observe(at(t, 9000), 50, Some("AirPods"), false), WatchAction::Keep);
        assert_eq!(rebuild_backoff(1), Duration::from_secs(2));
        assert_eq!(rebuild_backoff(9), Duration::from_secs(30));
    }
    #[test]
    fn format_decision_rebuilds_only_on_a_real_rate_or_layout_change() {
        let stereo48 = CaptureFormat::new(48_000.0, 2);
        assert!(!format_requires_rebuild(Some(stereo48), Some(CaptureFormat::new(48_000.0, 2))));
        // Rounding noise from a Float64 nominal rate is not a change.
        assert!(!format_requires_rebuild(Some(stereo48), Some(CaptureFormat::new(47_999.9999, 2))));
        // AirPods entering the hands-free profile under the same UID.
        assert!(format_requires_rebuild(Some(stereo48), Some(CaptureFormat::new(16_000.0, 2))));
        assert!(format_requires_rebuild(Some(stereo48), Some(CaptureFormat::new(24_000.0, 1))));
        assert!(format_requires_rebuild(Some(stereo48), Some(CaptureFormat::new(48_000.0, 1))));
        // Unreadable on either side never churns a healthy lane.
        assert!(!format_requires_rebuild(Some(stereo48), None));
        assert!(!format_requires_rebuild(None, Some(stereo48)));
        // The aggregate clock rate counts only when both sides read it.
        let clocked = stereo48.with_device_rate(Some(48_000.0));
        assert!(format_requires_rebuild(Some(clocked), Some(stereo48.with_device_rate(Some(24_000.0)))));
        assert!(!format_requires_rebuild(Some(clocked), Some(stereo48)));
        assert!(!format_requires_rebuild(Some(stereo48), Some(clocked)));
    }
    #[test]
    fn a_rate_change_under_the_same_device_rebuilds_once_then_follows_the_new_rate() {
        let t = Instant::now();
        let wide = CaptureFormat::new(48_000.0, 2);
        let narrow = CaptureFormat::new(16_000.0, 1);
        let mut watch = StreamWatch::new(Some("AirPods".into()), true, t).with_format(Some(wide));
        assert_eq!(watch.observe_format(at(t, 500), 10, Some("AirPods"), false, Some(wide)), WatchAction::Keep);
        assert_eq!(
            watch.observe_format(at(t, 1000), 20, Some("AirPods"), false, Some(narrow)),
            WatchAction::Rebuild(RebuildReason::FormatChanged)
        );
        watch.rebuilt_with_format(at(t, 1000), Some("AirPods".into()), Some(narrow), true);
        assert_eq!(watch.observe_format(at(t, 1500), 30, Some("AirPods"), false, Some(narrow)), WatchAction::Keep);
        // A failed rebuild keeps the old format, so the change is retried after the backoff.
        let mut failing = StreamWatch::new(Some("AirPods".into()), true, t).with_format(Some(wide));
        failing.rebuilt_with_format(at(t, 0), None, None, false);
        assert_eq!(failing.observe_format(at(t, 1000), 1, Some("AirPods"), false, Some(narrow)), WatchAction::Keep);
        assert_eq!(
            failing.observe_format(at(t, 2100), 2, Some("AirPods"), false, Some(narrow)),
            WatchAction::Rebuild(RebuildReason::FormatChanged)
        );
    }
    #[test]
    fn the_settled_device_rate_becomes_the_reference_without_a_rebuild() {
        let t = Instant::now();
        // The aggregate reported 44.1 kHz at start, then settled on 48 kHz; the tap stream itself is unchanged.
        let opened = CaptureFormat::new(48_000.0, 2).with_device_rate(Some(44_100.0));
        let settled = CaptureFormat::new(48_000.0, 2).with_device_rate(Some(48_000.0));
        let mut watch = StreamWatch::new(Some("Out".into()), true, t).with_format(Some(opened));
        assert_eq!(watch.observe_format(at(t, 500), 1, Some("Out"), false, Some(settled)), WatchAction::Keep);
        assert_eq!(watch.observe_format(at(t, 1000), 2, Some("Out"), false, Some(settled)), WatchAction::Keep);
        for tick in 3..40u64 {
            assert_eq!(watch.observe_format(at(t, tick * 500), tick, Some("Out"), false, Some(settled)), WatchAction::Keep);
        }
        // A later real change is still detected against the settled reference.
        assert_eq!(
            watch.observe_format(at(t, 21_000), 50, Some("Out"), false, Some(settled.with_device_rate(Some(24_000.0)))),
            WatchAction::Rebuild(RebuildReason::FormatChanged)
        );
    }
    #[test]
    fn a_persistent_mismatch_rebuilds_at_most_three_times_then_keeps_recording() {
        let t = Instant::now();
        let opened = CaptureFormat::new(48_000.0, 2);
        // The device keeps reporting a different rate however often the stream is reopened.
        let stuck = CaptureFormat::new(16_000.0, 1);
        let mut watch = StreamWatch::new(Some("Mic".into()), false, t).with_format(Some(opened));
        let mut rebuilds = 0;
        let mut ms = 0u64;
        let mut suspensions = 0;
        while ms < 110_000 {
            ms += 500;
            // Frames keep flowing, which resets the backoff: only the cap stops the churn.
            if let WatchAction::Rebuild(reason) = watch.observe_format(at(t, ms), ms, None, false, Some(stuck)) {
                assert_eq!(reason, RebuildReason::FormatChanged);
                rebuilds += 1;
                watch.rebuilt_with_format(at(t, ms), Some("Mic".into()), Some(opened), true);
            }
            if watch.take_format_suspension() {
                suspensions += 1;
            }
        }
        assert_eq!(rebuilds, MAX_FORMAT_REBUILDS);
        assert_eq!(suspensions, 1, "the suspension is reported once");
        // Stalls still rebuild a suspended watch.
        assert_eq!(
            watch.observe_format(at(t, 114_000), ms, None, false, Some(stuck)),
            WatchAction::Rebuild(RebuildReason::Stalled)
        );
    }
    #[test]
    fn format_rebuilds_spread_beyond_the_window_are_not_capped() {
        let t = Instant::now();
        let a = CaptureFormat::new(48_000.0, 2);
        let b = CaptureFormat::new(16_000.0, 1);
        let mut watch = StreamWatch::new(Some("AirPods".into()), true, t).with_format(Some(a));
        let mut current = a;
        for n in 0..6u64 {
            let now = at(t, 2_000 + n * 61_000);
            let next = if current == a { b } else { a };
            assert_eq!(
                watch.observe_format(now, n + 1, Some("AirPods"), false, Some(next)),
                WatchAction::Rebuild(RebuildReason::FormatChanged),
                "switch {n}"
            );
            watch.rebuilt_with_format(now, Some("AirPods".into()), Some(next), true);
            current = next;
        }
        assert!(!watch.take_format_suspension());
    }
}
