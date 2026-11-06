//! Privacy-safe source locators for the outbound reasoning boundary.
//!
//! A local excerpt's locator is its full file path, which usually carries the
//! macOS user name. The service only needs a readable label, so every body sent
//! to `/v1/reasoning` and `/v1/decide` passes through [`sanitize_body`] first:
//! - a file inside a connected workspace folder becomes `<workspace name>/<relative path>`;
//! - any other local file becomes its file name only;
//! - a web URL keeps its scheme, host and path (no credentials, query or fragment);
//! - other locators (`meeting:…`) are unchanged.
//!
//! The section suffix (`#heading:part2`) is kept. Only the outbound copy changes:
//! the renderer keeps the full path in its evidence records, and cards map back to
//! sources by `sourceId`, never by locator.
use serde_json::Value;

/// One connected workspace folder: the display name and the folder path.
#[derive(Clone, Debug)]
pub struct Root {
    pub name: String,
    pub path: String,
}

/// What the service rejects as a local path (apps/service/src/validation.mjs).
pub fn looks_local(locator: &str) -> bool {
    let b = locator.as_bytes();
    locator.starts_with('/')
        || locator.starts_with('~')
        || locator.starts_with('\\')
        || locator.to_ascii_lowercase().starts_with("file:")
        || locator.contains("/Users/")
        || (b.len() > 2
            && b[0].is_ascii_alphabetic()
            && b[1] == b':'
            && matches!(b[2], b'\\' | b'/'))
}

fn file_name(path: &str) -> &str {
    path.rsplit(['/', '\\'])
        .find(|s| !s.is_empty())
        .unwrap_or("")
}

fn safe_name(name: &str) -> String {
    let trimmed = name
        .trim()
        .trim_start_matches(['/', '~', '\\'])
        .replace('/', "-");
    if trimmed.is_empty() || looks_local(&trimmed) {
        "Workspace".into()
    } else {
        trimmed
    }
}

fn web(locator: &str) -> Option<String> {
    let mut url = url::Url::parse(locator).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_query(None);
    url.set_fragment(None);
    Some(url.to_string())
}

fn decode_file_url(locator: &str) -> String {
    let rest = &locator[5..];
    // Drop an authority (`file://host/path`); keep the absolute path.
    let path = match rest.strip_prefix("//") {
        Some(r) => r.find('/').map(|i| &r[i..]).unwrap_or(""),
        None => rest,
    };
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        match (
            bytes[i],
            bytes.get(i + 1).and_then(|&b| hex(b)),
            bytes.get(i + 2).and_then(|&b| hex(b)),
        ) {
            (b'%', Some(h), Some(l)) => {
                out.push((h * 16 + l) as u8);
                i += 3;
            }
            (b, _, _) => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The privacy-safe form of one locator.
pub fn privacy_locator(locator: &str, roots: &[Root]) -> String {
    let lower = locator.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return web(locator).unwrap_or_else(|| "web source".into());
    }
    if !looks_local(locator) {
        return locator.to_owned();
    }
    // Local locators are `<path>#<section>`; file names may contain `#`, so the
    // section is split off only after the longest matching root or at the last `#`.
    let path_and_section = if lower.starts_with("file:") {
        decode_file_url(locator)
    } else {
        locator.to_owned()
    };
    let mut best: Option<(&Root, &str)> = None;
    for root in roots {
        let base = root.path.trim_end_matches(['/', '\\']);
        if base.is_empty() {
            continue;
        }
        if let Some(rest) = path_and_section.strip_prefix(base) {
            if rest.is_empty() || rest.starts_with(['/', '\\', '#']) {
                if best.is_none_or(|(b, _)| b.path.len() < root.path.len()) {
                    best = Some((root, rest));
                }
            }
        }
    }
    let candidate = match best {
        Some((root, rest)) => {
            let rest = rest.trim_start_matches(['/', '\\']).replace('\\', "/");
            let name = safe_name(&root.name);
            if rest.is_empty() || rest.starts_with('#') {
                format!("{name}{rest}")
            } else {
                format!("{name}/{rest}")
            }
        }
        None => outside(&path_and_section),
    };
    if looks_local(&candidate) {
        // A relative path that still looks local (e.g. a `Users` subfolder):
        // fall back to the file name.
        outside(&path_and_section)
    } else {
        candidate
    }
}

fn outside(path_and_section: &str) -> String {
    let (path, section) = match path_and_section.rfind('#') {
        Some(i) if !path_and_section[i..].contains(['/', '\\']) => path_and_section.split_at(i),
        _ => (path_and_section, ""),
    };
    let name = file_name(path);
    let name = if name.starts_with('~') || name.is_empty() {
        format!("./{name}")
    } else {
        name.to_owned()
    };
    format!("{name}{section}")
}

/// Replaces every `"locator":"…"` inside free text (prompts embed source hits as
/// JSON) and any remaining home-directory prefix with `~`.
fn sanitize_text(text: &str, roots: &[Root], home: Option<&str>) -> String {
    const KEY: &str = "\"locator\":\"";
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(KEY) {
        let value_start = start + KEY.len();
        out.push_str(&rest[..value_start]);
        let tail = &rest[value_start..];
        // Find the closing quote of the JSON string.
        let mut end = None;
        let mut escaped = false;
        for (i, c) in tail.char_indices() {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                end = Some(i);
                break;
            }
        }
        let Some(end) = end else {
            out.push_str(tail);
            rest = "";
            break;
        };
        let raw = &tail[..end];
        let replaced = serde_json::from_str::<String>(&format!("\"{raw}\""))
            .ok()
            .map(|decoded| {
                let safe =
                    serde_json::to_string(&privacy_locator(&decoded, roots)).unwrap_or_default();
                safe[1..safe.len() - 1].to_owned()
            })
            .unwrap_or_else(|| raw.to_owned());
        out.push_str(&replaced);
        rest = &tail[end..];
    }
    out.push_str(rest);
    match home
        .map(|h| h.trim_end_matches('/'))
        .filter(|h| h.len() > 1)
    {
        Some(home) => out.replace(home, "~"),
        None => out,
    }
}

