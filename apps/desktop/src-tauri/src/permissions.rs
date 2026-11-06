//! First-run audio permission status and explicit, user-initiated requests.
//! Nothing here runs on its own: macOS prompts appear only when the user presses the
//! matching button in the onboarding checklist. Recording never depends on these calls.

// The `objc` 0.2 macros emit `cfg(cargo-clippy)` checks the modern compiler flags.
#![allow(unexpected_cfgs)]

#[cfg(target_os = "macos")]
use crate::audio::system_macos::TapAccess;

pub fn note_system_audio_granted() {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    Granted,
    Denied,
    NotDetermined,
    Restricted,
    Unsupported,
}

impl Access {
    /// The strings `parseAccess` matches in `lib/public/onboarding.ts`.
    pub fn code(self) -> &'static str {
        match self {
            Access::Granted => "granted",
            Access::Denied => "denied",
            Access::NotDetermined => "notDetermined",
            Access::Restricted => "restricted",
            Access::Unsupported => "unsupported",
        }
    }
}

/// `AVAuthorizationStatus`: 0 notDetermined, 1 restricted, 2 denied, 3 authorized.
/// Anything unrecognised is treated as denied, never as granted.
pub fn microphone_access_from_status(raw: i64) -> Access {
    match raw {
        0 => Access::NotDetermined,
        1 => Access::Restricted,
        3 => Access::Granted,
        _ => Access::Denied,
    }
}

/// `TCCAccessPreflight` results: 0 authorized, 1 denied, 2 not determined. Any other value is
/// unknown and is never guessed into an answer.
pub fn system_audio_access_from_preflight(raw: i64) -> Option<Access> {
    match raw {
        0 => Some(Access::Granted),
        1 => Some(Access::Denied),
        2 => Some(Access::NotDetermined),
        _ => None,
    }
}

/// Non-prompting system-audio status. `tap_available` is false below macOS 14.2, where nothing can be
/// granted. `preflight` reads the TCC database and returns `None` when it cannot. `None` means
/// "could not tell"; the caller keeps whatever it already knew and never shows a guess.
pub fn system_audio_status(
    tap_available: bool,
    preflight: impl FnOnce() -> Option<i64>,
) -> Option<Access> {
    if !tap_available {
        return Some(Access::Unsupported);
    }
    preflight().and_then(system_audio_access_from_preflight)
}

/// `AXIsProcessTrusted` answers only yes or no. "No" covers both never asked and turned off, so it is
/// reported as not determined; the setup step tells the two apart by whether the person already asked.
pub fn accessibility_access_from_trusted(trusted: bool) -> Access {
    if trusted {
        Access::Granted
    } else {
        Access::NotDetermined
    }
}

