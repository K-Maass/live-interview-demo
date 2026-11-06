//! System-audio capture on macOS via the Core Audio process-tap API
//! (`AudioHardwareCreateProcessTap`, macOS 14.2+). We create a global tap of all
//! system output, wrap it in a private aggregate device, and pull the tapped
//! frames through an IOProc — no virtual audio device (BlackHole) and no
//! screen-recording permission required.
//!
//! This is the "them" source (the remote participants' audio). It is behind the
//! [`AudioSource`] trait so a ScreenCaptureKit-based source (broader macOS
//! version support) and a Windows WASAPI loopback source can be added later
//! without touching the rest of the app.
//!
//! NOTE: runtime capture requires the `com.apple.security.device.audio-input`
//! entitlement (see src-tauri/entitlements.plist) and the "System Audio
//! Recording Only" TCC grant (macOS 14.4+, prompted via
//! `NSAudioCaptureUsageDescription` in Info.plist — it lists Live Interview under
//! System Settings → Privacy → Screen & System Audio Recording). If tap setup
//! fails, this source logs and exits cleanly — the meeting continues mic-only.

// The `objc` 0.2 macros emit `cfg(cargo-clippy)` checks the modern compiler
// flags; the generated code is correct, so quiet the noise.
#![allow(unexpected_cfgs)]

use std::ffi::{c_void, CStr};
use std::os::raw::c_char;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use tauri::AppHandle;

use anyhow::{anyhow, Result};
use core_foundation::array::CFArray;
use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::CFString;
use coreaudio_sys::{
    AudioBufferList, AudioDeviceCreateIOProcID, AudioDeviceDestroyIOProcID, AudioDeviceIOProcID,
    AudioDeviceStart, AudioDeviceStop, AudioObjectGetPropertyData, AudioObjectID,
    AudioObjectGetPropertyDataSize, AudioObjectPropertyAddress, AudioStreamBasicDescription,
    AudioTimeStamp, OSStatus,
};
use objc::runtime::Object;
use objc::{class, msg_send, sel, sel_impl};
use tokio::sync::mpsc::UnboundedSender;

use super::resample::LinearResampler;
use super::watchdog::CaptureFormat;
use super::{AudioSource, TARGET_SAMPLE_RATE};

// Property selectors / scopes (four-char codes). Defined locally because the tap
// selectors are newer than what coreaudio-sys exposes.
const K_AUDIO_TAP_PROPERTY_FORMAT: u32 = fourcc(b"tfmt");
const K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL: u32 = fourcc(b"glob");
const K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN: u32 = 0;
const K_AUDIO_DEVICE_PROPERTY_NOMINAL_SAMPLE_RATE: u32 = fourcc(b"nsrt");
const K_AUDIO_DEVICE_PROPERTY_STREAM_FORMAT: u32 = fourcc(b"sfmt");
const K_AUDIO_OBJECT_PROPERTY_SCOPE_INPUT: u32 = fourcc(b"inpt");

const fn fourcc(b: &[u8; 4]) -> u32 {
    ((b[0] as u32) << 24) | ((b[1] as u32) << 16) | ((b[2] as u32) << 8) | (b[3] as u32)
}

// Process-tap + aggregate-device functions from the CoreAudio framework, which
// is already linked via coreaudio-sys.
extern "C" {
    fn AudioHardwareCreateProcessTap(
        in_description: *mut Object,
        out_tap_id: *mut AudioObjectID,
    ) -> OSStatus;
    fn AudioHardwareDestroyProcessTap(in_tap_id: AudioObjectID) -> OSStatus;
    fn AudioHardwareCreateAggregateDevice(
        in_description: *const c_void, // CFDictionaryRef
        out_device_id: *mut AudioObjectID,
    ) -> OSStatus;
    fn AudioHardwareDestroyAggregateDevice(in_device_id: AudioObjectID) -> OSStatus;
}

/// Result of probing the process-tap TCC authorization (System Audio Recording).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TapAccess {
    Granted,
    Denied,
    /// CATapDescription unavailable — macOS < 14.2 can't capture system audio.
    Unsupported,
}

