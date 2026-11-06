use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SizedSample};
use tokio::sync::mpsc::UnboundedSender;

use super::resample::LinearResampler;
use super::watchdog::{CaptureFormat, RebuildReason, StreamWatch, WatchAction};
use super::{AudioSource, TARGET_SAMPLE_RATE};

/// List the names of available input devices, for the Settings picker.
pub fn list_input_devices() -> Result<Vec<String>, String> {
    let host = cpal::default_host();
    let mut names = Vec::new();
    let devices = host
        .input_devices()
        .map_err(|_| "inputDeviceListUnavailable".to_string())?;
    for d in devices {
        if let Ok(name) = d.name() {
            if !names.contains(&name) {
                names.push(name);
            }
        }
    }
    Ok(names)
}

/// Microphone capture ("me"). Uses the named input device, or the system
/// default when `device_name` is `None`/empty.
pub struct Microphone {
    pub device_name: Option<String>,
    pub app: tauri::AppHandle,
    pub meeting_id: String,
}

/// How long [`Microphone::start`] waits for the capture thread's verdict on
/// opening the device. Opening takes a few milliseconds in practice, and a
/// device that cannot be opened at all fails immediately — so this grace is
/// only ever burned in full by a driver that wedges mid-open, where blocking
/// `start_meeting` (a main-thread command) any longer would freeze the UI.
const OPEN_VERDICT_GRACE: Duration = Duration::from_millis(1500);

impl AudioSource for Microphone {
    /// The device can only be opened on the thread that will own it — the cpal
    /// stream is `!Send` on macOS — which is why the verdict has to come back
    /// over a channel instead of `start` opening the device itself.
    ///
    /// Reporting it at all is the point: `start` used to return `Ok`
    /// unconditionally and leave the real failure to an `eprintln!` that a
    /// release build has no console for. A Windows user with mic access denied
    /// (or the device held by another app) got the LIVE badge, a ticking clock,
    /// a whole meeting of nothing, and not one line in the app log about it.
    fn start(
        &self,
        tx: UnboundedSender<super::CapturedFrames>,
        running: Arc<AtomicBool>,
    ) -> Result<JoinHandle<()>> {
        let device_name = self.device_name.clone();
        let app = self.app.clone();
        let meeting = self.meeting_id.clone();
        crate::commands::report_capture_health(
            &app,
            &meeting,
            "me",
            "captureStarting",
            Some("Opening microphone audio"),
        );
        let (verdict_tx, verdict_rx) = std::sync::mpsc::channel::<Result<()>>();
        let handle = std::thread::spawn(move || {
            let flow = Flow::default();
            match open(device_name.clone(), tx.clone(), &flow) {
            Ok((stream, opened, format, uid)) => {
                let _ = verdict_tx.send(Ok(()));
                if running.load(Ordering::SeqCst) {
                    crate::commands::report_capture_health(
                        &app,
                        &meeting,
                        "me",
                        "captureStarted",
                        None,
                    );
                }
                let source = Reopen { device_name, tx, flow, app, meeting };
                capture_until_stopped(stream, opened, format, uid, source, running);
            }
            // Logged here as well as sent: past the grace below nobody is
            // listening on the channel any more, and the device's own reason is
            // the one thing support needs out of a silent meeting.
            Err(e) => {
                log::error!("[mic] could not open the input device: {e}");
                let _ = verdict_tx.send(Err(e));
            }
        }});
        match verdict_rx.recv_timeout(OPEN_VERDICT_GRACE) {
            Ok(Ok(())) => Ok(handle),
            Ok(Err(e)) => Err(e),
            // A slow open gets the benefit of the doubt — the thread is still
            // working on it and will log either way. Failing here instead would
            // abort a meeting over a merely sluggish USB or Bluetooth device.
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                log::warn!(
                    "[mic] device startup has no verified result within {OPEN_VERDICT_GRACE:?}"
                );
                // Ownership remains with the recording. The worker reports actual
                // readiness/failure later; consent must not discard this lane.
                Ok(handle)
            }
            // The thread ended without a verdict, i.e. it panicked inside
            // `open`. Nothing is capturing, so this must not read as success.
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err(anyhow!(
                "microphone capture thread ended before the device opened"
            )),
        }
    }
}