/// Only the two audio panes, the Accessibility pane and the Calendars pane can be opened; the pane name
/// comes from the webview.
pub fn privacy_pane_url(pane: &str) -> Option<&'static str> {
    match pane {
        "accessibility" => Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"),
        "calendars" => Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars"),
        "microphone" => Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"),
        "systemAudio" => Some("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
pub fn system_audio_access_from_probe(probe: TapAccess) -> Access {
    match probe {
        TapAccess::Granted => Access::Granted,
        TapAccess::Denied => Access::Denied,
        TapAccess::Unsupported => Access::Unsupported,
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{microphone_access_from_status, Access};
    use block::ConcreteBlock;
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::string::{CFString, CFStringRef};
    use objc::runtime::{Object, BOOL, YES};
    use objc::{class, msg_send, sel, sel_impl};
    use std::os::raw::{c_char, c_void};
    use std::sync::Mutex;

    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {}

    /// `AVMediaTypeAudio` is the string constant "soun".
    unsafe fn audio_media_type() -> *mut Object {
        msg_send![class!(NSString), stringWithUTF8String: b"soun\0".as_ptr() as *const c_char]
    }

    /// Reads the current status; never prompts.
    pub fn microphone_access() -> Access {
        unsafe {
            let status: isize =
                msg_send![class!(AVCaptureDevice), authorizationStatusForMediaType: audio_media_type()];
            microphone_access_from_status(status as i64)
        }
    }

    /// macOS has no public status call for the System Audio Recording grant: `CGPreflightScreenCaptureAccess`
    /// answers for Screen Recording, a different permission. This reads the same TCC record without
    /// prompting through the private `TCCAccessPreflight`, looked up at run time so a missing symbol
    /// degrades to "could not tell" instead of failing to launch.
    pub fn system_audio_preflight() -> Option<i64> {
        // The C function returns a 32-bit enum; reading it as 64 bits would include unspecified register bits.
        type Preflight = unsafe extern "C" fn(CFStringRef, *const c_void) -> i32;
        unsafe {
            let tcc = libc::dlopen(
                b"/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC\0".as_ptr() as *const c_char,
                libc::RTLD_NOW,
            );
            if tcc.is_null() {
                return None;
            }
            let symbol = libc::dlsym(tcc, b"TCCAccessPreflight\0".as_ptr() as *const c_char);
            if symbol.is_null() {
                return None;
            }
            let preflight: Preflight = std::mem::transmute(symbol);
            let service = CFString::new("kTCCServiceAudioCapture");
            Some(i64::from(preflight(service.as_concrete_TypeRef(), std::ptr::null())))
        }
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
        static kAXTrustedCheckOptionPrompt: CFStringRef;
    }

    /// Reads whether this app is allowed under Privacy & Security > Accessibility; never prompts.
    pub fn accessibility_trusted() -> bool {
        unsafe { AXIsProcessTrusted() }
    }

    /// Asks macOS to show its Accessibility prompt, which offers to open System Settings. It returns at
    /// once with the current answer; a grant made afterwards is picked up by the status re-check.
    pub fn request_accessibility() -> bool {
        unsafe {
            let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
            let options =
                CFDictionary::from_CFType_pairs(&[(key.as_CFType(), CFBoolean::true_value().as_CFType())]);
            AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef())
        }
    }

    /// `CATapDescription` exists from macOS 14.2; the check does not create a tap.
    pub fn system_audio_tap_available() -> bool {
        objc::runtime::Class::get("CATapDescription").is_some()
    }

    /// Shows the macOS microphone prompt when the status is not determined. `done` runs once on an
    /// arbitrary queue after the user answers.
    pub fn request_microphone(done: impl FnOnce(bool) + Send + 'static) {
        let done = Mutex::new(Some(done));
        let block = ConcreteBlock::new(move |granted: BOOL| {
            if let Some(done) = done.lock().ok().and_then(|mut slot| slot.take()) {
                done(granted == YES);
            }
        })
        .copy();
        unsafe {
            let _: () = msg_send![class!(AVCaptureDevice), requestAccessForMediaType: audio_media_type() completionHandler: &*block];
        }
    }
}

/// The setup audio check opens the microphone only once access is granted, so it can never raise a prompt.
pub(crate) fn microphone_granted() -> bool {
    #[cfg(target_os = "macos")]
    return mac::microphone_access() == Access::Granted;
    #[cfg(not(target_os = "macos"))]
    return false;
}

/// Read (never prompted) at every recording start: `Some(code)` when macOS reports microphone access as
/// denied or restricted, in which case the lane receives only silence. Recording continues either way.
pub(crate) fn microphone_denied_now() -> Option<&'static str> {
    #[cfg(target_os = "macos")]
    return match mac::microphone_access() {
        access @ (Access::Denied | Access::Restricted) => Some(access.code()),
        _ => None,
    };
    #[cfg(not(target_os = "macos"))]
    return None;
}

/// The setup audio check may start the system-audio tap whenever macOS has the tap API. The status read is not a
/// usable gate for it: in a packaged build on macOS 26 the access check (a created tap) reported granted while this
/// read did not, so the check refused to run at all. Hearing the test sound is the proof either way, and starting
/// it always follows an explicit button press, like the access check itself.
pub(crate) fn system_audio_checkable() -> bool {
    #[cfg(target_os = "macos")]
    return mac::system_audio_tap_available();
    #[cfg(not(target_os = "macos"))]
    return false;
}

#[tauri::command]
pub fn microphone_access_status() -> String {
    #[cfg(target_os = "macos")]
    return mac::microphone_access().code().into();
    #[cfg(not(target_os = "macos"))]
    return Access::Unsupported.code().into();
}

/// Reads the System Audio Recording status without prompting, so it is safe at launch, on focus and
/// during a meeting. Returns `unchecked` when macOS cannot tell, and the caller keeps what it knew.
#[tauri::command]
pub fn system_audio_access_status() -> String {
    #[cfg(target_os = "macos")]
    return system_audio_status(mac::system_audio_tap_available(), mac::system_audio_preflight)
        .map_or("unchecked", Access::code)
        .into();
    #[cfg(not(target_os = "macos"))]
    return Access::Unsupported.code().into();
}

/// Reads the Accessibility status Teams call detection needs, without prompting, so it is safe at
/// launch, on focus and during a meeting.
#[tauri::command]
pub fn accessibility_access_status() -> String {
    #[cfg(target_os = "macos")]
    return accessibility_access_from_trusted(mac::accessibility_trusted()).code().into();
    #[cfg(not(target_os = "macos"))]
    return Access::Unsupported.code().into();
}

/// Shows the macOS Accessibility prompt while access is off. Called only from an explicit button.
/// Recording never depends on the answer: without it, meetings are started by hand.
#[tauri::command]
pub fn request_accessibility_access() -> String {
    #[cfg(target_os = "macos")]
    return accessibility_access_from_trusted(mac::accessibility_trusted() || mac::request_accessibility())
        .code()
        .into();
    #[cfg(not(target_os = "macos"))]
    return Access::Unsupported.code().into();
}

/// Prompts only when the status is not determined; otherwise returns the current status unchanged.
#[tauri::command]
pub async fn request_microphone_access() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        if mac::microphone_access() == Access::NotDetermined {
            let (tx, rx) = tokio::sync::oneshot::channel();
            mac::request_microphone(move |granted| {
                let _ = tx.send(granted);
            });
            // An unanswered prompt stays pending; report whatever the status is afterwards.
            let _ = tokio::time::timeout(std::time::Duration::from_secs(300), rx).await;
        }
        Ok(mac::microphone_access().code().into())
    }
    #[cfg(not(target_os = "macos"))]
    Ok(Access::Unsupported.code().into())
}