/// Probe whether Live Interview may capture system audio, without capturing: create a
/// global tap, try to read its stream format, tear it down. The very first call
/// while TCC is "not determined" makes macOS show the native "record system
/// audio" consent prompt (text from `NSAudioCaptureUsageDescription`) — so only
/// call this from an explicit user action (onboarding / the Permissions panel)
/// or when a meeting actually starts the tap.
pub fn probe_access() -> TapAccess {
    unsafe {
        let empty: *mut Object = msg_send![class!(NSArray), array];
        let desc: *mut Object = msg_send![class!(CATapDescription), alloc];
        if desc.is_null() {
            return TapAccess::Unsupported;
        }
        let desc: *mut Object = msg_send![desc, initStereoGlobalTapButExcludeProcesses: empty];
        let _: () = msg_send![desc, setPrivate: true];
        let mut tap_id: AudioObjectID = 0;
        let status = AudioHardwareCreateProcessTap(desc, &mut tap_id);
        if status != 0 || tap_id == 0 {
            let _: () = msg_send![desc, release];
            log::warn!("[system] probe: tap creation failed ({status}) — not authorized");
            return TapAccess::Denied;
        }
        // An unauthorized tap can exist but exposes no usable stream format.
        let access = if tap_sample_rate(tap_id).is_some() {
            TapAccess::Granted
        } else {
            TapAccess::Denied
        };
        AudioHardwareDestroyProcessTap(tap_id);
        let _: () = msg_send![desc, release];
        access
    }
}

/// System-audio capture ("them"). Holds an [`AppHandle`] so the capture thread
/// can surface "tap started but no audio is arriving" to the frontend.
pub struct SystemAudio {
    pub app: AppHandle,
    pub meeting_id: String,
}

impl AudioSource for SystemAudio {
    fn start(
        &self,
        tx: UnboundedSender<super::CapturedFrames>,
        running: Arc<AtomicBool>,
    ) -> Result<JoinHandle<()>> {
        let app = self.app.clone();
        let meeting = self.meeting_id.clone();
        let (verdict_tx, verdict_rx) = std::sync::mpsc::channel::<Result<()>>();
        let handle = std::thread::spawn(move || {
            if let Err(e) = run(tx, running, &app, &meeting, &verdict_tx) {
                let _ = verdict_tx.send(Err(anyhow!(e.to_string())));
                log::warn!("[system] tap capture unavailable, continuing mic-only: {e}");
                // Old macOS (< 14.2) simply has no tap API — the frontend shows
                // no toast for "unsupported" (nothing the user can grant).
                let code = if e.to_string().contains("CATapDescription") {
                    "system-audio-unsupported"
                } else {
                    "system-audio-unavailable"
                };
                crate::commands::report_capture_health(
                    &app,
                    &meeting,
                    "remote",
                    code,
                    Some(&e.to_string()),
                );
            }
        });
        // A slow consent/device operation remains owned and pending. Its eventual
        // readiness is reported by the worker; a timeout must not discard the lane.
        let _ = wait_for_startup(verdict_rx, Duration::from_secs(5))?;
        Ok(handle)
    }
}
#[derive(Debug, PartialEq)]
enum StartupReadiness {
    Ready,
    Pending,
}
fn wait_for_startup(
    verdict_rx: std::sync::mpsc::Receiver<Result<()>>,
    grace: Duration,
) -> Result<StartupReadiness> {
    match verdict_rx.recv_timeout(grace) {
        Ok(Ok(())) => Ok(StartupReadiness::Ready),
        Ok(Err(e)) => Err(e),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Ok(StartupReadiness::Pending),
        Err(_) => Err(anyhow!("systemAudioStartupFailed")),
    }
}
fn check_started(status: OSStatus, still_running: bool) -> Result<()> {
    if status != 0 {
        return Err(anyhow!("AudioDeviceStart failed: {status}"));
    }
    if !still_running {
        return Err(anyhow!("System audio startup completed after cancellation"));
    }
    Ok(())
}
#[cfg(test)]
mod startup_tests {
    use super::*;
    #[test]
    fn permission_or_device_startup_can_take_longer_than_one_and_a_half_seconds() {
        let (tx, rx) = std::sync::mpsc::channel();
        let ready = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1700));
            let _ = tx.send(Ok(()));
        });
        let result = wait_for_startup(rx, Duration::from_secs(5));
        ready.join().unwrap();
        assert!(result.is_ok());
    }
    #[test]
    fn unanswered_consent_remains_pending_not_failed_or_ready() {
        let (_tx, rx) = std::sync::mpsc::channel();
        assert_eq!(
            wait_for_startup(rx, Duration::from_millis(10)).unwrap(),
            StartupReadiness::Pending
        );
    }
    #[test]
    fn a_device_ready_after_its_owner_canceled_is_not_capture_ready() {
        assert!(check_started(0, false).is_err());
        assert!(check_started(0, true).is_ok());
        assert!(check_started(-50, true)
            .unwrap_err()
            .to_string()
            .contains("-50"));
    }
    #[test]
    fn aggregate_uses_the_output_device_as_its_clock() {
        let dictionary = aggregate_description("tap-uid", "output-uid");
        let master = dictionary
            .find(&CFString::new("master").as_CFType())
            .unwrap();
        assert_eq!(
            master.downcast::<CFString>().unwrap().to_string(),
            "output-uid"
        );
        let subdevices = dictionary
            .find(&CFString::new("subdevices").as_CFType())
            .unwrap();
        assert_eq!(
            unsafe {
                CFArray::<CFType>::wrap_under_get_rule(subdevices.as_CFTypeRef().cast()).len()
            },
            1
        );
        let autostart = dictionary
            .find(&CFString::new("tapautostart").as_CFType())
            .unwrap();
        assert_eq!(
            autostart.downcast::<CFBoolean>().unwrap(),
            CFBoolean::false_value()
        );
    }
    #[test]
    fn remote_input_uses_only_trailing_tap_buffers_not_hardware_microphones() {
        use coreaudio_sys::AudioBuffer;
        #[repr(C)]
        struct List {
            count: u32,
            buffers: [AudioBuffer; 3],
        }
        let mut hardware = [0.9f32, 0.9];
        let mut left = [0.1f32, 0.3];
        let mut right = [0.2f32, 0.4];
        let buffer = |data: &mut [f32]| AudioBuffer {
            mNumberChannels: 1,
            mDataByteSize: (data.len() * 4) as u32,
            mData: data.as_mut_ptr().cast(),
        };
        let list = List {
            count: 3,
            buffers: [buffer(&mut hardware), buffer(&mut left), buffer(&mut right)],
        };
        let mono = unsafe { tap_mono(&*(&list as *const List).cast::<AudioBufferList>(), 2) };
        assert_eq!(mono.len(), 2);
        assert!((mono[0] - 0.15).abs() < 0.0001);
        assert!((mono[1] - 0.35).abs() < 0.0001);
    }
}

