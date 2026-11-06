//! Wire test: the real desktop client code against the real managed service.
//!
//! Unit tests on each side mock the other, so a field the service whitelist
//! rejects, or a shape one side reads differently, passes both suites. Here the
//! Rust client (device sign-in, `run_reasoning`, `decide`, error mapping) talks
//! to `apps/service` running in a child process
//! (`tests/fixtures/service-wire-harness.ts`) with a fixture identity provider,
//! a fixture billing stand-in and a fake model provider; the request payloads
//! come from the real `packages/core` code the renderer uses, and the card the
//! renderer would show is parsed back by that code. Only loopback is used.
//!
//! Needs `node` on PATH and the npm dependencies (`npm ci`); without them the
//! test is skipped with a message, unless `SERVICE_WIRE_REQUIRED=1`.
use live_interview_lib::public_service::{
    billing_url, device_sign_in, now_ms, renew_session, sanitize_account, sign_out_all, Caller,
    ServiceClient, Session,
};
use live_interview_lib::reasoning::{decide, run_reasoning, ReasoningState};
use reqwest::Method;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout};

struct Harness {
    _child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
}
impl Harness {
    async fn next(&mut self) -> Value {
        loop {
            let line = self
                .lines
                .next_line()
                .await
                .unwrap()
                .expect("service harness exited; see its stderr above");
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                return value;
            }
        }
    }
    async fn ask(&mut self, command: Value) -> Value {
        self.stdin
            .write_all(format!("{command}\n").as_bytes())
            .await
            .unwrap();
        self.stdin.flush().await.unwrap();
        let answer = self.next().await;
        assert!(answer.get("error").is_none(), "harness: {answer}");
        answer
    }
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

/// Why the test cannot run here, if it cannot.
fn missing_prerequisite() -> Option<String> {
    let node = std::process::Command::new("node")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success());
    if !node {
        return Some("`node` is not on PATH".into());
    }
    if !repo_root().join("node_modules/.bin/vite-node").exists() {
        return Some("npm dependencies are missing (run `npm ci`)".into());
    }
    None
}

/// What a person does in the browser: open the verification page, type the code
/// the app shows, sign in at the (fixture) identity provider and approve.
async fn approve_in_browser(verification: &str, user_code: &str) {
    let browser = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let origin = verification.trim_end_matches("/auth/device");
    let csrf = |html: &str| {
        let start = html.find("name=\"csrf\" value=\"").expect("csrf field") + 19;
        html[start..start + html[start..].find('"').unwrap()].to_owned()
    };
    let form = |path: &str, cookie: Option<&str>, fields: &[(&str, &str)]| {
        let mut request = browser.post(format!("{origin}{path}")).form(fields);
        if let Some(cookie) = cookie {
            request = request.header("cookie", cookie);
        }
        request.send()
    };
    let page = browser.get(verification).send().await.unwrap();
    assert_eq!(page.status(), 200);
    assert!(
        !page.text().await.unwrap().contains(user_code),
        "the browser page is never prefilled with the code"
    );
    let typed = form("/auth/device", None, &[("user_code", user_code)])
        .await
        .unwrap();
    assert_eq!(typed.status(), 200, "the typed code is accepted");
    let cookie = typed.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let html = typed.text().await.unwrap();
    assert!(html.contains(user_code));
    let authorize = form("/auth/device/authorize", Some(&cookie), &[("csrf", &csrf(&html))])
        .await
        .unwrap();
    assert_eq!(authorize.status(), 302);
    let location = url::Url::parse(authorize.headers()["location"].to_str().unwrap()).unwrap();
    let state = location
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    let callback = browser
        .get(format!("{origin}/auth/callback?code=wire&state={state}"))
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(callback.status(), 200);
    let html = callback.text().await.unwrap();
    let approve = form("/auth/device/approve", Some(&cookie), &[("csrf", &csrf(&html))])
        .await
        .unwrap();
    assert_eq!(approve.status(), 200);
}

