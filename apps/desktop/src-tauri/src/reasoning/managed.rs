use super::{jobs, protocol};
use crate::public_service;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
/// Set once the service answers that it has no streaming route; the rest of the
/// session then goes straight to `/v1/reasoning`.
static STREAMING_UNSUPPORTED: AtomicBool = AtomicBool::new(false);
/// Only live guidance streams: preparation and synthesis have no use for a first
/// token and keep the single-body route.
fn streams_first_token(job: &Value) -> bool {
    matches!(job["usageFeature"].as_str(), None | Some("live"))
        && !STREAMING_UNSUPPORTED.load(Ordering::SeqCst)
}
use std::time::{Duration, Instant};
use tauri::{ipc::Channel, State};
#[derive(Default)]
pub struct ReasoningState {
    jobs: Mutex<jobs::JobRegistry>,
    verified: AtomicBool,
    last_usage: Mutex<Value>,
}
#[tauri::command]
pub async fn connect_reasoning(
    _state: State<'_, ReasoningState>,
    _provider: String,
    _jev_key: Option<String>,
    _ibm_account: Option<String>,
) -> Result<Value, String> {
    Err("managedServiceOnly".into())
}
#[tauri::command]
pub fn list_ibm_profiles() -> Result<Vec<Value>, String> {
    Ok(vec![])
}
#[tauri::command]
pub async fn read_personal_quota() -> Result<Value, String> {
    Err("personalProviderUnavailable".into())
}
#[tauri::command]
pub fn reasoning_status(state: State<ReasoningState>) -> Value {
    let verified = state.verified.load(Ordering::SeqCst);
    let connected = public_service::session_available();
    json!({"managed":true,"ibmSolUnavailableUntilMs":0,"lastUsage":state.last_usage.lock().map(|v|v.clone()).unwrap_or(Value::Null),"ibm":{"configured":connected,"reachable":verified,"inferenceVerified":verified},"jev":{"configured":connected,"reachable":verified,"inferenceVerified":verified},"codex":{"configured":false,"reachable":false,"inferenceVerified":false}})
}
#[tauri::command]
pub fn reasoning_cancel(state: State<ReasoningState>, job_id: String) {
    if let Ok(mut jobs) = state.jobs.lock() {
        jobs.cancel(&job_id, Instant::now());
    }
}
/// The wire shape of a provisional update: `{"delta": text}` or `{"reset": true}`.
fn draft_message(update: public_service::StreamUpdate) -> Value {
    match update {
        public_service::StreamUpdate::Delta(text) => json!({ "delta": text }),
        public_service::StreamUpdate::Reset => json!({ "reset": true }),
    }
}
#[tauri::command]
pub async fn reasoning_run(
    state: State<'_, ReasoningState>,
    job: Value,
    prompt: String,
    on_draft: Channel<Value>,
) -> Result<Value, String> {
    run_reasoning(
        &state,
        public_service::Caller::SignedIn,
        job,
        prompt,
        &mut |message| {
            let _ = on_draft.send(message);
        },
    )
    .await
}
/// `reasoning_run` without the Tauri runtime: `on_draft` receives the same
/// provisional `{"delta"}`/`{"reset"}` messages the renderer's channel gets.
pub async fn run_reasoning(
    state: &ReasoningState,
    caller: public_service::Caller<'_>,
    job: Value,
    prompt: String,
    on_draft: &mut (dyn FnMut(Value) + Send),
) -> Result<Value, String> {
    protocol::validate_text_job(&job).map_err(|_| "textOnlyBoundary")?;
    // UTF-8 bytes are never fewer than the UTF-16 units the service counts.
    if prompt.len() > MAX_PROMPT_BYTES {
        return Err("jobTooLarge".into());
    }
    // Locators leave the Mac in privacy-safe form only (see locator.rs); the
    // service's echo is checked against this outbound copy and the renderer
    // gets back the basis it asked with.
    let mut body = json!({"job":job,"prompt":prompt});
    super::locator::sanitize_outbound(&mut body);
    let mut body = fit_body(body, "/job/basis", true)?;
    let id = job["id"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 128)
        .ok_or("invalidJob")?
        .to_owned();
    let cancelled = state
        .jobs
        .lock()
        .map_err(|_| "reasoningUnavailable")?
        .register(&id, Instant::now())?;
    let basis = job["basis"].clone();
    let provider = if job["lane"] == "deep" {
        "managedDeep"
    } else {
        "managedFast"
    };
    // The first link of the service's deadline chain (apps/service/src/deadlines.mjs):
    // the app waits at most 60 s, below the service's 90 s provider budget.
    let remaining = job["deadlineMs"]
        .as_u64()
        .unwrap_or(0)
        .saturating_sub(public_service::now_ms())
        .min(60_000);
    relative_timeout(&mut body, remaining);
    let failure = |outcome: &str, code: &str| json!({"jobId":id,"provider":provider,"model":"managed","basis":basis,"outcome":outcome,"output":null,"code":code});
    if cancelled.load(Ordering::SeqCst) || remaining == 0 {
        state
            .jobs
            .lock()
            .map_err(|_| "reasoningUnavailable")?
            .finish(&id);
        return Ok(failure(
            if cancelled.load(Ordering::SeqCst) {
                "cancelled"
            } else {
                "failure"
            },
            "deadlineOrCancelled",
        ));
    }
    let timeout = Duration::from_millis(remaining);
    let request = async {
        if streams_first_token(&job) {
            // Provisional text for display only; it never enters the returned value.
            let mut forward = |update: public_service::StreamUpdate| {
                on_draft(draft_message(update));
            };
            match caller.reasoning_stream(&body, timeout, &mut forward).await {
                Err(code) if code == "streamUnsupported" => {
                    STREAMING_UNSUPPORTED.store(true, Ordering::SeqCst)
                }
                streamed => return streamed.map(|s| (s.value, s.first_token_ms)),
            }
        }
        caller
            .request(reqwest::Method::POST, "/v1/reasoning", Some(&body), timeout)
            .await
            .map(|value| (value, None))
    };
    let result = tokio::select! {biased;_=async{while !cancelled.load(Ordering::SeqCst){tokio::time::sleep(Duration::from_millis(20)).await;}}=>Err("cancelled".into()),_=tokio::time::sleep(Duration::from_millis(remaining))=>Err("deadline".into()),result=request=>result};
    state
        .jobs
        .lock()
        .map_err(|_| "reasoningUnavailable")?
        .finish(&id);
    if cancelled.load(Ordering::SeqCst) {
        return Ok(failure("cancelled", "cancelled"));
    }
    match result {
        Ok((mut value, first_token_ms)) => {
            // The service echoes the basis it was sent (possibly trimmed); the
            // renderer gets back the basis it asked with.
            public_service::validate_model_result(&body["job"], &value)?;
            value["basis"] = basis.clone();
            // Timing only, added after validation; the renderer feeds it to the latency trace.
            if let Some(ms) = first_token_ms {
                value["timing"] = json!({ "firstTokenMs": ms });
            }
            if value["outcome"] == "complete" {
                state.verified.store(true, Ordering::SeqCst);
                if let Ok(mut usage) = state.last_usage.lock() {
                    *usage = value["usage"].clone();
                }
            }
            Ok(value)
        }
        Err(code) => Ok(failure(
            if code == "cancelled" {
                "cancelled"
            } else {
                "failure"
            },
            &code,
        )),
    }
}
/// The service measures a relative `timeoutMs` on its own clock; the renderer's
/// absolute `deadlineMs` (this Mac's clock) is not sent, so clock skew between
/// the Mac and the service cannot expire or reject a job.
fn relative_timeout(body: &mut Value, remaining_ms: u64) {
    if let Some(job) = body["job"].as_object_mut() {
        job.remove("deadlineMs");
        job.insert("timeoutMs".into(), json!(remaining_ms));
    }
}
/// The service refuses prompts over 200,000 characters and bodies over 256 KiB
/// (apps/service/src/validation.mjs, app.mjs); stay below both with margin.
const MAX_PROMPT_BYTES: usize = 200_000;
const MAX_BODY_BYTES: usize = 240_000;
fn body_len(body: &Value) -> usize {
    serde_json::to_vec(body).map(|b| b.len()).unwrap_or(usize::MAX)
}
/// Fits a request body under `MAX_BODY_BYTES` by dropping what the service does
/// not read: first the snapshot's prepared candidate cards (each carries its own
/// basis), then, for reasoning only, the source texts kept in the basis (the
/// prompt already carries the evidence; ids and revisions stay for provenance).
/// A decision keeps its source texts, as the service decides on that context.
fn fit_body(mut body: Value, basis: &str, reasoning: bool) -> Result<Value, String> {
    if body_len(&body) <= MAX_BODY_BYTES {
        return Ok(body);
    }
    if let Some(candidates) = body.pointer_mut(&format!("{basis}/snapshot/candidates")) {
        *candidates = json!([]);
    }
    if reasoning && body_len(&body) > MAX_BODY_BYTES {
        if let Some(Value::Array(sources)) =
            body.pointer_mut(&format!("{basis}/snapshot/context/sources"))
        {
            for source in sources {
                source["text"] = json!("");
            }
        }
    }
    if body_len(&body) <= MAX_BODY_BYTES {
        Ok(body)
    } else {
        Err("jobTooLarge".into())
    }
}
/// The `/v1/decide` body. Without an effective context the field is left out
/// and the service decides on the basis snapshot's own context; the basis is
/// never sent in its place (it is not a context and the service rejects it).
fn decide_body(basis: &Value, effective_context: Option<&Value>, questions: &Value) -> Value {
    let mut body = json!({"basis":basis,"questions":questions});
    if let Some(context) = effective_context {
        body["effectiveContext"] = context.clone();
    }
    body
}
#[tauri::command]
pub async fn jev_decide(
    state: State<'_, ReasoningState>,
    basis: Value,
    effective_context: Option<Value>,
    questions: Value,
) -> Result<Value, String> {
    decide(
        &state,
        public_service::Caller::SignedIn,
        basis,
        effective_context,
        questions,
    )
    .await
}
/// `jev_decide` without the Tauri runtime.
pub async fn decide(
    state: &ReasoningState,
    caller: public_service::Caller<'_>,
    basis: Value,
    effective_context: Option<Value>,
    questions: Value,
) -> Result<Value, String> {
    protocol::validate_text_job(&basis).map_err(|_| "textOnlyBoundary")?;
    if let Some(context) = &effective_context {
        protocol::validate_text_job(context).map_err(|_| "textOnlyBoundary")?;
    }
    let mut body = decide_body(&basis, effective_context.as_ref(), &questions);
    super::locator::sanitize_outbound(&mut body);
    let body = fit_body(body, "/basis", false)?;
    let mut result = caller
        .request(
            reqwest::Method::POST,
            "/v1/decide",
            Some(&body),
            Duration::from_secs(10),
        )
        .await?;
    if result["basis"] != body["basis"] || !result["answers"].is_object() {
        return Err("invalidDecision".into());
    }
    result["basis"] = basis;
    state.verified.store(true, Ordering::SeqCst);
    Ok(result)
}
#[tauri::command]
pub async fn test_reasoning_connection(
    _state: State<'_, ReasoningState>,
    _route: String,
) -> Result<Value, String> {
    Err("useProductServiceStatus".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn the_service_gets_a_relative_timeout_and_never_this_macs_clock() {
        let mut body = json!({"job":{"id":"a","deadlineMs":1_900_000_000_000u64},"prompt":"p"});
        relative_timeout(&mut body, 42_000);
        assert_eq!(body["job"], json!({"id":"a","timeoutMs":42_000}));
        assert_eq!(body["prompt"], "p");
    }
    #[test]
    fn only_live_guidance_streams() {
        assert!(streams_first_token(&json!({"id":"a"})));
        assert!(streams_first_token(&json!({"usageFeature":"live"})));
        for other in ["preparation", "automaticPreparation", "synthesis"] {
            assert!(!streams_first_token(&json!({"usageFeature":other})));
        }
    }
    #[test]
    fn draft_messages_carry_only_text_or_a_reset() {
        use public_service::StreamUpdate;
        assert_eq!(
            draft_message(StreamUpdate::Delta("{\"say\"".into())),
            json!({"delta":"{\"say\""})
        );
        assert_eq!(draft_message(StreamUpdate::Reset), json!({"reset":true}));
    }
    #[test]
    fn decide_body_never_sends_the_basis_as_the_context() {
        let basis = json!({"snapshot":{"context":{"purpose":"p"}}});
        let questions = json!({"q":{"type":"noul","instructions":"i"}});
        let without = decide_body(&basis, None, &questions);
        assert!(without.get("effectiveContext").is_none());
        assert_eq!(without["basis"], basis);
        let context = json!({"purpose":"p2"});
        let with = decide_body(&basis, Some(&context), &questions);
        assert_eq!(with["effectiveContext"], context);
    }
    fn large_basis(source_bytes: usize, candidate_bytes: usize) -> Value {
        json!({"snapshot":{
            "context":{"sources":[{"sourceId":"s","text":"x".repeat(source_bytes),"revision":1}]},
            "candidates":[{"id":"c","say":"y".repeat(candidate_bytes)}]
        }})
    }
    #[test]
    fn small_bodies_are_sent_unchanged() {
        let body = json!({"job":{"basis":large_basis(10, 10)},"prompt":"p"});
        assert_eq!(fit_body(body.clone(), "/job/basis", true).unwrap(), body);
    }
    #[test]
    fn large_bodies_drop_candidates_then_basis_source_texts() {
        let body = json!({"job":{"basis":large_basis(10, 300_000)},"prompt":"p"});
        let fitted = fit_body(body, "/job/basis", true).unwrap();
        assert_eq!(fitted["job"]["basis"]["snapshot"]["candidates"], json!([]));
        assert_eq!(fitted["job"]["basis"]["snapshot"]["context"]["sources"][0]["text"], "x".repeat(10));
        let body = json!({"job":{"basis":large_basis(300_000, 10)},"prompt":"p"});
        let fitted = fit_body(body, "/job/basis", true).unwrap();
        assert_eq!(fitted["job"]["basis"]["snapshot"]["context"]["sources"][0]["text"], "");
        assert_eq!(fitted["job"]["basis"]["snapshot"]["context"]["sources"][0]["sourceId"], "s");
        assert!(body_len(&fitted) <= MAX_BODY_BYTES);
    }
    #[test]
    fn decisions_keep_their_source_texts_and_refuse_when_still_too_large() {
        let body = json!({"basis":large_basis(300_000, 10),"questions":{}});
        assert_eq!(fit_body(body, "/basis", false).unwrap_err(), "jobTooLarge");
        let prompt = json!({"job":{"basis":large_basis(10, 10)},"prompt":"p".repeat(MAX_BODY_BYTES)});
        assert_eq!(fit_body(prompt, "/job/basis", true).unwrap_err(), "jobTooLarge");
    }
    #[test]
    fn client_caps_stay_below_the_service_limits() {
        // validation.mjs: prompt <= 200,000 characters; app.mjs: body <= 262,144 bytes.
        assert!(MAX_PROMPT_BYTES <= 200_000);
        assert!(MAX_BODY_BYTES < 262_144);
    }
    #[test]
    fn public_build_never_discovers_private_profiles() {
        assert!(list_ibm_profiles().unwrap().is_empty());
    }
    #[tokio::test]
    async fn public_build_never_reads_personal_quota() {
        assert_eq!(
            read_personal_quota().await.unwrap_err(),
            "personalProviderUnavailable"
        );
    }
}