/// State handed to the realtime IOProc. Lives (boxed) for the device's lifetime.
struct TapContext {
    tx: UnboundedSender<super::CapturedFrames>,
    resampler: LinearResampler,
    /// Frames delivered so far — read by the watchdog in `run` (separate Arc
    /// clone, so no aliasing with the IOProc's &mut TapContext).
    frames: Arc<AtomicU64>,
    tap_buffers: usize,
}

/// One running tap: the process tap, its private aggregate device and the IOProc feeding `tx`.
struct TapSession {
    desc: *mut Object,
    tap_id: AudioObjectID,
    agg_id: AudioObjectID,
    proc_id: AudioDeviceIOProcID,
    ctx_ptr: *mut c_void,
    /// The tap format and aggregate clock rate the resampler was built for.
    format: CaptureFormat,
}

impl TapSession {
    /// What the tap and its aggregate report now; `None` when the tap format is unreadable.
    unsafe fn observed_format(&self) -> Option<CaptureFormat> {
        tap_format(self.tap_id).map(|f| {
            CaptureFormat::new(f.mSampleRate, f.mChannelsPerFrame)
                .with_device_rate(nominal_sample_rate(self.agg_id))
        })
    }
}

impl TapSession {
    /// Stops the device and releases everything `open_tap` created, in reverse order.
    unsafe fn close(self) {
        AudioDeviceStop(self.agg_id, self.proc_id);
        AudioDeviceDestroyIOProcID(self.agg_id, self.proc_id);
        AudioHardwareDestroyAggregateDevice(self.agg_id);
        AudioHardwareDestroyProcessTap(self.tap_id);
        drop(Box::from_raw(self.ctx_ptr as *mut TapContext));
        let _: () = msg_send![self.desc, release];
    }
}

fn run(
    tx: UnboundedSender<super::CapturedFrames>,
    running: Arc<AtomicBool>,
    app: &AppHandle,
    meeting: &str,
    verdict: &std::sync::mpsc::Sender<Result<()>>,
) -> Result<()> {
    let frames = Arc::new(AtomicU64::new(0));
    unsafe {
        let (session, output_uid) = open_tap(tx.clone(), frames.clone(), &running, app, meeting)?;
        let _ = verdict.send(Ok(()));
        crate::commands::report_capture_health(app, meeting, "remote", "captureStarted", None);
        // Kick the tap awake. A global process tap only starts ticking once
        // SOME process renders audio; until then the tap-backed aggregate sits
        // dormant, and (observed on macOS 15) coreaudiod wedges the START of
        // the meeting's MIC stream behind the dormant device — nothing is
        // captured or transcribed until the first system sound (or until stop
        // tears the tap down, which is why transcripts appeared only after
        // ending the meeting; issue reproduced with `stream.play()` blocking
        // 34 s until a sound played, then returning within 150 ms of the tap's
        // first IOProc frame). Rendering ~300 ms of silence from our own
        // process gives the tap its first source; once ticking it keeps
        // ticking (delivering silence) for the life of the tap.
        std::thread::spawn(kick_system_output);

        // 6. Hold the device open until the meeting stops, rebuilding it when needed, then tear it down.
        let session = hold_until_stopped(&running, &frames, app, meeting, session, output_uid, &tx);
        if let Some(session) = session {
            session.close();
        }
    }
    Ok(())
}