/// Frame count and error flag shared with the realtime callbacks, read by the watch in
/// [`capture_until_stopped`].
#[derive(Default, Clone)]
struct Flow {
    frames: Arc<AtomicU64>,
    errored: Arc<AtomicBool>,
}

/// Everything needed to open the stream again after a device change or stall.
struct Reopen {
    device_name: Option<String>,
    tx: UnboundedSender<super::CapturedFrames>,
    flow: Flow,
    app: tauri::AppHandle,
    meeting: String,
}

/// The input format the device reports now, for the watch's rate/layout check. CoreAudio only; elsewhere
/// the stream error and stall checks remain the rebuild triggers.
/// Prefers the device UID resolved when the stream opened; the name is the fallback when no UID was readable.
fn observed_format(uid: Option<&str>, device_name: &str) -> Option<CaptureFormat> {
    #[cfg(target_os = "macos")]
    {
        match uid {
            Some(uid) => super::system_macos::input_format_by_uid(uid),
            None => super::system_macos::input_device_format(Some(device_name)),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (uid, device_name);
        None
    }
}

/// The UID of the device just opened: the default input when no device was chosen by name.
fn opened_uid(requested: Option<&str>, name: &str) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        super::system_macos::input_device_uid(requested.filter(|n| !n.is_empty()).map(|_| name))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (requested, name);
        None
    }
}

/// What the stream was built for: cpal's config plus the device's nominal rate where readable.
fn opened_format(uid: Option<&str>, name: &str, config: &cpal::StreamConfig) -> CaptureFormat {
    let built = CaptureFormat::new(config.sample_rate.0 as f64, config.channels as u32);
    CaptureFormat { device_rate: observed_format(uid, name).and_then(|f| f.device_rate), ..built }
}

/// An opened microphone: the stream, its device name and UID, and the format it was built for.
type Opened = (cpal::Stream, String, CaptureFormat, Option<String>);

/// Open the requested input device and start its stream. Everything that can
/// fail about a microphone happens in here, so the verdict [`Microphone::start`]
/// waits on carries a real reason. The returned stream must stay on the calling
/// thread — it is `!Send` on macOS. Also returns the opened device's name.
fn open(
    device_name: Option<String>,
    tx: UnboundedSender<super::CapturedFrames>,
    flow: &Flow,
) -> Result<Opened> {
    let host = cpal::default_host();
    // Select the requested device by name, else fall back to the default.
    let device = match device_name.as_deref().filter(|n| !n.is_empty()) {
        Some(want) => host
            .input_devices()
            .ok()
            .and_then(|mut ds| ds.find(|d| d.name().map(|n| n == want).unwrap_or(false)))
            .or_else(|| host.default_input_device())
            .ok_or_else(|| anyhow!("no input device matching {want:?}"))?,
        None => host
            .default_input_device()
            .ok_or_else(|| anyhow!("no default input device"))?,
    };
    let default_cfg = device.default_input_config()?;
    let sample_format = default_cfg.sample_format();
    let config: cpal::StreamConfig = default_cfg.into();
    let channels = config.channels as usize;
    let in_rate = config.sample_rate.0;
    let name = device.name().unwrap_or_default();

    log::info!(
        "[mic] capturing on {:?} @ {} Hz, {} ch ({:?}) → {} Hz mono",
        name,
        in_rate,
        channels,
        sample_format,
        TARGET_SAMPLE_RATE
    );

    // The cpal stream is !Send on macOS, so it lives entirely on this thread.
    let stream = match sample_format {
        cpal::SampleFormat::F32 => build_stream::<f32>(&device, &config, channels, in_rate, tx, flow.clone())?,
        cpal::SampleFormat::I16 => build_stream::<i16>(&device, &config, channels, in_rate, tx, flow.clone())?,
        cpal::SampleFormat::U16 => build_stream::<u16>(&device, &config, channels, in_rate, tx, flow.clone())?,
        other => return Err(anyhow!("unsupported sample format: {other:?}")),
    };
    stream.play()?;
    let uid = opened_uid(device_name.as_deref(), &name);
    let format = opened_format(uid.as_deref(), &name, &config);
    Ok((stream, name, format, uid))
}

