//! Setup "can it hear you" check. Opens the microphone ("me") or the system-audio tap ("remote") for a
//! short while and sends the window only a loudness level. The audio itself is dropped as it arrives:
//! nothing is written, transcribed, kept or sent anywhere. Refused during a meeting, ended by any meeting
//! start, opened only once access is granted (so it never raises a prompt), and stopped on its own after
//! [`CHECK_LIMIT`].

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc::error::TryRecvError;

use crate::audio::microphone::Microphone;
use crate::audio::{AudioSource, CapturedFrames};
use crate::commands::MeetingController;

/// The meeting id the capture sources report under during a check. `report_capture_health` ignores it,
/// so a check never creates a record folder or a recording-health event.
pub const CHECK_ID: &str = "__setup-audio-check__";
/// A forgotten check releases the device by itself.
pub const CHECK_LIMIT: Duration = Duration::from_secs(20);
/// How often the window gets a level: often enough for a smooth meter, rare enough to stay cheap.
const EMIT_EVERY: Duration = Duration::from_millis(60);

#[derive(Default)]
pub struct AudioCheck {
    running: Mutex<Option<Arc<AtomicBool>>>,
    sequence: AtomicU64,
}

impl AudioCheck {
    /// Ends the current check, if any. Its device is released within a few milliseconds.
    pub fn stop(&self) {
        if let Some(flag) = self.running.lock().unwrap().take() {
            flag.store(false, Ordering::SeqCst);
        }
    }
}

/// Loudness of one chunk from 0 to 1: its RMS in dBFS, mapped linearly from -60 dB (0) to 0 dB (1).
pub fn level(pcm: &[i16]) -> f32 {
    if pcm.is_empty() {
        return 0.0;
    }
    let sum: f64 = pcm
        .iter()
        .map(|&s| {
            let x = f64::from(s) / 32768.0;
            x * x
        })
        .sum();
    let rms = (sum / pcm.len() as f64).sqrt();
    if rms <= 0.0 {
        return 0.0;
    }
    ((20.0 * rms.log10() + 60.0) / 60.0).clamp(0.0, 1.0) as f32
}

fn granted(lane: &str) -> bool {
    match lane {
        "me" => crate::permissions::microphone_granted(),
        "remote" => crate::permissions::system_audio_checkable(),
        _ => false,
    }
}

fn source(app: &AppHandle, lane: &str) -> Result<Box<dyn AudioSource>, &'static str> {
    match lane {
        "me" => Ok(Box::new(Microphone { device_name: None, app: app.clone(), meeting_id: CHECK_ID.into() })),
        #[cfg(target_os = "macos")]
        "remote" => Ok(Box::new(crate::audio::system_macos::SystemAudio { app: app.clone(), meeting_id: CHECK_ID.into() })),
        _ => Err("unsupported"),
    }
}

/// Starts a check on one lane and returns its number. Levels arrive as `audio-check-level` events
/// `{check, lane, level}`; the last one carries `ended: true`.
#[tauri::command]
pub async fn start_audio_check(
    app: AppHandle,
    lane: String,
    meeting: State<'_, MeetingController>,
    check: State<'_, AudioCheck>,
) -> Result<u64, String> {
    if lane != "me" && lane != "remote" {
        return Err("unknownLane".into());
    }
    if meeting.is_active() {
        return Err("meetingActive".into());
    }
    if !granted(&lane) {
        return Err("notGranted".into());
    }
    check.stop();
    let id = check.sequence.fetch_add(1, Ordering::SeqCst) + 1;
    let running = Arc::new(AtomicBool::new(true));
    *check.running.lock().unwrap() = Some(running.clone());
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<CapturedFrames>();
    let opened = {
        let (app, lane, running) = (app.clone(), lane.clone(), running.clone());
        // Opening a device can block for a moment; keep the event loop free.
        tokio::task::spawn_blocking(move || source(&app, &lane).map_err(anyhow::Error::msg).and_then(|s| s.start(tx, running)))
            .await
            .map_err(|_| "checkFailed".to_string())?
    };
    if let Err(error) = opened {
        running.store(false, Ordering::SeqCst);
        log::warn!("[audio-check] {lane} could not start: {error}");
        return Err("captureUnavailable".into());
    }
    std::thread::spawn(move || {
        let begun = Instant::now();
        let mut last = Instant::now();
        let mut loudest = 0.0f32;
        while running.load(Ordering::SeqCst) && begun.elapsed() < CHECK_LIMIT {
            match rx.try_recv() {
                // Only the loudness is kept; the samples are dropped here.
                Ok(frames) => loudest = loudest.max(level(&frames.pcm)),
                Err(TryRecvError::Empty) => std::thread::sleep(Duration::from_millis(10)),
                Err(TryRecvError::Disconnected) => break,
            }
            if last.elapsed() >= EMIT_EVERY {
                let _ = app.emit("audio-check-level", json!({"check": id, "lane": lane, "level": loudest}));
                loudest = 0.0;
                last = Instant::now();
            }
        }
        running.store(false, Ordering::SeqCst);
        let _ = app.emit("audio-check-level", json!({"check": id, "lane": lane, "level": 0.0, "ended": true}));
    });
    Ok(id)
}

#[tauri::command]
pub fn stop_audio_check(check: State<'_, AudioCheck>) {
    check.stop();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_and_an_empty_chunk_read_as_zero() {
        assert_eq!(level(&[]), 0.0);
        assert_eq!(level(&[0; 160]), 0.0);
    }

    #[test]
    fn full_scale_reads_as_one_and_quiet_audio_low() {
        assert!((level(&[i16::MAX, i16::MIN].repeat(80)) - 1.0).abs() < 0.01);
        // About -40 dBFS: a quiet room, a third of the way up.
        let quiet: Vec<i16> = (0..160).map(|i| if i % 2 == 0 { 328 } else { -328 }).collect();
        assert!((level(&quiet) - 1.0 / 3.0).abs() < 0.02);
    }

    #[test]
    fn levels_never_leave_zero_to_one() {
        for amplitude in [1i16, 10, 100, 1000, 10000, i16::MAX] {
            let l = level(&[amplitude; 64]);
            assert!((0.0..=1.0).contains(&l), "{amplitude} gave {l}");
        }
    }

    #[test]
    fn stopping_ends_the_current_check_and_is_safe_without_one() {
        let check = AudioCheck::default();
        check.stop();
        let flag = Arc::new(AtomicBool::new(true));
        *check.running.lock().unwrap() = Some(flag.clone());
        check.stop();
        assert!(!flag.load(Ordering::SeqCst));
        assert!(check.running.lock().unwrap().is_none());
    }
}