/// Steps 1-5: create the tap, wrap it in an aggregate clocked by the current default output, install
/// the IOProc and start the device. Returns the session and the output device it is pinned to.
unsafe fn open_tap(
    tx: UnboundedSender<super::CapturedFrames>,
    frames: Arc<AtomicU64>,
    running: &AtomicBool,
    app: &AppHandle,
    meeting: &str,
) -> Result<(TapSession, String)> {
    let output_uid = default_output_uid()?;
    // 1. Describe a global stereo tap of all system output.
    crate::commands::report_capture_health(
        app,
        meeting,
        "remote",
        "captureStarting",
        Some("Requesting system-audio access"),
    );
    let empty: *mut Object = msg_send![class!(NSArray), array];
    let desc: *mut Object = msg_send![class!(CATapDescription), alloc];
    if desc.is_null() {
        return Err(anyhow!("CATapDescription unavailable (needs macOS 14.2+)"));
    }
    let desc: *mut Object = msg_send![desc, initStereoGlobalTapButExcludeProcesses: empty];

    // 2. Create the process tap and read its UUID (used as the sub-tap UID).
    let _: () = msg_send![desc, setPrivate: true];
    let mut tap_id: AudioObjectID = 0;
    let status = AudioHardwareCreateProcessTap(desc, &mut tap_id);
    if status != 0 || tap_id == 0 {
        let _: () = msg_send![desc, release];
        return Err(anyhow!("AudioHardwareCreateProcessTap failed: {status}"));
    }
    let uid = tap_uuid_string(desc);

    // 3. Wrap the tap in a private aggregate device we can run an IOProc on.
    let agg_desc = aggregate_description(&uid, &output_uid);
    crate::commands::report_capture_health(
        app,
        meeting,
        "remote",
        "captureStarting",
        Some("Creating the CoreAudio aggregate device"),
    );

    let mut agg_id: AudioObjectID = 0;
    let status = AudioHardwareCreateAggregateDevice(
        agg_desc.as_concrete_TypeRef() as *const c_void,
        &mut agg_id,
    );
    if status != 0 || agg_id == 0 {
        AudioHardwareDestroyProcessTap(tap_id);
        let _: () = msg_send![desc, release];
        return Err(anyhow!(
            "AudioHardwareCreateAggregateDevice failed: {status}"
        ));
    }

    // An unknown tap format cannot safely distinguish tap buffers from hardware inputs.
    let format = match tap_format(tap_id) {
        Some(format) => format,
        None => {
            AudioHardwareDestroyAggregateDevice(agg_id);
            AudioHardwareDestroyProcessTap(tap_id);
            let _: () = msg_send![desc, release];
            return Err(anyhow!("System audio has no supported float32 tap format"));
        }
    };
    let in_rate = format.mSampleRate;
    log::info!("[system] tap @ {in_rate} Hz → {TARGET_SAMPLE_RATE} Hz mono");

    // 5. Install + start the IOProc.
    let ctx = Box::new(TapContext {
        tx,
        resampler: LinearResampler::new(in_rate as u32, TARGET_SAMPLE_RATE),
        frames,
        tap_buffers: if format.mFormatFlags & 32 != 0 {
            format.mChannelsPerFrame as usize
        } else {
            1
        },
    });
    let ctx_ptr = Box::into_raw(ctx) as *mut c_void;

    let mut proc_id: AudioDeviceIOProcID = None;
    crate::commands::report_capture_health(
        app,
        meeting,
        "remote",
        "captureStarting",
        Some("Registering the CoreAudio callback"),
    );
    let status = AudioDeviceCreateIOProcID(agg_id, Some(io_proc), ctx_ptr, &mut proc_id);
    if status != 0 || proc_id.is_none() {
        drop(Box::from_raw(ctx_ptr as *mut TapContext));
        AudioHardwareDestroyAggregateDevice(agg_id);
        AudioHardwareDestroyProcessTap(tap_id);
        let _: () = msg_send![desc, release];
        return Err(anyhow!("AudioDeviceCreateIOProcID failed: {status}"));
    }
    crate::commands::report_capture_health(
        app,
        meeting,
        "remote",
        "captureStarting",
        Some("Starting the CoreAudio device"),
    );
    let started = AudioDeviceStart(agg_id, proc_id);
    if let Err(error) = check_started(started, running.load(Ordering::SeqCst)) {
        if started == 0 {
            AudioDeviceStop(agg_id, proc_id);
        }
        AudioDeviceDestroyIOProcID(agg_id, proc_id);
        AudioHardwareDestroyAggregateDevice(agg_id);
        AudioHardwareDestroyProcessTap(tap_id);
        drop(Box::from_raw(ctx_ptr as *mut TapContext));
        let _: () = msg_send![desc, release];
        return Err(error);
    }
    Ok((
        TapSession {
            desc,
            tap_id,
            agg_id,
            proc_id,
            ctx_ptr,
            format: CaptureFormat::new(format.mSampleRate, format.mChannelsPerFrame)
                .with_device_rate(nominal_sample_rate(agg_id)),
        },
        output_uid,
    ))
}

