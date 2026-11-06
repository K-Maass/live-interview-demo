use live_interview_lib::context_sources::SourceIndex;
use serde_json::{json, Value};
fn main() -> anyhow::Result<()> {
    let input: Value = serde_json::from_slice(&std::fs::read(
        std::env::args().nth(1).expect("fixture JSON"),
    )?)?;
    let root = std::env::temp_dir().join(format!("live-retrieval-probe-{}", uuid::Uuid::new_v4()));
    let docs = root.join("corpus");
    std::fs::create_dir_all(&docs)?;
    for row in input["documents"].as_array().unwrap() {
        std::fs::write(
            docs.join(row["title"].as_str().unwrap()),
            row["text"].as_str().unwrap(),
        )?;
    }
    let index = SourceIndex::open(&root)?;
    index.connect("synthetic", &docs)?;
    index.refresh("synthetic")?;
    let mut entries = Vec::new();
    for row in index.pending_embeddings("synthetic", 128)? {
        if let Some(found) = input["embeddings"].as_array().unwrap().iter().find(|e| {
            e["title"]
                == row["locator"]
                    .as_str()
                    .unwrap()
                    .split('/')
                    .next_back()
                    .unwrap()
                    .split('#')
                    .next()
                    .unwrap()
        }) {
            let mut e = row;
            e["language"] = found["language"].clone();
            e["vector"] = found["vector"].clone();
            entries.push(e);
        }
    }
    // Map every section, including those beyond the bounded work queue, to its independently computed fixture embedding.
    let db = rusqlite::Connection::open(root.join("context.sqlite"))?;
    let mut q = db.prepare("SELECT source_id,locator,revision,title FROM source_fts")?;
    for row in q.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, String>(3)?,
        ))
    })? {
        let (id, locator, revision, title) = row?;
        if let Some(v) = input["embeddings"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["title"] == title)
        {
            entries.push(json!({"sourceId":id,"locator":locator,"revision":revision,"language":v["language"],"vector":v["vector"]}));
        }
    }
    index.save_embeddings(&entries)?;
    let mut rows = Vec::new();
    for case in input["cases"].as_array().unwrap() {
        let vectors = case["vectors"].as_array().unwrap();
        let semantic = index.retrieve_ranked(
            "synthetic",
            case["expandedQuery"].as_str().unwrap(),
            vectors,
            5,
        )?;
        let lexical = index.retrieve("synthetic", case["expandedQuery"].as_str().unwrap(), 5)?;
        let found = semantic.iter().any(|h| h["title"] == case["expected"]);
        rows.push(json!({"query":case["query"],"expected":case["expected"],"top5":semantic.iter().map(|h|h["title"].clone()).collect::<Vec<_>>(),"lexicalTop5":lexical.iter().map(|h|h["title"].clone()).collect::<Vec<_>>(),"pass":found}));
    }
    let report = json!({"kind":"syntheticBilingualRetrieval","corpusSize":input["documents"].as_array().unwrap().len(),"network":"denied in embedding/translation helper","rows":rows,"allPass":rows.iter().all(|r|r["pass"]==true)});
    let target = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../docs/acceptance/bilingual-retrieval.json");
    std::fs::write(target, serde_json::to_vec_pretty(&report)?)?;
    std::fs::remove_dir_all(root)?;
    anyhow::ensure!(report["allPass"] == true, "bilingualTopFiveFailed");
    println!(
        "Synthetic bilingual retrieval: all {} cases passed",
        rows.len()
    );
    Ok(())
}
