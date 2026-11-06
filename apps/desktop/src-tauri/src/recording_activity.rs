//! Keeps the Mac from idle-sleeping while a meeting records and finalizes (N7). The display may still sleep.
//! Released when the last holder drops it, so every exit path (stop, failed start, panic) ends it.

// The `objc` 0.2 macros emit `cfg(cargo-clippy)` checks the modern compiler flags.
#![allow(unexpected_cfgs)]
#[cfg(target_os = "macos")]
use objc::runtime::Object;
#[cfg(target_os = "macos")]
use objc::{class, msg_send, sel, sel_impl};

/// `NSActivityUserInitiated | NSActivityIdleSystemSleepDisabled` from Foundation's NSProcessInfo.h.
#[cfg(target_os = "macos")]
const ACTIVITY_OPTIONS: u64 = 0x00FF_FFFF | (1 << 20);

pub struct RecordingActivity {
    #[cfg(target_os = "macos")]
    token: *mut Object,
}
// SAFETY: the token is an immutable, retained Foundation object that is never mutated after `begin`, and
// `endActivity:` (called once, from `Drop`) may be called from any thread.
unsafe impl Send for RecordingActivity {}
unsafe impl Sync for RecordingActivity {}

impl RecordingActivity {
    pub fn begin(reason: &str) -> Self {
        #[cfg(target_os = "macos")]
        {
            let reason = std::ffi::CString::new(reason).unwrap_or_default();
            let token = objc::rc::autoreleasepool(|| unsafe {
                let info: *mut Object = msg_send![class!(NSProcessInfo), processInfo];
                let reason: *mut Object = msg_send![class!(NSString), stringWithUTF8String: reason.as_ptr()];
                let token: *mut Object =
                    msg_send![info, beginActivityWithOptions: ACTIVITY_OPTIONS reason: reason];
                // The returned token is autoreleased; keep it until `drop`.
                if !token.is_null() {
                    let _: *mut Object = msg_send![token, retain];
                }
                token
            });
            if token.is_null() {
                log::warn!("[recording] could not hold the Mac awake for this recording");
            }
            Self { token }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = reason;
            Self {}
        }
    }
}

impl Drop for RecordingActivity {
    fn drop(&mut self) {
        #[cfg(target_os = "macos")]
        if !self.token.is_null() {
            objc::rc::autoreleasepool(|| unsafe {
                let info: *mut Object = msg_send![class!(NSProcessInfo), processInfo];
                let _: () = msg_send![info, endActivity: self.token];
                let _: () = msg_send![self.token, release];
            });
        }
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    fn assertions() -> String {
        let output = std::process::Command::new("/usr/bin/pmset")
            .args(["-g", "assertions"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&output.stdout).into_owned()
    }
    // The activity shows as an idle-sleep assertion with our reason while held, and is gone once dropped.
    #[test]
    fn the_activity_prevents_idle_sleep_until_dropped() {
        let reason = format!("Live Interview test {}", uuid::Uuid::new_v4());
        let activity = RecordingActivity::begin(&reason);
        let held = assertions();
        let line = held.lines().find(|line| line.contains(&reason));
        assert!(line.is_some_and(|line| line.contains("PreventUserIdleSystemSleep")), "{held}");
        drop(activity);
        assert!(!assertions().contains(&reason));
    }
}