/// Describe the private aggregate device that wraps the process tap `uid`, in
/// the CFDictionary shape `AudioHardwareCreateAggregateDevice` expects.
fn aggregate_description(uid: &str, output_uid: &str) -> CFDictionary<CFType, CFType> {
    let sub_tap = CFDictionary::from_CFType_pairs(&[
        (
            CFString::new("uid").as_CFType(),
            CFString::new(uid).as_CFType(),
        ),
        (
            CFString::new("drift").as_CFType(),
            CFBoolean::true_value().as_CFType(),
        ),
    ]);
    let tap_list = CFArray::from_CFTypes(&[sub_tap]);
    let output = CFDictionary::from_CFType_pairs(&[(
        CFString::new("uid").as_CFType(),
        CFString::new(output_uid).as_CFType(),
    )]);
    let output_list = CFArray::from_CFTypes(&[output]);
    CFDictionary::from_CFType_pairs(&[
        (
            CFString::new("name").as_CFType(),
            CFString::new("Live Interview System Tap").as_CFType(),
        ),
        (
            CFString::new("uid").as_CFType(),
            CFString::new(&format!("com.karim.liveinterview.agg.{uid}")).as_CFType(),
        ),
        (
            CFString::new("private").as_CFType(),
            CFBoolean::true_value().as_CFType(),
        ),
        (
            CFString::new("stacked").as_CFType(),
            CFBoolean::false_value().as_CFType(),
        ),
        (CFString::new("taps").as_CFType(), tap_list.as_CFType()),
        (
            CFString::new("master").as_CFType(),
            CFString::new(output_uid).as_CFType(),
        ),
        (
            CFString::new("subdevices").as_CFType(),
            output_list.as_CFType(),
        ),
        (
            CFString::new("tapautostart").as_CFType(),
            CFBoolean::false_value().as_CFType(),
        ),
    ])
}

/// Park until the meeting stops, running the delivery watchdog once on the way:
/// an unauthorized tap "starts" fine but its IOProc never fires — detect that
/// (zero frames a few seconds in) and tell the UI, so a permission problem
/// doesn't just look like a silent remote party.
///
/// While parked, the tap is rebuilt when frames stop after flowing (sleep/wake, a driver reset) or the
/// default output changes (the aggregate is clocked by the output chosen at start, so a switch to
/// headphones can silence it). Returns the session that is still open, if any.
unsafe fn hold_until_stopped(
    running: &AtomicBool,
    frames: &Arc<AtomicU64>,
    app: &AppHandle,
    meeting: &str,
    session: TapSession,
    output_uid: String,
    tx: &UnboundedSender<super::CapturedFrames>,
) -> Option<TapSession> {
    use super::watchdog::{RebuildReason, StreamWatch, WatchAction, TICK};
    let started_at = Instant::now();
    let mut checked = false;
    let mut delivered = false;
    let mut watch = StreamWatch::new(Some(output_uid), true, started_at).with_format(Some(session.format));
    let mut session = Some(session);
    let mut last_tick = started_at;
    while running.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(100));
        let count = frames.load(Ordering::Relaxed);
        if !delivered && count > 0 {
            delivered = true;
            report_tap_delivery(count, app, meeting);
            crate::commands::report_capture_health(app, meeting, "remote", "captureStarted", None);
        }
        if !checked && !delivered && started_at.elapsed() >= Duration::from_secs(3) {
            checked = true;
            report_tap_delivery(frames.load(Ordering::Relaxed), app, meeting);
        }
        if last_tick.elapsed() < TICK {
            continue;
        }
        let now = Instant::now();
        last_tick = now;
        let current = default_output_uid().ok();
        // AirPods switching to the hands-free profile keep their UID but change the aggregate's clock
        // rate; the resampler ratio is fixed per session, so a changed rate means a new session.
        let observed = session.as_ref().and_then(|open| open.observed_format());
        let action = watch.observe_format(now, count, current.as_deref(), false, observed);
        if watch.take_format_suspension() {
            log::warn!("[system] the tap format keeps changing; no more format rebuilds for this meeting, recording continues");
        }
        let WatchAction::Rebuild(reason) = action else {
            continue;
        };
        log::warn!("[system] rebuilding the tap: {reason:?}");
        let code = if reason == RebuildReason::Stalled { "captureStalled" } else { "captureInterrupted" };
        crate::commands::report_capture_health(app, meeting, "remote", code, Some(reason.detail()));
        if let Some(open) = session.take() {
            open.close();
        }
        match open_tap(tx.clone(), frames.clone(), running, app, meeting) {
            Ok((reopened, uid)) => {
                log::info!("[system] tap reopened as {:?}", reopened.format);
                watch.rebuilt_with_format(now, Some(uid), Some(reopened.format), true);
                session = Some(reopened);
                std::thread::spawn(kick_system_output);
                crate::commands::report_capture_health(app, meeting, "remote", "captureRecovered", None);
            }
            Err(error) => {
                log::warn!("[system] tap rebuild failed, will retry: {error}");
                watch.rebuilt(now, None, false);
            }
        }
    }
    session
}

