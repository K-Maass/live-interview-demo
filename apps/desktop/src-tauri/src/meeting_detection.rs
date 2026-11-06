use serde_json::Value;
use std::collections::{HashSet, VecDeque};
use std::hash::Hash;
use std::time::{Duration, Instant};

trait AccessibilityTree {
    type Node: Clone + Eq + Hash;
    fn enable(&mut self, node: &Self::Node, attribute: &str) -> Result<(), i32>;
    fn text(&mut self, node: &Self::Node, attribute: &str) -> Result<String, i32>;
    fn owner_window(&mut self, node: &Self::Node) -> Result<Option<Self::Node>, i32>;
    fn elements(
        &mut self,
        node: &Self::Node,
        attribute: &str,
        limit: usize,
    ) -> Result<(Vec<Self::Node>, bool), i32>;
}
#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlFlags {
    leave: bool,
    microphone: bool,
    camera: bool,
}
impl ControlFlags {
    fn complete(&self) -> bool {
        self.leave && self.microphone && self.camera
    }
    fn observe(&mut self, label: &str) {
        let label = label.trim().to_lowercase();
        self.leave |= ["leave", "hang up", "verlassen", "anruf beenden"]
            .iter()
            .any(|needle| label == *needle || label.starts_with(&format!("{needle},")));
        self.microphone |= ["microphone", "mikrofon", "mute", "unmute"]
            .iter()
            .any(|needle| label.contains(needle));
        self.camera |= ["camera", "kamera", "video"]
            .iter()
            .any(|needle| label.contains(needle));
    }
}
#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanDiagnostics {
    nodes_visited: usize,
    buttons_visited: usize,
    web_areas_visited: usize,
    max_depth_seen: usize,
    clipped: bool,
    manual_accessibility_requested: bool,
    enhanced_interface_requested: bool,
    windows_returned: usize,
    unique_windows: usize,
    foreign_window_buttons: usize,
    unknown_window_buttons: usize,
    errors: usize,
    error_codes: Vec<i32>,
}
impl ScanDiagnostics {
    fn error(&mut self, code: i32) {
        self.errors += 1;
        if self.error_codes.len() < 8 && !self.error_codes.contains(&code) {
            self.error_codes.push(code);
        }
    }
}
struct WindowScan {
    controls: ControlFlags,
    diagnostic: ScanDiagnostics,
}
struct ScanLimits {
    max_nodes: usize,
    max_depth: usize,
    deadline: Instant,
}
fn deduplicate_windows<N: Clone + Eq + Hash>(windows: Vec<N>) -> Vec<N> {
    let mut seen = HashSet::new();
    // Native Node identity uses CFEqual/CFHash; neither title nor child-tree
    // similarity can collapse two distinct physical windows.
    windows
        .into_iter()
        .filter(|window| seen.insert(window.clone()))
        .collect()
}
fn meeting_shaped_title(title: &str) -> bool {
    let title = title.to_lowercase();
    ["meeting", "besprechung", "anruf"]
        .iter()
        .any(|needle| title.contains(needle))
}
fn prioritize_windows<N>(windows: &mut [(N, String)]) {
    // A title only orders bounded inspection. Controls remain the evidence.
    windows.sort_by_key(|(_, title)| !meeting_shaped_title(title));
}
impl Default for ScanLimits {
    fn default() -> Self {
        Self {
            max_nodes: 2048,
            max_depth: 64,
            deadline: Instant::now() + Duration::from_secs(2),
        }
    }
}
/// Teams processes whose renderer accessibility was already requested. Setting AXManualAccessibility
/// once is enough for a process's lifetime, so the 5 s poll does not repeat it; a pid that has gone is
/// forgotten, so a restarted Teams is asked again.
#[derive(Default)]
struct ActivationMemo {
    pids: HashSet<i32>,
}
impl ActivationMemo {
    fn needs(&self, pid: i32) -> bool {
        !self.pids.contains(&pid)
    }
    /// Records a pid after a successful request; a failed one is retried on the next poll.
    fn record(&mut self, pid: i32, diagnostic: &ScanDiagnostics) {
        if diagnostic.manual_accessibility_requested || diagnostic.enhanced_interface_requested {
            self.pids.insert(pid);
        }
    }
    fn retain_running(&mut self, running: &HashSet<i32>) {
        self.pids.retain(|pid| running.contains(pid));
    }
}
fn prepare_application<T: AccessibilityTree>(
    tree: &mut T,
    app: &T::Node,
    diagnostic: &mut ScanDiagnostics,
) {
    // Electron may expose only its native shell until explicitly enabled. This
    // requests accessibility, never a button action or microphone permission.
    match tree.enable(app, "AXManualAccessibility") {
        Ok(()) => diagnostic.manual_accessibility_requested = true,
        Err(code) => {
            diagnostic.error(code);
            match tree.enable(app, "AXEnhancedUserInterface") {
                Ok(()) => diagnostic.enhanced_interface_requested = true,
                Err(code) => diagnostic.error(code),
            }
        }
    }
    // Renderer population can be delayed. Do not block waiting or treat a
    // successful activation request as call evidence; a later poll can refine.
}
fn scan_window<T: AccessibilityTree>(
    tree: &mut T,
    root: T::Node,
    limits: ScanLimits,
) -> WindowScan {
    let mut scan = WindowScan {
        controls: ControlFlags::default(),
        diagnostic: ScanDiagnostics::default(),
    };
    let scanned_window = root.clone();
    let mut queue = VecDeque::from([(root, 0)]);
    let mut visited = HashSet::new();
    while let Some((node, depth)) = queue.pop_front() {
        if Instant::now() >= limits.deadline || scan.diagnostic.nodes_visited >= limits.max_nodes {
            scan.diagnostic.clipped = true;
            break;
        }
        if depth > limits.max_depth {
            scan.diagnostic.clipped = true;
            continue;
        }
        if !visited.insert(node.clone()) {
            continue;
        }
        scan.diagnostic.nodes_visited += 1;
        scan.diagnostic.max_depth_seen = scan.diagnostic.max_depth_seen.max(depth);
        match tree.text(&node, "AXRole") {
            Ok(role) if role == "AXButton" => {
                scan.diagnostic.buttons_visited += 1;
                let foreign = match tree.owner_window(&node) {
                    Ok(Some(owner)) => {
                        let foreign = owner != scanned_window;
                        if foreign {
                            scan.diagnostic.foreign_window_buttons += 1;
                        }
                        foreign
                    }
                    Ok(None) => {
                        scan.diagnostic.unknown_window_buttons += 1;
                        false
                    }
                    Err(code) => {
                        scan.diagnostic.unknown_window_buttons += 1;
                        scan.diagnostic.error(code);
                        false
                    }
                };
                // Native ownership compares CFEqual identities. An unavailable
                // AXWindow link does not establish that a current call ended.
                if !foreign {
                    for attribute in ["AXTitle", "AXDescription", "AXHelp"] {
                        match tree.text(&node, attribute) {
                            Ok(label) => scan.controls.observe(&label),
                            Err(code) => scan.diagnostic.error(code),
                        }
                    }
                }
            }
            Ok(role) if role == "AXWebArea" => scan.diagnostic.web_areas_visited += 1,
            Ok(_) => {}
            Err(code) => scan.diagnostic.error(code),
        }
        if scan.controls.complete() {
            break;
        }
        let remaining = limits
            .max_nodes
            .saturating_sub(scan.diagnostic.nodes_visited + queue.len());
        match tree.elements(&node, "AXChildren", remaining) {
            Ok((children, clipped)) => {
                scan.diagnostic.clipped |= clipped;
                queue.extend(
                    children
                        .into_iter()
                        .filter(|child| !visited.contains(child))
                        .map(|child| (child, depth + 1)),
                );
            }
            Err(code) => scan.diagnostic.error(code),
        }
    }
    scan
}
fn detection_result(
    found: Vec<String>,
    incomplete: bool,
    observed_at: u128,
    diagnostics: Value,
) -> Value {
    if found.len() == 1 {
        serde_json::json!({"verified":true,"title":found[0],"observedAt":observed_at,"source":"teams-accessibility-controls","diagnostics":diagnostics})
    } else {
        let code = if found.len() > 1 {
            "ambiguousCalls"
        } else if incomplete {
            "accessibilityTraversalIncomplete"
        } else {
            "noVerifiedCall"
        };
        let mut result = serde_json::json!({"verified":false,"title":"","code":code,"observedAt":observed_at,"diagnostics":diagnostics});
        if found.len() > 1 {
            // Only control-qualified windows reach this list. Ambiguity stays
            // unverified; the application may offer an explicit user choice.
            result["candidates"] = serde_json::json!(found.iter().map(|title| serde_json::json!({"title":title,"source":"teams-accessibility-controls"})).collect::<Vec<_>>());
        }
        result
    }
}
#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use core_foundation::{
        array::CFArray,
        base::{CFEqual, CFGetTypeID, CFHash, CFRelease, CFRetain, CFTypeRef, TCFType},
        boolean::CFBoolean,
        string::CFString,
    };
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};
    use std::{ffi::c_void, hash::Hasher};
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXUIElementCreateApplication(pid: i32) -> *const c_void;
        fn AXUIElementGetTypeID() -> usize;
        fn AXUIElementCopyAttributeValue(
            element: *const c_void,
            attribute: *const c_void,
            value: *mut CFTypeRef,
        ) -> i32;
        fn AXUIElementSetAttributeValue(
            element: *const c_void,
            attribute: *const c_void,
            value: CFTypeRef,
        ) -> i32;
        fn AXUIElementSetMessagingTimeout(element: *const c_void, seconds: f32) -> i32;
    }
    struct Node(*const c_void);
    impl Node {
        unsafe fn owned(value: *const c_void) -> Self {
            // Timeout belongs only to this AX reference, never the global system object.
            AXUIElementSetMessagingTimeout(value, 0.075);
            Self(value)
        }
    }
    impl Clone for Node {
        fn clone(&self) -> Self {
            unsafe {
                CFRetain(self.0);
                Self::owned(self.0)
            }
        }
    }
    impl Drop for Node {
        fn drop(&mut self) {
            unsafe { CFRelease(self.0) }
        }
    }
    impl PartialEq for Node {
        fn eq(&self, other: &Self) -> bool {
            unsafe { CFEqual(self.0, other.0) != 0 }
        }
    }
    impl Eq for Node {}
    impl Hash for Node {
        fn hash<H: Hasher>(&self, state: &mut H) {
            unsafe {
                state.write_usize(CFHash(self.0));
            }
        }
    }
    struct NativeTree;
    unsafe fn attr(node: &Node, name: &str) -> Result<CFTypeRef, i32> {
        let name = CFString::new(name);
        let mut value = std::ptr::null();
        let error = AXUIElementCopyAttributeValue(node.0, name.as_CFTypeRef(), &mut value);
        if error == 0 && !value.is_null() {
            Ok(value)
        } else {
            if !value.is_null() {
                CFRelease(value);
            }
            Err(if error == 0 { -25212 } else { error })
        }
    }
    impl AccessibilityTree for NativeTree {
        type Node = Node;
        fn enable(&mut self, node: &Node, attribute: &str) -> Result<(), i32> {
            unsafe {
                let error = AXUIElementSetAttributeValue(
                    node.0,
                    CFString::new(attribute).as_CFTypeRef(),
                    CFBoolean::true_value().as_CFTypeRef(),
                );
                if error == 0 {
                    Ok(())
                } else {
                    Err(error)
                }
            }
        }
        fn text(&mut self, node: &Node, attribute: &str) -> Result<String, i32> {
            unsafe {
                let value = match attr(node, attribute) {
                    Ok(value) => value,
                    // Optional labels and leaf children normally omit these attributes.
                    Err(-25205 | -25212) => return Ok(String::new()),
                    Err(code) => return Err(code),
                };
                let result = if CFGetTypeID(value) == CFString::type_id() {
                    Ok(CFString::wrap_under_get_rule(value as _).to_string())
                } else {
                    Err(-25201)
                };
                CFRelease(value);
                result
            }
        }
        fn owner_window(&mut self, node: &Node) -> Result<Option<Node>, i32> {
            unsafe {
                let value = match attr(node, "AXWindow") {
                    Ok(value) => value,
                    Err(-25205 | -25212) => return Ok(None),
                    Err(code) => return Err(code),
                };
                if CFGetTypeID(value) != AXUIElementGetTypeID() {
                    CFRelease(value);
                    return Err(-25201);
                }
                // CopyAttributeValue supplied the owned reference transferred here.
                Ok(Some(Node::owned(value)))
            }
        }
        fn elements(
            &mut self,
            node: &Node,
            attribute: &str,
            limit: usize,
        ) -> Result<(Vec<Node>, bool), i32> {
            unsafe {
                let value = match attr(node, attribute) {
                    Ok(value) => value,
                    Err(-25205 | -25212) => return Ok((Vec::new(), false)),
                    Err(code) => return Err(code),
                };
                if CFGetTypeID(value) != CFArray::<*const c_void>::type_id() {
                    CFRelease(value);
                    return Err(-25201);
                }
                let array = CFArray::<*const c_void>::wrap_under_get_rule(value as _);
                let clipped = array.len() as usize > limit;
                let mut nodes = Vec::new();
                let mut error = None;
                for i in 0..array.len().min(limit as isize) {
                    let element = *array.get(i).unwrap();
                    if element.is_null() || CFGetTypeID(element) != AXUIElementGetTypeID() {
                        error = Some(-25201);
                        break;
                    }
                    CFRetain(element);
                    nodes.push(Node::owned(element));
                }
                CFRelease(value);
                match error {
                    Some(code) => Err(code),
                    None => Ok((nodes, clipped)),
                }
            }
        }
    }
    static ACTIVATED: std::sync::Mutex<Option<ActivationMemo>> = std::sync::Mutex::new(None);
    pub fn detect() -> Value {
        // The poll runs on a blocking-pool thread with no autorelease pool, so the autoreleased objects
        // from each NSRunningApplication query would otherwise accumulate for the life of the thread.
        objc::rc::autoreleasepool(detect_in_pool)
    }
    fn detect_in_pool() -> Value {
        unsafe {
            if !AXIsProcessTrusted() {
                return serde_json::json!({"verified":false,"title":"","code":"accessibilitySetupRequired","observedAt":now()});
            }
            let deadline = Instant::now() + Duration::from_secs(2);
            let mut tree = NativeTree;
            let mut found = Vec::new();
            let mut activations = Vec::new();
            let mut scans = Vec::new();
            let mut processes = HashSet::new();
            let mut incomplete = false;
            // Only Teams application references are eligible for AX activation.
            for bundle in ["com.microsoft.teams2", "com.microsoft.teams"] {
                let name = CFString::new(bundle);
                let apps: *mut Object = msg_send![class!(NSRunningApplication),runningApplicationsWithBundleIdentifier:name.as_concrete_TypeRef()];
                let count: usize = msg_send![apps, count];
                incomplete |= count > 4;
                for n in 0..count.min(4) {
                    if Instant::now() >= deadline {
                        incomplete = true;
                        break;
                    }
                    let process: *mut Object = msg_send![apps,objectAtIndex:n];
                    let pid: i32 = msg_send![process, processIdentifier];
                    if !processes.insert(pid) {
                        continue;
                    }
                    let value = AXUIElementCreateApplication(pid);
                    if value.is_null() {
                        incomplete = true;
                        continue;
                    }
                    let app = Node::owned(value);
                    let mut activation = ScanDiagnostics::default();
                    let mut memo = ACTIVATED.lock().unwrap_or_else(|e| e.into_inner());
                    let memo = memo.get_or_insert_with(ActivationMemo::default);
                    if memo.needs(pid) {
                        prepare_application(&mut tree, &app, &mut activation);
                        memo.record(pid, &activation);
                    }
                    match tree.elements(&app, "AXWindows", 8) {
                        Ok((windows, clipped)) => {
                            incomplete |= clipped;
                            activation.clipped |= clipped;
                            activation.windows_returned = windows.len();
                            let windows = deduplicate_windows(windows);
                            activation.unique_windows = windows.len();
                            let mut titled_windows = Vec::new();
                            for window in windows {
                                if Instant::now() >= deadline {
                                    incomplete = true;
                                    break;
                                }
                                let title = match tree.text(&window, "AXTitle") {
                                    Ok(title) => title,
                                    Err(code) => {
                                        activation.error(code);
                                        incomplete = true;
                                        String::new()
                                    }
                                };
                                titled_windows.push((window, title));
                            }
                            prioritize_windows(&mut titled_windows);
                            for (window, title) in titled_windows {
                                if Instant::now() >= deadline {
                                    incomplete = true;
                                    break;
                                }
                                let scan = scan_window(
                                    &mut tree,
                                    window.clone(),
                                    ScanLimits {
                                        deadline,
                                        ..ScanLimits::default()
                                    },
                                );
                                let has_title = !title.is_empty();
                                let meeting_shaped = meeting_shaped_title(&title);
                                let verified = scan.controls.complete() && has_title;
                                if verified {
                                    found.push(title);
                                } else if scan.diagnostic.clipped || scan.diagnostic.errors > 0 {
                                    incomplete = true;
                                }
                                scans.push(serde_json::json!({"counts":scan.diagnostic,"matched":scan.controls,"hasTitle":has_title,"meetingShapedTitle":meeting_shaped}));
                            }
                        }
                        Err(code) => {
                            activation.error(code);
                            incomplete = true;
                        }
                    }
                    activations.push(activation);
                }
            }
            if let Some(memo) = ACTIVATED.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
                memo.retain_running(&processes);
            }
            let diagnostics = serde_json::json!({"processCount":processes.len(),"windows":scans,"activation":activations,"incomplete":incomplete});
            // Preserve positive control-based detection even when unrelated
            // window inspection is bounded; diagnostic incompleteness is explicit.
            detection_result(found, incomplete, now(), diagnostics)
        }
    }
    fn now() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    }
}
#[tauri::command]
pub async fn detect_teams_call() -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        tokio::task::spawn_blocking(mac::detect)
            .await
            .map_err(|_| "detectionUnavailable".into())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(serde_json::json!({"verified":false,"title":"","code":"unsupportedPlatform"}))
    }
}