/// Signs in through the app's device flow and subscribes (fixture billing).
async fn sign_in(client: &ServiceClient) -> Session {
    let session = sign_in_only(client).await;
    let checkout = client
        .request(
            Method::POST,
            "/v1/billing/checkout",
            Some(&json!({"plan":"premium"})),
            Some(&session.session_token),
            Duration::from_secs(10),
        )
        .await
        .expect("checkout");
    billing_url(checkout["url"].as_str().unwrap()).expect("checkout URL accepted by the app");
    session
}

/// The device flow alone, as on a second Mac of an account that is already subscribed.
async fn sign_in_only(client: &ServiceClient) -> Session {
    let (shown, code) = tokio::sync::oneshot::channel::<(String, String)>();
    let show = move |user_code: &str, expires: u64, verification: String| {
        assert!(expires > now_ms());
        let _ = shown.send((user_code.to_owned(), verification));
        Ok(())
    };
    let browser = async {
        let (user_code, verification) = code.await.unwrap();
        // The code the person reads off the app and types: XXXX-XXXX.
        assert!(
            user_code.len() == 9
                && user_code.as_bytes()[4] == b'-'
                && user_code.chars().all(|c| c == '-' || c.is_ascii_alphanumeric()),
            "{user_code}"
        );
        approve_in_browser(&verification, &user_code).await;
    };
    let (session, ()) = tokio::join!(device_sign_in(client, show, || Ok(true)), browser);
    let session = session.expect("device sign-in");
    assert!(session.session_token.len() >= 32 && session.expires_at_ms > now_ms());
    session
}

async fn account(client: &ServiceClient, token: &str) -> Value {
    sanitize_account(
        &client
            .request(Method::GET, "/v1/account", None, Some(token), Duration::from_secs(10))
            .await
            .expect("account"),
    )
}

/// A fresh copy of the renderer's job: new id and deadline, as each hotkey makes.
fn fresh(job: &Value, id: &str) -> Value {
    let mut job = job.clone();
    job["id"] = json!(id);
    job["deadlineMs"] = json!(now_ms() + 30_000);
    job
}

async fn run(
    state: &ReasoningState,
    caller: Caller<'_>,
    job: &Value,
    prompt: &str,
) -> (Value, Vec<Value>) {
    let mut drafts = Vec::new();
    let result = run_reasoning(state, caller, job.clone(), prompt.to_owned(), &mut |d| {
        drafts.push(d)
    })
    .await
    .expect("run_reasoning returns a result value");
    (result, drafts)
}