/// Turn the watchdog's frame count into either a permission warning for the UI
/// or a note that the System Audio Recording grant is confirmed working.
fn report_tap_delivery(frames: u64, app: &AppHandle, meeting: &str) {
    if frames > 0 {
        crate::permissions::note_system_audio_granted();
        return;
    }
    log::warn!(
        "[system] tap delivered no frames in 3s — grant \"System Audio \
         Recording\" (Settings → Permissions) and restart the meeting"
    );
    crate::commands::report_capture_health(
        app,
        meeting,
        "remote",
        "system-audio-silent",
        Some("No system-audio frames arrived after device startup"),
    );
}

/// Realtime callback: downmix the tapped interleaved float frames to mono,
/// resample to 16 kHz, and forward as i16 PCM. Runs on a CoreAudio thread.
unsafe extern "C" fn io_proc(
    _device: AudioObjectID,
    _now: *const AudioTimeStamp,
    in_input: *const AudioBufferList,
    _in_time: *const AudioTimeStamp,
    _out_data: *mut AudioBufferList,
    _out_time: *const AudioTimeStamp,
    client: *mut c_void,
) -> OSStatus {
    if client.is_null() || in_input.is_null() {
        return 0;
    }
    let ctx = &mut *(client as *mut TapContext);
    let list = &*in_input;
    if list.mNumberBuffers == 0 {
        return 0;
    }
    let mono = tap_mono(list, ctx.tap_buffers);
    ctx.frames.fetch_add(mono.len() as u64, Ordering::Relaxed);
    // The physical output supplies the clock; this recorder contributes silence.
    if !_out_data.is_null() {
        let output = &mut *_out_data;
        let buffers = std::slice::from_raw_parts_mut(
            output.mBuffers.as_mut_ptr(),
            output.mNumberBuffers as usize,
        );
        for buffer in buffers {
            if !buffer.mData.is_null() {
                std::ptr::write_bytes(buffer.mData.cast::<u8>(), 0, buffer.mDataByteSize as usize);
            }
        }
    }
    let mut out = Vec::new();
    ctx.resampler.process(&mono, &mut out);
    if !out.is_empty() {
        let _ = ctx.tx.send(super::CapturedFrames::now(out));
    }
    0
}

/// Hardware inputs precede tap inputs on a duplex aggregate. Never label them remote.
unsafe fn tap_mono(list: &AudioBufferList, tap_buffers: usize) -> Vec<f32> {
    let count = list.mNumberBuffers as usize;
    if tap_buffers == 0 || count < tap_buffers {
        return vec![];
    }
    let buffers = std::slice::from_raw_parts(list.mBuffers.as_ptr(), count);
    let taps = &buffers[count - tap_buffers..];
    if taps
        .iter()
        .any(|b| b.mData.is_null() || b.mNumberChannels == 0)
    {
        return vec![];
    }
    let frames = taps
        .iter()
        .map(|b| b.mDataByteSize as usize / 4 / b.mNumberChannels as usize)
        .min()
        .unwrap_or(0);
    let channels = taps
        .iter()
        .map(|b| b.mNumberChannels as usize)
        .sum::<usize>();
    (0..frames)
        .map(|frame| {
            let mut sum = 0f32;
            for b in taps {
                let samples =
                    std::slice::from_raw_parts(b.mData.cast::<f32>(), b.mDataByteSize as usize / 4);
                for channel in 0..b.mNumberChannels as usize {
                    sum += samples[frame * b.mNumberChannels as usize + channel];
                }
            }
            sum / channels as f32
        })
        .collect()
}
unsafe fn default_output_uid() -> Result<String> {
    let address = AudioObjectPropertyAddress {
        mSelector: fourcc(b"dOut"),
        mScope: K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL,
        mElement: 0,
    };
    let mut id = 0u32;
    let mut size = 4u32;
    let status = AudioObjectGetPropertyData(
        1,
        &address,
        0,
        std::ptr::null(),
        &mut size,
        (&mut id as *mut u32).cast(),
    );
    if status != 0 || id == 0 {
        return Err(anyhow!("Default output device unavailable: {status}"));
    }
    let address = AudioObjectPropertyAddress {
        mSelector: fourcc(b"uid "),
        ..address
    };
    let mut uid: core_foundation::string::CFStringRef = std::ptr::null();
    let mut size = std::mem::size_of_val(&uid) as u32;
    let status = AudioObjectGetPropertyData(
        id,
        &address,
        0,
        std::ptr::null(),
        &mut size,
        (&mut uid as *mut core_foundation::string::CFStringRef).cast(),
    );
    if status != 0 || uid.is_null() {
        return Err(anyhow!("Output clock identifier unavailable: {status}"));
    }
    Ok(CFString::wrap_under_create_rule(uid).to_string())
}
/// Read the tap's UUID string via the CATapDescription ObjC object.
unsafe fn tap_uuid_string(desc: *mut Object) -> String {
    let uuid: *mut Object = msg_send![desc, UUID];
    if uuid.is_null() {
        return String::new();
    }
    let uuid_str: *mut Object = msg_send![uuid, UUIDString];
    let cstr: *const c_char = msg_send![uuid_str, UTF8String];
    if cstr.is_null() {
        return String::new();
    }
    CStr::from_ptr(cstr).to_string_lossy().into_owned()
}