/// Hold an opened device until the session's gate clears, then release it. While held, the stream is
/// reopened when it stops delivering (sleep/wake, a removed device), reports an error, or, when no device
/// was chosen by name, when the system default input changes. Recording continues across a reopen.
///
/// The device's input format is also checked each tick: a Bluetooth headset that enters its hands-free
/// profile keeps its name but changes rate, and the resampler ratio is fixed per stream.
fn capture_until_stopped(
    stream: cpal::Stream,
    opened: String,
    format: CaptureFormat,
    uid: Option<String>,
    source: Reopen,
    running: Arc<AtomicBool>,
) {
    let mut current_uid = uid;
    let follows_default = source.device_name.as_deref().is_none_or(str::is_empty);
    let mut current_device = opened.clone();
    let mut watch = StreamWatch::new(Some(opened), follows_default, std::time::Instant::now())
        .with_format(Some(format));
    let mut stream = Some(stream);
    let mut last_tick = std::time::Instant::now();
    // Poll the gate tightly so the stream (and the device) is released within a
    // few ms of stop — voice typing cuts on release and a lingering device would
    // keep feeding the next moments of audio. A 10 ms tick is negligible CPU.
    while running.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(10));
        if last_tick.elapsed() < super::watchdog::TICK {
            continue;
        }
        let now = std::time::Instant::now();
        last_tick = now;
        let default = if follows_default {
            cpal::default_host().default_input_device().and_then(|d| d.name().ok())
        } else {
            None
        };
        let observed = stream.as_ref().and_then(|_| observed_format(current_uid.as_deref(), &current_device));
        let action = watch.observe_format(
            now,
            source.flow.frames.load(Ordering::Relaxed),
            default.as_deref(),
            source.flow.errored.swap(false, Ordering::Relaxed),
            observed,
        );
        if watch.take_format_suspension() {
            log::warn!("[mic] the input format keeps changing; no more format rebuilds for this meeting, recording continues");
        }
        let WatchAction::Rebuild(reason) = action else { continue };
        log::warn!("[mic] reopening capture: {reason:?}");
        let code = if reason == RebuildReason::Stalled { "captureStalled" } else { "captureInterrupted" };
        crate::commands::report_capture_health(&source.app, &source.meeting, "me", code, Some(reason.detail()));
        drop(stream.take());
        match open(source.device_name.clone(), source.tx.clone(), &source.flow) {
            Ok((reopened, name, format, uid)) => {
                stream = Some(reopened);
                log::info!("[mic] reopened {name:?} as {format:?}");
                watch.rebuilt_with_format(now, Some(name.clone()), Some(format), true);
                current_device = name;
                current_uid = uid;
                crate::commands::report_capture_health(&source.app, &source.meeting, "me", "captureRecovered", None);
            }
            Err(error) => {
                log::warn!("[mic] reopen failed, will retry: {error}");
                watch.rebuilt(now, None, false);
            }
        }
    }
    drop(stream);
}

fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    in_rate: u32,
    tx: UnboundedSender<super::CapturedFrames>,
    flow: Flow,
) -> Result<cpal::Stream>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let mut resampler = LinearResampler::new(in_rate, TARGET_SAMPLE_RATE);
    let frames_seen = flow.frames.clone();
    let errored = flow.errored;
    let stream = device.build_input_stream(
        config,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            // Downmix interleaved frames to mono f32.
            let frames = data.len() / channels.max(1);
            frames_seen.fetch_add(frames as u64, Ordering::Relaxed);
            let mut mono = Vec::with_capacity(frames);
            for f in 0..frames {
                let mut acc = 0.0f32;
                for c in 0..channels {
                    acc += f32::from_sample(data[f * channels + c]);
                }
                mono.push(acc / channels as f32);
            }
            let mut out = Vec::new();
            resampler.process(&mono, &mut out);
            if !out.is_empty() {
                let _ = tx.send(super::CapturedFrames::now(out));
            }
        },
        // A device lost or reconfigured mid-meeting surfaces only here. The capture
        // thread's watch reopens the stream and reports it; the log keeps the reason.
        move |e| {
            log::warn!("[mic] stream error: {e}");
            errored.store(true, Ordering::Relaxed);
        },
        None,
    )?;
    Ok(stream)
}
