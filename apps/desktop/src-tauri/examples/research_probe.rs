#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let start = std::time::Instant::now();
    let result = live_interview_lib::research::search_public_text(
        "FINMA artificial intelligence governance guidance".into(),
        "synthetic".into(),
    )
    .await;
    let value = match result {
        Ok(hits) => {
            serde_json::json!({"kind":"syntheticPublicResearch","outcome":if hits.is_empty(){"noEvidence"}else{"complete"},"elapsedMs":start.elapsed().as_millis(),"sources":hits.iter().map(|h|serde_json::json!({"title":h["title"],"locator":h["locator"],"chars":h["text"].as_str().unwrap_or("").len()})).collect::<Vec<_>>()})
        }
        Err(code) => {
            serde_json::json!({"kind":"syntheticPublicResearch","outcome":"unavailable","code":code,"elapsedMs":start.elapsed().as_millis()})
        }
    };
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../docs/acceptance/public-research-probe.json");
    std::fs::write(path, serde_json::to_vec_pretty(&value)?)?;
    println!("{}", value);
    Ok(())
}