/// Render ~300 ms of silence on the default output device so the process tap
/// has a source and starts ticking (see the call site in [`run`]). Failures are
/// logged and otherwise ignored — the tap then simply stays dormant until the
/// first real system sound, which is the pre-kick behavior.
fn kick_system_output() {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    let Some(dev) = cpal::default_host().default_output_device() else {
        log::warn!("[system] tap kick: no default output device");
        return;
    };
    let Ok(cfg) = dev.default_output_config() else {
        log::warn!("[system] tap kick: no default output config");
        return;
    };
    if cfg.sample_format() != cpal::SampleFormat::F32 {
        log::warn!(
            "[system] tap kick: unexpected output format {:?}; skipping",
            cfg.sample_format()
        );
        return;
    }
    let cfg: cpal::StreamConfig = cfg.into();
    match dev.build_output_stream(
        &cfg,
        |data: &mut [f32], _| data.fill(0.0),
        |e| log::warn!("[system] tap kick stream error: {e}"),
        None,
    ) {
        Ok(stream) => {
            let _ = stream.play();
            std::thread::sleep(Duration::from_millis(300));
            drop(stream);
        }
        Err(e) => log::warn!("[system] tap kick: output stream failed: {e}"),
    }
}

/// A device's nominal sample rate (`kAudioDevicePropertyNominalSampleRate`), if readable.
unsafe fn nominal_sample_rate(device: AudioObjectID) -> Option<f64> {
    let address = AudioObjectPropertyAddress {
        mSelector: K_AUDIO_DEVICE_PROPERTY_NOMINAL_SAMPLE_RATE,
        mScope: K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL,
        mElement: K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
    };
    let mut rate = 0f64;
    let mut size = std::mem::size_of::<f64>() as u32;
    let status = AudioObjectGetPropertyData(
        device,
        &address,
        0,
        std::ptr::null(),
        &mut size,
        (&mut rate as *mut f64).cast(),
    );
    (status == 0 && rate.is_finite() && rate > 0.0).then_some(rate)
}

/// Find an input-capable CoreAudio device by the name cpal reports (`None` or empty: the default input).
unsafe fn input_device_id(name: Option<&str>) -> Option<AudioObjectID> {
    let global = |selector: &[u8; 4]| AudioObjectPropertyAddress {
        mSelector: fourcc(selector),
        mScope: K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL,
        mElement: K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
    };
    let Some(want) = name.filter(|n| !n.is_empty()) else {
        let mut id = 0u32;
        let mut size = 4u32;
        let status = AudioObjectGetPropertyData(1, &global(b"dIn "), 0, std::ptr::null(), &mut size, (&mut id as *mut u32).cast());
        return (status == 0 && id != 0).then_some(id);
    };
    let devices = global(b"dev#");
    let mut size = 0u32;
    if AudioObjectGetPropertyDataSize(1, &devices, 0, std::ptr::null(), &mut size) != 0 {
        return None;
    }
    let mut ids = vec![0u32; size as usize / 4];
    if AudioObjectGetPropertyData(1, &devices, 0, std::ptr::null(), &mut size, ids.as_mut_ptr().cast()) != 0 {
        return None;
    }
    ids.into_iter().find(|&id| {
        let mut cf: core_foundation::string::CFStringRef = std::ptr::null();
        let mut size = std::mem::size_of_val(&cf) as u32;
        let status = AudioObjectGetPropertyData(id, &global(b"lnam"), 0, std::ptr::null(), &mut size, (&mut cf as *mut core_foundation::string::CFStringRef).cast());
        status == 0 && !cf.is_null() && CFString::wrap_under_create_rule(cf).to_string() == want
            && input_stream_format(id).is_some()
    })
}