/// Creates and immediately destroys a global process tap. The first call while macOS has not
/// decided shows the system-audio prompt, so the UI calls it only from an explicit button. It is
/// refused during a meeting so it cannot disturb a running capture.
#[tauri::command]
pub async fn check_system_audio_access(
    meeting: tauri::State<'_, crate::commands::MeetingController>,
) -> Result<String, String> {
    if meeting.is_active() {
        return Err("meetingActive".into());
    }
    #[cfg(target_os = "macos")]
    {
        let probe = tokio::task::spawn_blocking(crate::audio::system_macos::probe_access)
            .await
            .map_err(|_| "probeFailed".to_string())?;
        Ok(system_audio_access_from_probe(probe).code().into())
    }
    #[cfg(not(target_os = "macos"))]
    Ok(Access::Unsupported.code().into())
}

#[tauri::command]
pub fn open_privacy_settings(pane: String) -> Result<(), String> {
    let url = privacy_pane_url(&pane).ok_or("unknownPane")?;
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/open")
            .arg(url)
            .status()
            .map_err(|_| "openFailed".to_string())
            .and_then(|status| if status.success() { Ok(()) } else { Err("openFailed".into()) })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = url;
        Err("unsupported".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn microphone_status_maps_every_avauthorizationstatus() {
        assert_eq!(microphone_access_from_status(0), Access::NotDetermined);
        assert_eq!(microphone_access_from_status(1), Access::Restricted);
        assert_eq!(microphone_access_from_status(2), Access::Denied);
        assert_eq!(microphone_access_from_status(3), Access::Granted);
    }

    #[test]
    fn unknown_microphone_status_never_reads_as_granted() {
        assert_eq!(microphone_access_from_status(-1), Access::Denied);
        assert_eq!(microphone_access_from_status(99), Access::Denied);
    }

    #[test]
    fn access_codes_are_the_strings_the_frontend_matches() {
        let codes: Vec<_> = [
            Access::Granted,
            Access::Denied,
            Access::NotDetermined,
            Access::Restricted,
            Access::Unsupported,
        ]
        .iter()
        .map(|a| a.code())
        .collect();
        assert_eq!(
            codes,
            ["granted", "denied", "notDetermined", "restricted", "unsupported"]
        );
    }

    #[test]
    fn accessibility_trust_maps_to_granted_or_not_determined_never_a_guess() {
        assert_eq!(accessibility_access_from_trusted(true), Access::Granted);
        assert_eq!(accessibility_access_from_trusted(false), Access::NotDetermined);
        assert_eq!(accessibility_access_from_trusted(false).code(), "notDetermined");
    }

    #[test]
    fn only_the_audio_accessibility_and_calendar_privacy_panes_can_be_opened() {
        assert_eq!(
            privacy_pane_url("accessibility"),
            Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        );
        assert_eq!(
            privacy_pane_url("microphone"),
            Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
        );
        assert_eq!(
            privacy_pane_url("systemAudio"),
            Some("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        );
        assert_eq!(privacy_pane_url("https://example.com"), None);
        assert_eq!(
            privacy_pane_url("calendars"),
            Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars")
        );
        assert_eq!(privacy_pane_url("contacts"), None);
        assert_eq!(privacy_pane_url(""), None);
    }

    #[test]
    fn preflight_values_map_to_access_and_unknown_values_are_not_guessed() {
        assert_eq!(system_audio_access_from_preflight(0), Some(Access::Granted));
        assert_eq!(system_audio_access_from_preflight(1), Some(Access::Denied));
        assert_eq!(system_audio_access_from_preflight(2), Some(Access::NotDetermined));
        assert_eq!(system_audio_access_from_preflight(-1), None);
        assert_eq!(system_audio_access_from_preflight(7), None);
    }

    #[test]
    fn system_audio_status_reports_a_revoked_grant_with_the_platform_call_stubbed() {
        assert_eq!(system_audio_status(true, || Some(0)), Some(Access::Granted));
        assert_eq!(system_audio_status(true, || Some(1)), Some(Access::Denied));
        assert_eq!(system_audio_status(true, || Some(2)), Some(Access::NotDetermined));
    }

    #[test]
    fn system_audio_status_skips_the_tcc_read_below_macos_14_2() {
        let status = system_audio_status(false, || panic!("must not read TCC when taps are unavailable"));
        assert_eq!(status, Some(Access::Unsupported));
    }

    #[test]
    fn system_audio_status_is_none_when_tcc_cannot_be_read() {
        assert_eq!(system_audio_status(true, || None), None);
        assert_eq!(system_audio_status(true, || Some(42)), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_denied_or_unsupported_system_audio_probe_is_reported_as_such() {
        use crate::audio::system_macos::TapAccess;
        assert_eq!(system_audio_access_from_probe(TapAccess::Granted), Access::Granted);
        assert_eq!(system_audio_access_from_probe(TapAccess::Denied), Access::Denied);
        assert_eq!(
            system_audio_access_from_probe(TapAccess::Unsupported),
            Access::Unsupported
        );
    }
}
