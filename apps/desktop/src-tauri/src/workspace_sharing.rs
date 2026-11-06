use serde_json::{json, Value};
use std::fs;
fn fields(v: &Value, keys: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|m| m.keys().all(|k| keys.contains(&k.as_str())))
}
fn array_fields(v: &Value, keys: &[&str]) -> bool {
    v.is_null()
        || v.as_array()
            .is_some_and(|a| a.iter().all(|x| fields(x, keys)))
}
fn valid_bundle(bundle: &Value) -> bool {
    fields(bundle, &["version", "records", "sources"])
        && bundle["records"].as_array().is_some_and(|rs| {
            rs.iter().all(|r| {
                fields(
                    r,
                    &[
                        "id",
                        "workspaceId",
                        "purpose",
                        "date",
                        "objectives",
                        "attendees",
                        "brief",
                        "profileId",
                        "profileRevision",
                        "scheduledEndMs",
                        "revision",
                        "segments",
                        "importedSegments",
                        "attributions",
                        "translationStatus",
                        "fixtureMode",
                        "pendingSegments",
                    ],
                ) && array_fields(&r["attendees"], &["id", "name"])
                    && (r["brief"].is_null()
                        || fields(&r["brief"], &["revision", "text", "objectives", "evidence"]))
                    && array_fields(
                        &r["segments"],
                        &[
                            "meetingId",
                            "segmentId",
                            "revision",
                            "journalSequence",
                            "lane",
                            "startMs",
                            "endMs",
                            "language",
                            "text",
                            "kind",
                            "sourceSegmentId",
                            "speakerClusterId",
                            "confidence",
                        ],
                    )
                    && array_fields(
                        &r["importedSegments"],
                        &[
                            "id",
                            "text",
                            "language",
                            "provenance",
                            "sourceId",
                            "speakerLabel",
                        ],
                    )
                    && array_fields(
                        &r["attributions"],
                        &[
                            "clusterId",
                            "personId",
                            "status",
                            "evidence",
                            "confirmedByUser",
                        ],
                    )
            })
        })
        && bundle["sources"].as_array().is_some_and(|ss| {
            ss.iter().all(|s| {
                fields(
                    s,
                    &[
                        "sourceId",
                        "workspaceId",
                        "kind",
                        "title",
                        "text",
                        "locator",
                        "revision",
                        "derived",
                    ],
                )
            })
        })
}
fn reject_private(v: &Value) -> bool {
    match v {
        Value::Object(m) => m.iter().any(|(k, v)| {
            let key = k.to_lowercase();
            key.contains("credential")
                || key.contains("apikey")
                || key.contains("api_key")
                || key.contains("audio")
                || key.contains("provider_settings")
                || key.contains("providersettings")
                || key.contains("accesstoken")
                || key.contains("refreshtoken")
                || reject_private(v)
        }),
        Value::Array(a) => a.iter().any(reject_private),
        _ => false,
    }
}
pub fn import(root: &std::path::Path, bundle: &Value) -> anyhow::Result<Value> {
    anyhow::ensure!(
        bundle["version"] == 1 && valid_bundle(bundle) && !reject_private(bundle),
        "invalidOrPrivateBundle"
    );
    let records = bundle["records"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("invalidBundle"))?;
    anyhow::ensure!(records.len() <= 1000, "bundleTooLarge");
    let store = crate::meeting_records::RecordStore::open(root)?;
    let (mut imported, mut duplicates, mut conflicts) = (0, 0, 0);
    let mut unresolved = Vec::new();
    for record in records {
        let id = record["id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("invalidRecord"))?;
        anyhow::ensure!(crate::meeting_records::valid_id(id), "invalidRecordId");
        let events = record["segments"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("invalidRecord"))?;
        for e in events {
            anyhow::ensure!(
                e["meetingId"] == id
                    && matches!(e["lane"].as_str(), Some("me" | "remote"))
                    && matches!(
                        e["kind"].as_str(),
                        Some("partial" | "final" | "translation")
                    ),
                "invalidSpeechProvenance"
            );
        }
        if let Ok(local) = store.load(id) {
            let comparable = |v: &Value| {
                let mut c = v.clone();
                if let Some(map) = c.as_object_mut() {
                    map.remove("audioReference");
                    map.remove("pendingSegments");
                    map.remove("canonicalEnglishPath");
                }
                if let Some(segments) = c["segments"].as_array_mut() {
                    for event in segments {
                        if let Some(map) = event.as_object_mut() {
                            map.remove("journalSequence");
                        }
                    }
                }
                c
            };
            if comparable(&local) == comparable(record) {
                duplicates += 1
            } else {
                let dir = crate::owned_paths::directory(root, &["conflicts", id], true)?;
                crate::meeting_records::atomic_write(
                    &dir.join(format!("{}.json", uuid::Uuid::new_v4())),
                    &serde_json::to_vec_pretty(record)?,
                )?;
                conflicts += 1
            }
            continue;
        }
        store.create(id, record)?;
        for event in events {
            store.append_event(event)?;
        }
        store.finish(id)?;
        imported += 1;
    }
    let index = crate::context_sources::SourceIndex::open(root)?;
    let mut sources_imported = 0;
    for source in bundle["sources"].as_array().into_iter().flatten() {
        if !source["text"].is_string() || !source["workspaceId"].is_string() {
            unresolved.push(source["locator"].clone());
            continue;
        }
        match index.import_portable_source(source)? {
            "imported" => sources_imported += 1,
            "conflict" => conflicts += 1,
            _ => {}
        }
        if source["locator"]
            .as_str()
            .is_some_and(|p| p.starts_with('/'))
        {
            unresolved.push(source["locator"].clone())
        }
    }
    Ok(
        json!({"sourcesImported":sources_imported,"imported":imported,"skipped":duplicates,"conflicts":conflicts,"unresolved":unresolved,"errors":[]}),
    )
}
#[tauri::command]
pub fn export_workspace_bundle(bundle: Value) -> Result<Value, String> {
    if bundle["version"] != 1
        || !valid_bundle(&bundle)
        || reject_private(&bundle)
        || bundle.to_string().len() > 64_000_000
    {
        return Err("invalidOrPrivateBundle".into());
    }
    let root =
        crate::owned_paths::directory(&crate::commands::data_root(), &["sharing-outbox"], true)
            .map_err(|_| "exportFailed")?;
    let path = root.join(format!("{}.liveinterview.json", uuid::Uuid::new_v4()));
    crate::meeting_records::atomic_write(
        &path,
        &serde_json::to_vec_pretty(&bundle).map_err(|_| "exportFailed")?,
    )
    .map_err(|_| "exportFailed")?;
    Ok(
        json!({"path":path.to_string_lossy(),"records":bundle["records"].as_array().map(Vec::len).unwrap_or(0)}),
    )
}
#[tauri::command]
pub fn import_workspace_bundle(path: String) -> Result<Value, String> {
    let path = std::path::Path::new(&path);
    if fs::metadata(path).map_err(|_| "importFailed")?.len() > 64_000_000 {
        return Err("bundleTooLarge".into());
    }
    let bundle: Value = serde_json::from_slice(&fs::read(path).map_err(|_| "importFailed")?)
        .map_err(|_| "invalidBundle")?;
    import(&crate::commands::data_root(), &bundle).map_err(|_| "invalidOrPrivateBundle".into())
}
