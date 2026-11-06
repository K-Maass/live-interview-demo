//! The installed Calendar app's icon, for the "Calendars on this Mac" row in Settings → Calendars.
//!
//! Apple artwork is never bundled or redrawn: the icon is read from macOS at run time, the way Finder and "Open With"
//! menus show an installed app, rendered to a PNG of the requested pixel size and returned as a data URL. Only
//! `com.apple.iCal` is allowed, so this cannot become a general file-icon reader. The result is cached per size for
//! the session. Any failure is an error code; the UI then shows its outline calendar fallback.

// The `objc` 0.2 macros emit `cfg(cargo-clippy)` checks the modern compiler flags.
#![allow(unexpected_cfgs)]

use std::collections::HashMap;
use std::sync::Mutex;

/// Bundle identifiers whose icon may be read. Calendar only.
pub const ALLOWED_BUNDLE_IDS: [&str; 1] = ["com.apple.iCal"];
const MIN_SIZE: u32 = 16;
const MAX_SIZE: u32 = 256;

static CACHE: Mutex<Option<HashMap<u32, String>>> = Mutex::new(None);

/// Checks the request before anything touches macOS: the bundle id must be allow-listed and the size sane.
pub fn validate(bundle_id: &str, size: u32) -> Result<u32, String> {
    if !ALLOWED_BUNDLE_IDS.contains(&bundle_id) {
        return Err("appIconNotAllowed".into());
    }
    if !(MIN_SIZE..=MAX_SIZE).contains(&size) {
        return Err("appIconInvalidSize".into());
    }
    Ok(size)
}

/// Runs on the main thread (a synchronous Tauri command), which AppKit drawing expects.
#[tauri::command]
pub fn app_icon(bundle_id: String, size: u32) -> Result<String, String> {
    let size = validate(&bundle_id, size)?;
    if let Some(hit) = CACHE.lock().ok().and_then(|c| c.as_ref().and_then(|m| m.get(&size).cloned())) {
        return Ok(hit);
    }
    let png = render(&bundle_id, size)?;
    use base64::Engine as _;
    let url = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png));
    if let Ok(mut cache) = CACHE.lock() {
        cache.get_or_insert_with(HashMap::new).insert(size, url.clone());
    }
    Ok(url)
}

#[cfg(not(target_os = "macos"))]
fn render(_bundle_id: &str, _size: u32) -> Result<Vec<u8>, String> {
    Err("unsupported".into())
}

#[cfg(target_os = "macos")]
fn render(bundle_id: &str, size: u32) -> Result<Vec<u8>, String> {
    use objc::runtime::{Object, NO, YES};
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::CString;
    use std::os::raw::c_char;

    #[link(name = "AppKit", kind = "framework")]
    extern "C" {}

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Point { x: f64, y: f64 }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Size { width: f64, height: f64 }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Rect { origin: Point, size: Size }

    const COMPOSITE_SOURCE_OVER: usize = 2; // NSCompositingOperationSourceOver
    const FILE_TYPE_PNG: usize = 4; // NSBitmapImageFileTypePNG

    let id = CString::new(bundle_id).map_err(|_| "appIconNotAllowed".to_string())?;
    objc::rc::autoreleasepool(|| unsafe {
        let ns_string = |s: *const c_char| -> *mut Object { msg_send![class!(NSString), stringWithUTF8String: s] };
        let workspace: *mut Object = msg_send![class!(NSWorkspace), sharedWorkspace];
        let url: *mut Object = msg_send![workspace, URLForApplicationWithBundleIdentifier: ns_string(id.as_ptr())];
        if url.is_null() {
            return Err("appIconUnavailable".to_string());
        }
        let path: *mut Object = msg_send![url, path];
        let icon: *mut Object = msg_send![workspace, iconForFile: path];
        if icon.is_null() {
            return Err("appIconUnavailable".to_string());
        }
        let pixels = size as isize;
        let space = ns_string(b"NSCalibratedRGBColorSpace\0".as_ptr() as *const c_char);
        let rep: *mut Object = msg_send![class!(NSBitmapImageRep), alloc];
        let rep: *mut Object = msg_send![rep,
            initWithBitmapDataPlanes: std::ptr::null_mut::<*mut u8>()
            pixelsWide: pixels
            pixelsHigh: pixels
            bitsPerSample: 8isize
            samplesPerPixel: 4isize
            hasAlpha: YES
            isPlanar: NO
            colorSpaceName: space
            bytesPerRow: 0isize
            bitsPerPixel: 0isize];
        if rep.is_null() {
            return Err("appIconUnavailable".to_string());
        }
        let side = size as f64;
        let _: () = msg_send![rep, setSize: Size { width: side, height: side }];
        let context: *mut Object = msg_send![class!(NSGraphicsContext), graphicsContextWithBitmapImageRep: rep];
        let result = if context.is_null() {
            Err("appIconUnavailable".to_string())
        } else {
            let _: () = msg_send![class!(NSGraphicsContext), saveGraphicsState];
            let _: () = msg_send![class!(NSGraphicsContext), setCurrentContext: context];
            let target = Rect { origin: Point { x: 0.0, y: 0.0 }, size: Size { width: side, height: side } };
            let whole = Rect { origin: Point { x: 0.0, y: 0.0 }, size: Size { width: 0.0, height: 0.0 } };
            let _: () = msg_send![icon, drawInRect: target fromRect: whole operation: COMPOSITE_SOURCE_OVER fraction: 1.0f64];
            let _: () = msg_send![context, flushGraphics];
            let _: () = msg_send![class!(NSGraphicsContext), restoreGraphicsState];
            let properties: *mut Object = msg_send![class!(NSDictionary), dictionary];
            let data: *mut Object = msg_send![rep, representationUsingType: FILE_TYPE_PNG properties: properties];
            if data.is_null() {
                Err("appIconUnavailable".to_string())
            } else {
                let bytes: *const u8 = msg_send![data, bytes];
                let length: usize = msg_send![data, length];
                if bytes.is_null() || length == 0 {
                    Err("appIconUnavailable".to_string())
                } else {
                    Ok(std::slice::from_raw_parts(bytes, length).to_vec())
                }
            }
        };
        let _: () = msg_send![rep, release];
        result
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_calendar_app_icon_can_be_read() {
        assert_eq!(validate("com.apple.iCal", 64), Ok(64));
        for other in ["com.apple.finder", "com.microsoft.Outlook", "", "com.apple.iCal ", "/Applications/Calendar.app"] {
            assert_eq!(validate(other, 64), Err("appIconNotAllowed".into()), "{other}");
            assert_eq!(app_icon(other.into(), 64), Err("appIconNotAllowed".into()));
        }
    }

    #[test]
    fn sizes_outside_16_to_256_pixels_are_refused() {
        assert!(validate("com.apple.iCal", 15).is_err());
        assert!(validate("com.apple.iCal", 257).is_err());
        assert!(validate("com.apple.iCal", 16).is_ok());
        assert!(validate("com.apple.iCal", 256).is_ok());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_calendar_icon_is_a_png_data_url_of_the_requested_size() {
        // Calendar.app ships with macOS; this reads its icon without any permission prompt.
        let url = app_icon("com.apple.iCal".into(), 64).expect("Calendar icon");
        let png = url.strip_prefix("data:image/png;base64,").expect("PNG data URL");
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD.decode(png).unwrap();
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
        // IHDR width and height, big-endian, at bytes 16..24.
        assert_eq!(u32::from_be_bytes(bytes[16..20].try_into().unwrap()), 64);
        assert_eq!(u32::from_be_bytes(bytes[20..24].try_into().unwrap()), 64);
    }
}