unsafe fn input_stream_format(device: AudioObjectID) -> Option<AudioStreamBasicDescription> {
    let mut asbd = std::mem::zeroed::<AudioStreamBasicDescription>();
    let mut size = std::mem::size_of::<AudioStreamBasicDescription>() as u32;
    let address = AudioObjectPropertyAddress {
        mSelector: K_AUDIO_DEVICE_PROPERTY_STREAM_FORMAT,
        mScope: K_AUDIO_OBJECT_PROPERTY_SCOPE_INPUT,
        mElement: K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
    };
    let status = AudioObjectGetPropertyData(device, &address, 0, std::ptr::null(), &mut size, (&mut asbd as *mut AudioStreamBasicDescription).cast());
    (status == 0 && asbd.mSampleRate.is_finite() && asbd.mSampleRate > 0.0 && asbd.mChannelsPerFrame > 0).then_some(asbd)
}

/// The current input format of the microphone device cpal would open for `name`: the input stream
/// format cpal builds its config from, plus the device's nominal rate. Read with plain property calls
/// (no AudioUnit), so the capture thread can check it every watchdog tick.
pub fn input_device_format(name: Option<&str>) -> Option<CaptureFormat> {
    unsafe { device_format(input_device_id(name)?) }
}

unsafe fn device_format(id: AudioObjectID) -> Option<CaptureFormat> {
    let format = input_stream_format(id)?;
    Some(CaptureFormat::new(format.mSampleRate, format.mChannelsPerFrame).with_device_rate(nominal_sample_rate(id)))
}

/// The persistent UID of the input device cpal opened for `name` (`None`: the default input). Resolved once
/// when the stream opens, so the per-tick format check follows that exact device even when another device
/// shares its name.
pub fn input_device_uid(name: Option<&str>) -> Option<String> {
    unsafe {
        let id = input_device_id(name)?;
        let address = AudioObjectPropertyAddress {
            mSelector: fourcc(b"uid "),
            mScope: K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL,
            mElement: K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
        };
        let mut uid: core_foundation::string::CFStringRef = std::ptr::null();
        let mut size = std::mem::size_of_val(&uid) as u32;
        let status = AudioObjectGetPropertyData(id, &address, 0, std::ptr::null(), &mut size, (&mut uid as *mut core_foundation::string::CFStringRef).cast());
        (status == 0 && !uid.is_null()).then(|| CFString::wrap_under_create_rule(uid).to_string())
    }
}

/// The current input format of the device with this UID (`kAudioHardwarePropertyTranslateUIDToDevice`).
pub fn input_format_by_uid(uid: &str) -> Option<CaptureFormat> {
    unsafe {
        let address = AudioObjectPropertyAddress {
            mSelector: fourcc(b"uidd"),
            mScope: K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL,
            mElement: K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
        };
        let qualifier = CFString::new(uid);
        let reference = qualifier.as_concrete_TypeRef();
        let mut id = 0u32;
        let mut size = 4u32;
        let status = AudioObjectGetPropertyData(
            1,
            &address,
            std::mem::size_of_val(&reference) as u32,
            (&reference as *const core_foundation::string::CFStringRef).cast(),
            &mut size,
            (&mut id as *mut u32).cast(),
        );
        if status != 0 || id == 0 {
            return None;
        }
        device_format(id)
    }
}

/// Query the tapped stream's sample rate.
unsafe fn tap_sample_rate(tap_id: AudioObjectID) -> Option<f64> {
    tap_format(tap_id).map(|f| f.mSampleRate)
}
unsafe fn tap_format(tap_id: AudioObjectID) -> Option<AudioStreamBasicDescription> {
    let mut asbd = std::mem::zeroed::<AudioStreamBasicDescription>();
    let mut size = std::mem::size_of::<AudioStreamBasicDescription>() as u32;
    let addr = AudioObjectPropertyAddress {
        mSelector: K_AUDIO_TAP_PROPERTY_FORMAT,
        mScope: K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL,
        mElement: K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
    };
    let status = AudioObjectGetPropertyData(
        tap_id,
        &addr,
        0,
        std::ptr::null(),
        &mut size,
        &mut asbd as *mut _ as *mut c_void,
    );
    if status == 0
        && asbd.mSampleRate.is_finite()
        && asbd.mSampleRate >= 8000.0
        && asbd.mSampleRate <= 192000.0
        && asbd.mBitsPerChannel == 32
        && asbd.mFormatFlags & 1 != 0
        && asbd.mChannelsPerFrame > 0
    {
        Some(asbd)
    } else {
        None
    }
}