fn is_identifier(key: &str) -> bool {
    key == "id" || key.ends_with("Id") || key.ends_with("Ids")
}

fn walk(value: &mut Value, key: &str, roots: &[Root], home: Option<&str>) {
    match value {
        Value::Object(map) => {
            for (k, v) in map.iter_mut() {
                if k == "locator" {
                    if let Value::String(s) = v {
                        *s = privacy_locator(s, roots);
                        continue;
                    }
                }
                walk(v, k, roots, home);
            }
        }
        Value::Array(items) => {
            for item in items {
                walk(item, key, roots, home);
            }
        }
        Value::String(s) if !is_identifier(key) => {
            if s.contains("\"locator\":\"") || home.is_some_and(|h| s.contains(h)) {
                *s = sanitize_text(s, roots, home);
            }
        }
        _ => {}
    }
}

/// Rewrites every locator in an outbound body (any depth, including the prompt).
pub fn sanitize_body(body: &mut Value, roots: &[Root], home: Option<&str>) {
    let home = home
        .map(|h| h.trim_end_matches('/'))
        .filter(|h| h.len() > 1);
    walk(body, "", roots, home);
}

/// Connected workspace folders from the public store, in raw and canonical form.
/// When the store cannot be read, no roots are known and every local locator
/// falls back to its file name.
#[cfg_attr(not(feature = "public"), allow(dead_code))]
pub fn connected_roots() -> Vec<Root> {
    let Ok(store) = crate::public_domain::PublicStore::open(&crate::commands::data_root()) else {
        return Vec::new();
    };
    let mut roots = Vec::new();
    for w in store.list_workspaces().unwrap_or_default() {
        let name = w["name"].as_str().unwrap_or("Workspace").to_owned();
        let paths = w["roots"]
            .as_array()
            .into_iter()
            .flatten()
            .chain(std::iter::once(&w["root"]))
            .filter_map(Value::as_str);
        for path in paths {
            roots.push(Root {
                name: name.clone(),
                path: path.to_owned(),
            });
            if let Ok(canonical) = std::fs::canonicalize(path) {
                let canonical = canonical.to_string_lossy().into_owned();
                if canonical != path {
                    roots.push(Root {
                        name: name.clone(),
                        path: canonical,
                    });
                }
            }
        }
    }
    roots
}

