//! Notices a microphone that sends only digital silence, as a muted input, a denied permission or the wrong
//! device does: macOS then delivers exact zeros instead of failing. It only reports; recording never stops.

use super::TARGET_SAMPLE_RATE;

/// About a minute of exact zeros before the person is told.
pub const SILENCE_LIMIT_FRAMES: u64 = 60 * TARGET_SAMPLE_RATE as u64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SilenceChange {
    /// The microphone has sent exact digital silence for [`SILENCE_LIMIT_FRAMES`] while recording.
    Silent,
    /// Sound arrived after silence was reported.
    Signal,
}

/// Counts recorded frames of exact digital silence on the `me` lane. Paused audio is not counted, and the
/// count restarts at any non-zero sample. Silence is reported once per [`SILENCE_LIMIT_FRAMES`] while it
/// lasts, so a report another lane code replaced comes back; the caller drops repeats.
#[derive(Debug, Default)]
pub struct SilenceWatch {
    silent_frames: u64,
    reported: bool,
}

impl SilenceWatch {
    pub fn observe(&mut self, pcm: &[i16], paused: bool) -> Option<SilenceChange> {
        if paused || pcm.is_empty() {
            return None;
        }
        // `level` is 0 for anything quieter than -60 dBFS; only exact zeros are digital silence.
        if crate::audio_check::level(pcm) == 0.0 && pcm.iter().all(|&s| s == 0) {
            self.silent_frames += pcm.len() as u64;
            if self.silent_frames >= SILENCE_LIMIT_FRAMES {
                self.silent_frames = 0;
                self.reported = true;
                return Some(SilenceChange::Silent);
            }
            return None;
        }
        self.silent_frames = 0;
        // A faint hiss of one or two bits is not yet the person's voice: clear only on audible sound.
        if self.reported && crate::audio_check::level(pcm) > 0.0 {
            self.reported = false;
            return Some(SilenceChange::Signal);
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const PACKET: usize = 160; // 10 ms
    fn feed(watch: &mut SilenceWatch, sample: i16, seconds: u64, paused: bool) -> Vec<SilenceChange> {
        let packet = vec![sample; PACKET];
        (0..seconds * 100).filter_map(|_| watch.observe(&packet, paused)).collect()
    }
    #[test]
    fn a_minute_of_exact_zeros_is_reported_once_and_sound_clears_it() {
        let mut watch = SilenceWatch::default();
        assert!(feed(&mut watch, 0, 59, false).is_empty());
        assert_eq!(feed(&mut watch, 0, 1, false), [SilenceChange::Silent]);
        assert!(feed(&mut watch, 0, 30, false).is_empty());
        assert_eq!(feed(&mut watch, 3000, 1, false), [SilenceChange::Signal]);
        assert!(feed(&mut watch, 3000, 5, false).is_empty());
    }
    #[test]
    fn quiet_room_noise_is_not_digital_silence() {
        let mut watch = SilenceWatch::default();
        let mut hiss = vec![0i16; PACKET];
        hiss[7] = 1;
        assert!((0..100 * 120).all(|_| watch.observe(&hiss, false).is_none()));
    }
    #[test]
    fn pause_neither_counts_nor_clears() {
        let mut watch = SilenceWatch::default();
        assert!(feed(&mut watch, 0, 120, true).is_empty(), "paused audio is not recorded");
        assert_eq!(feed(&mut watch, 0, 60, false), [SilenceChange::Silent]);
        assert!(feed(&mut watch, 3000, 5, true).is_empty());
        assert_eq!(feed(&mut watch, 3000, 1, false), [SilenceChange::Signal]);
    }
    #[test]
    fn silence_that_continues_is_reported_again_each_minute() {
        let mut watch = SilenceWatch::default();
        assert_eq!(feed(&mut watch, 0, 180, false), [SilenceChange::Silent; 3]);
    }
    #[test]
    fn faint_bits_after_silence_do_not_clear_it() {
        let mut watch = SilenceWatch::default();
        assert_eq!(feed(&mut watch, 0, 60, false), [SilenceChange::Silent]);
        assert!(feed(&mut watch, 1, 5, false).is_empty(), "-90 dBFS is below the level meter");
        assert_eq!(feed(&mut watch, 2000, 1, false), [SilenceChange::Signal]);
    }
}