fn assert_failure(result: &Value, code: &str) {
    assert_eq!(result["outcome"], "failure", "{result}");
    assert_eq!(result["code"], code, "{result}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn desktop_client_and_managed_service_agree_on_the_wire() {
    if let Some(reason) = missing_prerequisite() {
        assert!(
            std::env::var_os("SERVICE_WIRE_REQUIRED").is_none(),
            "service wire test cannot run: {reason}"
        );
        eprintln!("SKIPPED service_wire: {reason}");
        return;
    }
    tokio::time::timeout(Duration::from_secs(60), wire())
        .await
        .expect("the wire test finishes within 60 s");
}

async fn wire() {
    // A private HOME with one connected workspace folder: the outbound locator
    // sanitiser reads both. This test binary has no other test, so nothing races
    // with the change.
    let real_home = std::env::var_os("HOME").unwrap_or_default();
    let base = std::env::temp_dir().join(format!("li-wire-{}-{}", std::process::id(), now_ms()));
    std::fs::create_dir_all(base.join("Documents/Client Work/Plans")).unwrap();
    let home = std::fs::canonicalize(&base).unwrap();
    let workspace_root = home.join("Documents/Client Work");
    std::env::set_var("HOME", &home);
    live_interview_lib::public_domain::PublicStore::open(&live_interview_lib::edition::data_root())
        .unwrap()
        .save_workspace(json!({"id":"ws-wire","name":"Client Work","root":workspace_root,"roots":[workspace_root],"sharedLibraryIds":[],"appendTargets":[],"revision":0}))
        .unwrap();

    let root = repo_root();
    let mut child = tokio::process::Command::new(root.join("node_modules/.bin/vite-node"))
        .arg("--root")
        .arg(&root)
        .arg(root.join("apps/desktop/src-tauri/tests/fixtures/service-wire-harness.ts"))
        .current_dir(&root)
        .env("HOME", &real_home)
        .env("WIRE_ROOT", &workspace_root)
        .env("WIRE_HOME", &home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .expect("start the service harness");
    let mut harness = Harness {
        stdin: child.stdin.take().unwrap(),
        lines: BufReader::new(child.stdout.take().unwrap()).lines(),
        _child: child,
    };
    let ready = harness.next().await;
    let payload = &ready["payload"];
    let (job, prompt) = (&payload["job"], payload["prompt"].as_str().unwrap());
    assert_eq!(job["basis"]["snapshot"]["context"]["selfName"], "José Núñez");

    // (1) Sign-in through the app's device flow, then the account as the app shows it.
    let main = ServiceClient::new(ready["main"].as_str().unwrap(), true).unwrap();
    let session = sign_in(&main).await;
    let token = session.session_token.as_str();
    let status = account(&main, token).await;
    assert_eq!(status["signedIn"], true, "{status}");
    assert_eq!(status["plan"], "premium", "{status}");
    assert_eq!(status["canUseAI"], true, "{status}");
    assert_eq!(status["user"]["name"], "Zoë Wire");
    let caller = Caller::Token(&main, token);
    let state = ReasoningState::default();

    // (2) Streamed live guidance with the real renderer payload.
    let sent = fresh(job, "wire-live-1");
    let (result, drafts) = run(&state, caller, &sent, prompt).await;
    assert_eq!(result["outcome"], "complete", "{result}");
    assert_eq!(result["jobId"], "wire-live-1");
    assert_eq!(result["provider"], "managedFast");
    assert_eq!(result["basis"], sent["basis"], "the renderer gets back the basis it sent");
    assert!(result["timing"]["firstTokenMs"].is_u64(), "{result}");
    assert_eq!(result["usage"], json!({"input":120,"output":40}));
    assert!(result["output"]["say"].as_str().unwrap().contains("Zürich"));
    assert_eq!(drafts[0], json!({"delta":"{\"say\":\"Abandoned"}));
    assert_eq!(drafts[1], json!({"reset":true}));
    let replayed: String = drafts[2..]
        .iter()
        .map(|d| d["delta"].as_str().expect("delta after the reset"))
        .collect();
    assert_eq!(serde_json::from_str::<Value>(&replayed).unwrap(), result["output"]);
    // What crossed the wire: locators in privacy-safe form, names intact.
    let seen = harness.ask(json!({"cmd":"seen","service":"main"})).await;
    let wire_text = seen["reasoning"].to_string();
    for private in [home.to_str().unwrap(), "/Users/", "token=abc"] {
        assert!(!wire_text.contains(private), "{private} left the Mac");
    }
    let sources = &seen["reasoning"]["job"]["basis"]["snapshot"]["context"]["sources"];
    let locator = |id: &str| {
        sources
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["sourceId"] == id)
            .unwrap()["locator"]
            .clone()
    };
    assert_eq!(locator("src-plan"), "Client Work/Plans/Zürich plan.md#Ziele:part1");
    assert_eq!(locator("src-outside"), "Ångström notes.pdf#page:2");
    assert_eq!(locator("src-users"), "brief.md");
    assert_eq!(locator("src-web"), "https://example.com/rollout");
    let received_prompt = seen["reasoning"]["prompt"].as_str().unwrap();
    assert!(received_prompt.contains("Client Work/Plans/Zürich plan.md#Ziele:part1"));
    assert!(received_prompt.contains("José Núñez") && received_prompt.contains("Zoë Ångström"));
    let context = &seen["reasoning"]["job"]["basis"]["snapshot"]["context"];
    assert_eq!(context["selfName"], "José Núñez");
    assert_eq!(context["participants"][1]["name"], "Søren Kierkegård");
    // The renderer turns the native result into the card it shows.
    let card = harness
        .ask(json!({"cmd":"card","job":sent,"result":result}))
        .await;
    assert_eq!(card["card"]["say"], result["output"]["say"], "{card}");
    assert_eq!(card["card"]["evidence"], json!(["src-plan"]));

    // The single-body route: preparation does not stream.
    let mut preparation = fresh(job, "wire-prep-1");
    preparation["usageFeature"] = json!("preparation");
    let (result, drafts) = run(&state, caller, &preparation, prompt).await;
    assert_eq!(result["outcome"], "complete", "{result}");
    assert!(drafts.is_empty() && result.get("timing").is_none());

    // (3) The decision route, with and without an effective context.
    let decision = &payload["decide"];
    for context in [Some(decision["effectiveContext"].clone()), None] {
        let with_context = context.is_some();
        let answer = decide(
            &state,
            caller,
            decision["basis"].clone(),
            context,
            decision["questions"].clone(),
        )
        .await
        .expect("decide");
        assert_eq!(answer["basis"], decision["basis"]);
        let choice = answer["answers"]["intent"]["choice"].as_str().unwrap();
        assert!(decision["questions"]["intent"]["criteria"].get(choice).is_some(), "{answer}");
        assert_eq!(answer["answers"]["research"]["noul"], 0.8);
        let seen = harness.ask(json!({"cmd":"seen","service":"main"})).await;
        assert!(!seen["decide"].to_string().contains("/Users/"));
        assert_eq!(seen["decide"]["context"]["selfName"], "José Núñez", "context sent: {with_context}");
    }

    // (4) Failures, as the renderer receives them. The TS UI only tells apart
    // signed-out codes (accountData.ts) and otherwise shows a generic failure;
    // the native client passes through its `safe_code` list and reports every
    // other service code as `serviceUnavailable`.
    let mut drifted = fresh(job, "wire-invalid-1");
    drifted["unexpectedField"] = json!(true);
    let (result, _) = run(&state, caller, &drifted, prompt).await;
    assert_failure(&result, "serviceUnavailable"); // service: 400 invalidRequest

    // Two requested cards hold both of the user's slots; a third is refused.
    let hold = format!("[wire:hold] {prompt}");
    let (first, second) = (fresh(job, "wire-hold-1"), fresh(job, "wire-hold-2"));
    let used = account(&main, token).await["usage"]["requests"].as_u64().unwrap();
    let held = async {
        tokio::join!(
            run(&state, caller, &first, &hold),
            run(&state, caller, &second, &hold)
        )
    };
    let third = async {
        while account(&main, token).await["usage"]["requests"].as_u64().unwrap() < used + 2 {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        run(&state, caller, &fresh(job, "wire-hold-3"), prompt).await
    };
    let (((a, _), (b, _)), (c, _)) = tokio::join!(held, third);
    assert_eq!((a["outcome"].as_str(), b["outcome"].as_str()), (Some("complete"), Some("complete")));
    assert_failure(&c, "serviceUnavailable"); // service: 429 concurrencyExceeded

    // (5) Clock skew: the service's clock runs five minutes behind this Mac's.
    // The app sends a relative timeout, so the job still runs; an absolute
    // deadline from the Mac's clock would be refused as too far ahead.
    harness.ask(json!({"cmd":"skew","service":"main","ms":300_000})).await;
    let (result, _) = run(&state, caller, &fresh(job, "wire-skew-1"), prompt).await;
    assert_eq!(result["outcome"], "complete", "{result}");
    let mut absolute = json!({"job":fresh(job, "wire-skew-2"),"prompt":prompt});
    absolute["job"]["usageFeature"] = json!("preparation");
    // As the app sends it: locators in privacy-safe form.
    live_interview_lib::reasoning::locator::sanitize_outbound(&mut absolute);
    let refused = caller
        .request(Method::POST, "/v1/reasoning", Some(&absolute), Duration::from_secs(10))
        .await;
    assert_eq!(refused.unwrap_err(), "serviceUnavailable"); // service: 400 invalidJob
    // The same body with a relative timeout instead is accepted: the refusal was the clock.
    let mut relative = absolute.clone();
    relative["job"]["id"] = json!("wire-skew-3");
    relative["job"].as_object_mut().unwrap().remove("deadlineMs");
    relative["job"]["timeoutMs"] = json!(30_000);
    let accepted = caller
        .request(Method::POST, "/v1/reasoning", Some(&relative), Duration::from_secs(10))
        .await
        .expect("relative timeout accepted under skew");
    assert_eq!(accepted["outcome"], "complete");
    harness.ask(json!({"cmd":"skew","service":"main","ms":0})).await;

    // (6) Session renewal as the app does it in the background.
    harness.ask(json!({"cmd":"renewWindow","service":"main","ms":31u64 * 86_400_000})).await;
    let renewed = renew_session(&main, &session).await.expect("renew");
    assert_ne!(renewed.session_token, session.session_token);
    assert!(renewed.expires_at_ms >= session.expires_at_ms);
    assert!(renewed.sign_in_required_at_ms.is_some_and(|cap| cap >= renewed.expires_at_ms));
    // A retry with the old token (a lost response) gets the same new token.
    assert_eq!(renew_session(&main, &session).await.expect("retry").session_token, renewed.session_token);
    // The old token still answers until the new one is used, then stops.
    assert_eq!(account(&main, token).await["signedIn"], true);
    assert_eq!(account(&main, &renewed.session_token).await["signedIn"], true);
    let old = main
        .request(Method::GET, "/v1/account", None, Some(token), Duration::from_secs(10))
        .await;
    assert_eq!(old.unwrap_err(), "unauthenticated");

    // (7) Sign out of all Macs: this session and another Mac's both end.
    let other = sign_in_only(&main).await;
    sign_out_all(&main, &renewed.session_token).await.expect("sign out everywhere");
    for t in [renewed.session_token.as_str(), other.session_token.as_str()] {
        let gone = main
            .request(Method::GET, "/v1/account", None, Some(t), Duration::from_secs(10))
            .await;
        assert_eq!(gone.unwrap_err(), "unauthenticated");
    }

    // A second service: one request a month and no decision route.
    let tight = ServiceClient::new(ready["tight"].as_str().unwrap(), true).unwrap();
    let session = sign_in(&tight).await;
    let token = session.session_token.as_str();
    let caller = Caller::Token(&tight, token);
    let refused = decide(
        &state,
        caller,
        decision["basis"].clone(),
        None,
        decision["questions"].clone(),
    )
    .await;
    assert_eq!(refused.unwrap_err(), "serviceUnavailable"); // service: 503 decisionNotConfigured
    // The provider refuses before running: the request is refunded.
    let (result, drafts) = run(&state, caller, &fresh(job, "wire-refused-1"), &format!("[wire:refuse] {prompt}")).await;
    assert_failure(&result, "providerUnavailable");
    assert!(drafts.is_empty());
    assert_eq!(account(&tight, token).await["usage"]["requests"], 0, "refunded");
    // So the one allowed request still succeeds, and the next one is over quota.
    let (result, _) = run(&state, caller, &fresh(job, "wire-quota-1"), prompt).await;
    assert_eq!(result["outcome"], "complete", "{result}");
    let (result, _) = run(&state, caller, &fresh(job, "wire-quota-2"), prompt).await;
    assert_failure(&result, "allowanceExceeded");
    let status = account(&tight, token).await;
    assert_eq!(status["usage"]["requests"], 1);
    assert_eq!(status["limits"]["requests"], 1);

    drop(harness);
    let _ = std::fs::remove_dir_all(&base);
}