/// Sanitises with the user's connected folders and home directory.
#[cfg_attr(not(feature = "public"), allow(dead_code))]
pub fn sanitize_outbound(body: &mut Value) {
    let home = std::env::var("HOME").ok();
    sanitize_body(body, &connected_roots(), home.as_deref());
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn roots() -> Vec<Root> {
        vec![
            Root {
                name: "Client Work".into(),
                path: "/Users/jane.doe/Documents/Client Work".into(),
            },
            Root {
                name: "Nested".into(),
                path: "/Users/jane.doe/Documents/Client Work/Deep".into(),
            },
            Root {
                name: "Ünïcode".into(),
                path: "/Users/jane.doe/Bücher".into(),
            },
        ]
    }

    #[test]
    fn workspace_files_become_name_and_relative_path() {
        let r = roots();
        assert_eq!(
            privacy_locator(
                "/Users/jane.doe/Documents/Client Work/Plans/Q3 plan.md#Goals:part1",
                &r
            ),
            "Client Work/Plans/Q3 plan.md#Goals:part1"
        );
        // The longest matching root wins.
        assert_eq!(
            privacy_locator("/Users/jane.doe/Documents/Client Work/Deep/a.txt", &r),
            "Nested/a.txt"
        );
        assert_eq!(
            privacy_locator("/Users/jane.doe/Bücher/Café notes.md#Über:part2", &r),
            "Ünïcode/Café notes.md#Über:part2"
        );
        // A sibling folder that merely shares a prefix is not inside the root.
        assert_eq!(
            privacy_locator("/Users/jane.doe/Documents/Client Work 2/x.md", &r),
            "x.md"
        );
    }

    #[test]
    fn other_local_files_keep_only_the_file_name() {
        let r = roots();
        assert_eq!(
            privacy_locator("/Users/jane.doe/Downloads/cv final.pdf#page 2:part3", &r),
            "cv final.pdf#page 2:part3"
        );
        assert_eq!(privacy_locator("~/notes/today.md", &r), "today.md");
        assert_eq!(
            privacy_locator("file:///Users/jane.doe/My%20Docs/a%20b.txt", &r),
            "a b.txt"
        );
        assert_eq!(
            privacy_locator("C:\\Users\\jane\\Documents\\report.docx", &r),
            "report.docx"
        );
        assert_eq!(
            privacy_locator("\\\\server\\share\\deck.pptx", &r),
            "deck.pptx"
        );
        assert_eq!(
            privacy_locator("/Users/jane.doe/~lock.docx", &r),
            "./~lock.docx"
        );
        for out in [
            privacy_locator("/Users/jane.doe/Downloads/cv.pdf", &[]),
            privacy_locator(
                "/Volumes/Data/Users/jane/x.md",
                &[Root {
                    name: "Data".into(),
                    path: "/Volumes/Data".into(),
                }],
            ),
        ] {
            assert!(!looks_local(&out), "{out}");
            assert!(!out.contains("jane"), "{out}");
        }
    }

    #[test]
    fn urls_drop_credentials_query_and_fragment() {
        let r = roots();
        assert_eq!(
            privacy_locator(
                "https://user:pw@example.com/a/b?token=abc&sig=xyz#access_token=1",
                &r
            ),
            "https://example.com/a/b"
        );
        assert_eq!(
            privacy_locator("http://example.org/", &r),
            "http://example.org/"
        );
        assert_eq!(
            privacy_locator("meeting:m1#through:4", &r),
            "meeting:m1#through:4"
        );
    }

    #[test]
    fn bodies_carry_no_absolute_path_or_user_name() {
        let path = "/Users/jane.doe/Documents/Client Work/Plans/plan.md#Goals:part1";
        let outside = "/Users/jane.doe/Desktop/secret.txt";
        let hit = json!({"sourceId":"s1","workspaceId":"w","kind":"workspace","title":"plan.md","text":"t","locator":path,"revision":1,"derived":false});
        let other = json!({"sourceId":"s2","workspaceId":"w","kind":"workspace","title":"secret.txt","text":"t","locator":outside,"revision":1,"derived":false});
        let context = json!({"purpose":"p","sources":[hit.clone(), other.clone()]});
        let mut reasoning = json!({
            "job":{"id":"j","basis":{"snapshot":{"context":context.clone(),"candidates":[{"basis":{"snapshot":{"context":context.clone()}}}]},"invalidatedSourceIds":["s1"]}},
            "prompt": format!("Evidence: {}. Saved under /Users/jane.doe/Desktop.", serde_json::to_string(&[hit.clone(), other.clone()]).unwrap()),
        });
        let mut decide = json!({"basis":{"snapshot":{"context":context.clone()}},"effectiveContext":context,"questions":{}});
        for body in [&mut reasoning, &mut decide] {
            sanitize_body(body, &roots(), Some("/Users/jane.doe/"));
            let text = body.to_string();
            assert!(!text.contains("/Users/"), "{text}");
            assert!(!text.contains("jane"), "{text}");
            assert!(text.contains("Client Work/Plans/plan.md#Goals:part1"));
        }
        for sources in [
            &reasoning["job"]["basis"]["snapshot"]["context"]["sources"],
            &decide["effectiveContext"]["sources"],
        ] {
            assert_eq!(
                sources[0]["locator"],
                "Client Work/Plans/plan.md#Goals:part1"
            );
            assert_eq!(sources[1]["locator"], "secret.txt");
        }
        // Identifiers are never rewritten: cards map back by sourceId.
        assert_eq!(
            reasoning["job"]["basis"]["snapshot"]["context"]["sources"][0]["sourceId"],
            "s1"
        );
        assert_eq!(reasoning["job"]["basis"]["invalidatedSourceIds"][0], "s1");
        assert!(reasoning["prompt"]
            .as_str()
            .unwrap()
            .contains("Saved under ~/Desktop."));
    }

    #[test]
    fn sanitising_is_idempotent() {
        let mut once = json!({"locator":"/Users/jane.doe/Documents/Client Work/a.md","prompt":"{\"locator\":\"https://x.org/p?q=1\"}"});
        sanitize_body(&mut once, &roots(), Some("/Users/jane.doe"));
        let mut twice = once.clone();
        sanitize_body(&mut twice, &roots(), Some("/Users/jane.doe"));
        assert_eq!(once, twice);
        assert_eq!(once["prompt"], "{\"locator\":\"https://x.org/p\"}");
    }
}