#[cfg(test)]
mod detection_tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    struct FakeTree {
        nodes: HashMap<usize, (&'static str, &'static str, Vec<usize>)>,
        owners: HashMap<usize, usize>,
        owner_error: Option<i32>,
        lazy: bool,
        enabled: bool,
        manual_error: bool,
        read_error: Option<i32>,
        writes: Vec<(usize, String)>,
    }
    impl AccessibilityTree for FakeTree {
        type Node = usize;
        fn enable(&mut self, node: &usize, attribute: &str) -> Result<(), i32> {
            self.writes.push((*node, attribute.into()));
            if self.manual_error && attribute == "AXManualAccessibility" {
                return Err(-25205);
            }
            self.enabled = true;
            Ok(())
        }
        fn text(&mut self, node: &usize, attribute: &str) -> Result<String, i32> {
            if let Some(code) = self.read_error {
                return Err(code);
            }
            let (role, label, _) = self.nodes.get(node).unwrap();
            Ok(match attribute {
                "AXRole" => *role,
                "AXTitle" => *label,
                _ => "",
            }
            .into())
        }
        fn owner_window(&mut self, node: &usize) -> Result<Option<usize>, i32> {
            match self.owner_error {
                Some(code) => Err(code),
                None => Ok(self.owners.get(node).copied()),
            }
        }
        fn elements(
            &mut self,
            node: &usize,
            _attribute: &str,
            limit: usize,
        ) -> Result<(Vec<usize>, bool), i32> {
            if self.lazy && !self.enabled {
                return Ok((vec![], false));
            }
            let children = &self.nodes.get(node).unwrap().2;
            Ok((
                children.iter().copied().take(limit).collect(),
                children.len() > limit,
            ))
        }
    }
    fn controls() -> FakeTree {
        let mut tree = FakeTree::default();
        tree.nodes
            .insert(0, ("AXWindow", "Synthetic Teams call", vec![1, 2, 3]));
        tree.nodes.insert(1, ("AXButton", "Leave", vec![]));
        tree.nodes.insert(2, ("AXButton", "Mute mic", vec![]));
        tree.nodes.insert(3, ("AXButton", "Turn camera on", vec![]));
        tree
    }
    #[test]
    fn observed_english_controls_are_sufficient_without_title_inference() {
        let scan = scan_window(&mut controls(), 0, ScanLimits::default());
        assert!(scan.controls.complete());
        let mut tree = controls();
        tree.nodes.get_mut(&0).unwrap().2.clear();
        let scan = scan_window(&mut tree, 0, ScanLimits::default());
        assert!(
            !scan.controls.complete(),
            "A call-shaped title cannot establish an actual call"
        );
    }
    #[test]
    fn renderer_accessibility_is_requested_once_per_teams_process() {
        let mut memo = ActivationMemo::default();
        assert!(memo.needs(41));
        memo.record(41, &ScanDiagnostics::default());
        assert!(memo.needs(41), "a failed request is retried on the next poll");
        let mut requested = ScanDiagnostics::default();
        requested.manual_accessibility_requested = true;
        memo.record(41, &requested);
        assert!(!memo.needs(41));
        memo.retain_running(&HashSet::from([42]));
        assert!(memo.needs(41), "a restarted Teams gets a fresh request");
    }
    #[test]
    fn lazy_renderer_is_enabled_on_teams_application_before_scanning() {
        let mut tree = controls();
        tree.lazy = true;
        let mut diagnostic = ScanDiagnostics::default();
        prepare_application(&mut tree, &99, &mut diagnostic);
        let scan = scan_window(&mut tree, 0, ScanLimits::default());
        assert!(scan.controls.complete());
        assert_eq!(tree.writes, vec![(99, "AXManualAccessibility".into())]);
    }
    #[test]
    fn unsupported_electron_attribute_falls_back_to_chromium_readiness() {
        let mut tree = controls();
        tree.lazy = true;
        tree.manual_error = true;
        prepare_application(&mut tree, &99, &mut ScanDiagnostics::default());
        assert!(scan_window(&mut tree, 0, ScanLimits::default())
            .controls
            .complete());
        assert_eq!(
            tree.writes,
            vec![
                (99, "AXManualAccessibility".into()),
                (99, "AXEnhancedUserInterface".into())
            ]
        );
    }
    #[test]
    fn controls_beyond_old_depth_limit_are_found_in_nested_web_content() {
        let mut tree = controls();
        tree.nodes.get_mut(&0).unwrap().2 = vec![10];
        for n in 10..40 {
            tree.nodes.insert(n, ("AXGroup", "", vec![n + 1]));
        }
        tree.nodes.insert(40, ("AXWebArea", "", vec![1, 2, 3]));
        let scan = scan_window(&mut tree, 0, ScanLimits::default());
        assert!(scan.controls.complete());
    }
    #[test]
    fn a_large_unrelated_branch_cannot_starve_shallow_call_controls() {
        let mut tree = controls();
        tree.nodes.get_mut(&0).unwrap().2 = vec![10, 1, 2, 3];
        tree.nodes.insert(10, ("AXGroup", "", (100..700).collect()));
        for n in 100..700 {
            tree.nodes
                .insert(n, ("AXStaticText", "Synthetic unrelated text", vec![]));
        }
        let scan = scan_window(&mut tree, 0, ScanLimits::default());
        assert!(scan.controls.complete());
        assert!(
            scan.diagnostic.nodes_visited < 20,
            "Breadth first traversal must reach the nearby controls before unrelated content"
        );
    }
    #[test]
    fn cyclic_or_excessive_trees_are_bounded_and_report_clipping() {
        let mut tree = controls();
        tree.nodes.get_mut(&0).unwrap().2 = vec![0];
        let scan = scan_window(&mut tree, 0, ScanLimits::default());
        assert_eq!(scan.diagnostic.nodes_visited, 1);
        assert!(!scan.controls.complete());
        tree.nodes.get_mut(&0).unwrap().2 = (100..200).collect();
        for n in 100..200 {
            tree.nodes.insert(n, ("AXGroup", "", vec![]));
        }
        let scan = scan_window(
            &mut tree,
            0,
            ScanLimits {
                max_nodes: 8,
                ..ScanLimits::default()
            },
        );
        assert!(scan.diagnostic.nodes_visited <= 8);
        assert!(scan.diagnostic.clipped);
        assert!(!scan.controls.complete());
    }
    #[test]
    fn safe_diagnostics_expose_counts_and_flags_without_labels_or_content() {
        let scan = scan_window(&mut controls(), 0, ScanLimits::default());
        let json = serde_json::to_string(&scan.diagnostic).unwrap();
        assert!(!json.contains("Synthetic Teams call"));
        assert!(!json.contains("Mute mic"));
        assert!(json.contains("nodesVisited"));
    }
    #[test]
    fn elapsed_deadline_cannot_start_an_unbounded_scan() {
        let scan = scan_window(
            &mut controls(),
            0,
            ScanLimits {
                deadline: Instant::now() - Duration::from_millis(1),
                ..ScanLimits::default()
            },
        );
        assert_eq!(scan.diagnostic.nodes_visited, 0);
        assert!(scan.diagnostic.clipped);
        assert!(!scan.controls.complete());
    }
    #[test]
    fn depth_cutoff_is_reported_without_inventing_call_controls() {
        let mut tree = controls();
        tree.nodes.get_mut(&0).unwrap().2 = vec![10];
        tree.nodes.insert(10, ("AXGroup", "", vec![11]));
        tree.nodes.insert(11, ("AXWebArea", "", vec![1, 2, 3]));
        let scan = scan_window(
            &mut tree,
            0,
            ScanLimits {
                max_depth: 1,
                ..ScanLimits::default()
            },
        );
        assert!(scan.diagnostic.clipped);
        assert!(!scan.controls.complete());
    }
    #[test]
    fn failed_ax_reads_are_observable_without_returning_private_text() {
        let mut tree = controls();
        tree.read_error = Some(-25204);
        let scan = scan_window(&mut tree, 0, ScanLimits::default());
        assert!(!scan.controls.complete());
        assert!(scan.diagnostic.errors > 0);
        assert_eq!(scan.diagnostic.error_codes, vec![-25204]);
    }
    #[test]
    fn meeting_titles_only_prioritize_inspection_and_do_not_verify_a_call() {
        let mut windows = vec![
            (0, "Synthetic Teams main".into()),
            (1, "Meeting in synthetic room | Microsoft Teams".into()),
        ];
        prioritize_windows(&mut windows);
        assert_eq!(windows[0].0, 1);
        let mut tree = controls();
        tree.nodes.get_mut(&0).unwrap().2.clear();
        assert!(!scan_window(&mut tree, 0, ScanLimits::default())
            .controls
            .complete());
    }
    #[test]
    fn duplicate_physical_window_references_cannot_count_as_two_verified_calls() {
        let mut tree = controls();
        let windows = deduplicate_windows(vec![0, 0]);
        let matched = windows
            .into_iter()
            .filter(|window| {
                scan_window(&mut tree, *window, ScanLimits::default())
                    .controls
                    .complete()
            })
            .count();
        assert_eq!(matched, 1);
    }
    #[test]
    fn distinct_windows_with_the_same_title_remain_separate_call_candidates() {
        let mut tree = controls();
        tree.nodes
            .insert(10, ("AXWindow", "Synthetic Teams call", vec![1, 2, 3]));
        let windows = deduplicate_windows(vec![0, 10, 0]);
        assert_eq!(windows, vec![0, 10]);
        let matched = windows
            .into_iter()
            .filter(|window| {
                scan_window(&mut tree, *window, ScanLimits::default())
                    .controls
                    .complete()
            })
            .count();
        assert_eq!(
            matched, 2,
            "Title or shared child controls must not merge distinct physical windows"
        );
    }
    #[test]
    fn shared_controls_owned_by_another_window_cannot_verify_this_root() {
        let mut tree = controls();
        tree.nodes
            .insert(10, ("AXWindow", "Synthetic Teams call", vec![1, 2, 3]));
        for button in [1, 2, 3] {
            tree.owners.insert(button, 0);
        }
        assert!(scan_window(&mut tree, 0, ScanLimits::default())
            .controls
            .complete());
        let scan = scan_window(&mut tree, 10, ScanLimits::default());
        assert!(!scan.controls.complete());
        assert_eq!(scan.diagnostic.foreign_window_buttons, 3);
        assert_eq!(scan.diagnostic.unknown_window_buttons, 0);
    }
    #[test]
    fn same_title_windows_with_their_own_controls_remain_two_calls() {
        let mut tree = controls();
        tree.nodes
            .insert(10, ("AXWindow", "Synthetic Teams call", vec![11, 12, 13]));
        for (button, title) in [(11, "Leave"), (12, "Mute mic"), (13, "Turn camera on")] {
            tree.nodes.insert(button, ("AXButton", title, vec![]));
            tree.owners.insert(button, 10);
        }
        for button in [1, 2, 3] {
            tree.owners.insert(button, 0);
        }
        let matched = [0, 10]
            .into_iter()
            .filter(|root| {
                scan_window(&mut tree, *root, ScanLimits::default())
                    .controls
                    .complete()
            })
            .count();
        assert_eq!(matched, 2);
    }
    #[test]
    fn unknown_control_ownership_preserves_existing_call_evidence() {
        let scan = scan_window(&mut controls(), 0, ScanLimits::default());
        assert!(scan.controls.complete());
        assert_eq!(scan.diagnostic.unknown_window_buttons, 3);
        assert_eq!(scan.diagnostic.foreign_window_buttons, 0);
        assert_eq!(scan.diagnostic.errors, 0);
    }
    #[test]
    fn ownership_read_failure_is_unknown_and_reports_only_safe_error_codes() {
        let mut tree = controls();
        tree.owner_error = Some(-25204);
        let scan = scan_window(&mut tree, 0, ScanLimits::default());
        assert!(scan.controls.complete());
        assert_eq!(scan.diagnostic.unknown_window_buttons, 3);
        assert_eq!(scan.diagnostic.errors, 3);
        assert_eq!(scan.diagnostic.error_codes, vec![-25204]);
    }
    #[test]
    fn ambiguity_offers_qualified_candidates_without_automatic_call_selection() {
        let result = detection_result(
            vec!["Synthetic call A".into(), "Synthetic call B".into()],
            false,
            1,
            serde_json::json!({}),
        );
        assert_eq!(result["verified"], false);
        assert_eq!(result["code"], "ambiguousCalls");
        assert_eq!(result["title"], "");
        let candidates = result["candidates"]
            .as_array()
            .expect("Ambiguous qualified calls must remain selectable by the user");
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0]["title"], "Synthetic call A");
        assert_eq!(candidates[1]["title"], "Synthetic call B");
        assert!(candidates
            .iter()
            .all(|candidate| candidate["source"] == "teams-accessibility-controls"));
    }
    #[test]
    fn missing_or_incomplete_call_evidence_never_offers_candidates() {
        for incomplete in [false, true] {
            let result = detection_result(vec![], incomplete, 1, serde_json::json!({}));
            assert_eq!(result["verified"], false);
            assert!(result.get("candidates").is_none());
        }
    }
}
