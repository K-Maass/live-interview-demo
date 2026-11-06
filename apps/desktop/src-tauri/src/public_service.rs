//! Managed-product transport. Calendar/provider credentials and sessions never enter renderer state.
use futures_util::StreamExt;
use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

pub fn checked_origin(value: &str, allow_loopback: bool) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "serviceSetupRequired")?;
    let local = matches!(
        url.host_str(),
        Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
    );
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(url.path(), "" | "/")
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "https" || (allow_loopback && local && url.scheme() == "http"))
    {
        return Err("serviceSetupRequired".into());
    }
    Ok(url)
}
pub fn same_origin_url(origin: &Url, value: &str) -> Result<String, String> {
    let url = Url::parse(value).map_err(|_| "invalidServiceResponse")?;
    if url.origin() != origin.origin()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("invalidServiceResponse".into());
    }
    Ok(url.to_string())
}
pub fn billing_url(value: &str) -> Result<String, String> {
    let url = Url::parse(value).map_err(|_| "invalidBillingResponse")?;
    if url.scheme() != "https"
        || !matches!(
            url.host_str(),
            Some("checkout.stripe.com" | "billing.stripe.com")
        )
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.port_or_known_default() != Some(443)
    {
        return Err("invalidBillingResponse".into());
    }
    Ok(url.to_string())
}
fn unavailable(code: &str) -> Value {
    json!({"configured":false,"signedIn":false,"plan":"none","subscriptionStatus":"unavailable","canUseAI":false,"canAutoPrepare":false,"billingAvailable":false,"code":code})
}
pub fn sanitize_account(value: &Value) -> Value {
    let configured = value["configured"] == true;
    let signed_in =
        value["signedIn"] == true && value["user"]["id"].as_str().is_some_and(|s| !s.is_empty());
    let plan = match value["plan"].as_str() {
        Some("standard") => "standard",
        Some("premium") => "premium",
        _ => "none",
    };
    let mut out = json!({"configured":configured,"signedIn":signed_in,"plan":if signed_in{plan}else{"none"},"subscriptionStatus":value["subscriptionStatus"].as_str().unwrap_or("unavailable"),"canUseAI":signed_in&&value["canUseAI"]==true,"canAutoPrepare":signed_in&&plan=="premium"&&value["canAutoPrepare"]==true,"billingAvailable":value["billingAvailable"]==true});
    if signed_in {
        let mut user = json!({"id":value["user"]["id"]});
        for key in ["name", "email"] {
            if let Some(s) = value["user"][key].as_str() {
                user[key] = json!(s);
            }
        }
        out["user"] = user;
    }
    for key in ["usage", "limits"] {
        if value[key].is_object() {
            let mut counts = json!({});
            for field in ["requests", "inputTokens", "outputTokens"] {
                if let Some(n) = value[key][field].as_u64() {
                    counts[field] = json!(n);
                }
            }
            out[key] = counts;
        }
    }
    // Times only: when usage resets and, during a failed renewal's grace, when AI stops.
    if signed_in {
        for key in ["usageResetsAtMs", "paymentGraceEndsAtMs"] {
            if let Some(n) = value[key].as_u64() {
                out[key] = json!(n);
            }
        }
    }
    if let Some(code) = value["code"].as_str() {
        out["code"] = json!(safe_code(code));
    }
    out
}
fn safe_code(code: &str) -> &str {
    match code {
        "authNotConfigured"
        | "providerNotConfigured"
        | "billingNotConfigured"
        | "billingUnavailable"
        | "unauthenticated"
        | "subscriptionRequired"
        | "allowanceExceeded"
        | "premiumRequired"
        | "requestTooLarge"
        | "providerUnavailable"
        | "slowDown"
        | "invalidDeviceCode"
        | "sessionExpired"
        | "rateLimited"
        | "confirmationRequired"
        | "billingOwnershipMismatch"
        | "serviceSetupRequired" => code,
        _ => "serviceUnavailable",
    }
}
pub fn validate_model_result(job: &Value, result: &Value) -> Result<(), String> {
    if result["jobId"] != job["id"]
        || result["basis"] != job["basis"]
        || !matches!(
            result["outcome"].as_str(),
            Some("complete" | "failure" | "cancelled")
        )
    {
        return Err("invalidServiceResponse".into());
    }
    crate::reasoning::protocol::validate_text_job(result).map_err(|_| "textOnlyBoundary".into())
}
/// One server-sent event from `POST /v1/reasoning/stream`.
#[derive(Debug, PartialEq)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
}
const SSE_EVENT_LIMIT: usize = 1_000_000;
const SSE_STREAM_LIMIT: usize = 4_000_000;
/// Incremental, bounded framing of the service's event stream. Carriage returns
/// are dropped: the service only frames with `\n`, and JSON escapes any inside data.
#[derive(Default)]
pub struct SseParser {
    pending: Vec<u8>,
    total: usize,
}
impl SseParser {
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<SseEvent>, String> {
        self.total = self.total.saturating_add(chunk.len());
        if self.total > SSE_STREAM_LIMIT {
            return Err("invalidServiceResponse".into());
        }
        self.pending
            .extend(chunk.iter().copied().filter(|b| *b != b'\r'));
        let mut events = Vec::new();
        while let Some(end) = self.pending.windows(2).position(|w| w == b"\n\n") {
            let block: Vec<u8> = self.pending.drain(..end + 2).take(end).collect();
            if let Some(event) = Self::event(&block)? {
                events.push(event);
            }
        }
        if self.pending.len() > SSE_EVENT_LIMIT {
            return Err("invalidServiceResponse".into());
        }
        Ok(events)
    }
    fn event(block: &[u8]) -> Result<Option<SseEvent>, String> {
        let text = std::str::from_utf8(block).map_err(|_| "invalidServiceResponse")?;
        let (mut event, mut data) = (String::new(), Vec::new());
        for line in text.split('\n') {
            if let Some(value) = line.strip_prefix("event:") {
                event = value.strip_prefix(' ').unwrap_or(value).to_owned();
            } else if let Some(value) = line.strip_prefix("data:") {
                data.push(value.strip_prefix(' ').unwrap_or(value));
            }
        }
        Ok((!event.is_empty()).then(|| SseEvent {
            event,
            data: data.join("\n"),
        }))
    }
}
/// Provisional progress of a streamed call, for display only. A `Reset` means
/// the service switched routes mid-answer: everything received so far is void.
#[derive(Debug, PartialEq)]
pub enum StreamUpdate {
    Delta(String),
    Reset,
}
/// A finished streamed reasoning call. `first_token_ms` is measured from the
/// moment the request was sent to the first `delta` event that survived any
/// `reset`.
pub struct StreamedResult {
    pub value: Value,
    pub first_token_ms: Option<u64>,
}
#[derive(Clone)]
pub struct ServiceClient {
    origin: Url,
    http: reqwest::Client,
}
impl ServiceClient {
    pub fn new(origin: &str, allow_loopback: bool) -> Result<Self, String> {
        Ok(Self {
            origin: checked_origin(origin, allow_loopback)?,
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(5))
                .build()
                .map_err(|_| "serviceUnavailable")?,
        })
    }
    pub async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        token: Option<&str>,
        timeout: Duration,
    ) -> Result<Value, String> {
        if !path.starts_with("/v1/") || path.contains("..") {
            return Err("invalidServicePath".into());
        }
        let url = self.origin.join(path).map_err(|_| "invalidServicePath")?;
        if url.origin() != self.origin.origin() {
            return Err("invalidServicePath".into());
        }
        let mut request = self
            .http
            .request(method, url)
            .timeout(timeout.min(Duration::from_secs(65)));
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            if body.to_string().len() > 500_000 {
                return Err("requestTooLarge".into());
            }
            request = request.json(body);
        }
        let response = request.send().await.map_err(|_| "serviceUnavailable")?;
        let status = response.status();
        let result = Self::json_body(response).await?;
        if !status.is_success() {
            return Err(Self::error_code(&result));
        }
        Ok(result)
    }
    async fn json_body(response: reqwest::Response) -> Result<Value, String> {
        if response.content_length().is_some_and(|n| n > 1_000_000) {
            return Err("invalidServiceResponse".into());
        }
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "invalidServiceResponse")?;
            if bytes.len().saturating_add(chunk.len()) > 1_000_000 {
                return Err("invalidServiceResponse".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| "invalidServiceResponse".into())
    }
    fn error_code(body: &Value) -> String {
        safe_code(
            body["error"]["code"]
                .as_str()
                .unwrap_or("serviceUnavailable"),
        )
        .into()
    }
    /// Calls the streaming variant of a service route and waits for its final
    /// `result` event. `streamUnsupported` means the route does not exist (404,
    /// 405 or 501): the service rejected the path before any admission or
    /// dispatch, so the caller may use the non-streaming route for the same job.
    /// Any other failure, including one after the first token, is final: the job
    /// id has been dispatched and the service will not run it again.
    /// `on_update` sees the unvalidated `delta` and `reset` events as they arrive;
    /// only the returned value is authoritative.
    pub async fn request_stream(
        &self,
        path: &str,
        body: &Value,
        token: &str,
        timeout: Duration,
        on_update: &mut (dyn FnMut(StreamUpdate) + Send),
    ) -> Result<StreamedResult, String> {
        if !path.starts_with("/v1/") || path.contains("..") {
            return Err("invalidServicePath".into());
        }
        let url = self.origin.join(path).map_err(|_| "invalidServicePath")?;
        if url.origin() != self.origin.origin() || body.to_string().len() > 500_000 {
            return Err("invalidServicePath".into());
        }
        let started = std::time::Instant::now();
        let response = self
            .http
            .post(url)
            .timeout(timeout.min(Duration::from_secs(65)))
            .bearer_auth(token)
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .json(body)
            .send()
            .await
            .map_err(|_| "serviceUnavailable")?;
        let status = response.status();
        if matches!(status.as_u16(), 404 | 405 | 501) {
            return Err("streamUnsupported".into());
        }
        if !status.is_success() {
            return Err(Self::error_code(&Self::json_body(response).await?));
        }
        let is_stream = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with("text/event-stream"));
        if !is_stream {
            return Err("invalidServiceResponse".into());
        }
        let mut stream = response.bytes_stream();
        let mut parser = SseParser::default();
        let mut first_token_ms = None;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "streamInterrupted")?;
            for event in parser.push(&chunk)? {
                match event.event.as_str() {
                    "delta" => {
                        first_token_ms.get_or_insert(started.elapsed().as_millis() as u64);
                        // Display is best effort: a malformed fragment never fails the call.
                        if let Some(text) = serde_json::from_str::<Value>(&event.data)
                            .ok()
                            .and_then(|v| v["text"].as_str().map(str::to_owned))
                        {
                            on_update(StreamUpdate::Delta(text));
                        }
                    }
                    "reset" => {
                        first_token_ms = None;
                        on_update(StreamUpdate::Reset);
                    }
                    "result" => {
                        let value = serde_json::from_str(&event.data)
                            .map_err(|_| "invalidServiceResponse")?;
                        return Ok(StreamedResult {
                            value,
                            first_token_ms,
                        });
                    }
                    "error" => {
                        let body: Value = serde_json::from_str(&event.data)
                            .map_err(|_| "invalidServiceResponse")?;
                        return Err(safe_code(
                            body["code"].as_str().unwrap_or("serviceUnavailable"),
                        )
                        .into());
                    }
                    _ => {}
                }
            }
        }
        Err("streamInterrupted".into())
    }
}
fn client() -> Result<ServiceClient, String> {
    static CLIENT: OnceLock<Result<ServiceClient, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            ServiceClient::new(
                option_env!("PUBLIC_SERVICE_ORIGIN").unwrap_or(""),
                cfg!(debug_assertions),
            )
        })
        .clone()
}
/// A product session as the device sign-in returns it. The app keeps it in the Keychain only.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub session_token: String,
    pub expires_at_ms: u64,
    /// When renewal can no longer extend this sign-in (the service's absolute
    /// lifetime); unknown until the first renewal call answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sign_in_required_at_ms: Option<u64>,
}
#[derive(Default)]
struct SessionCache {
    loaded: bool,
    session: Option<Session>,
    generation: u64,
    /// The token a renewal just replaced: calls that started with it are still
    /// current (the service accepts it until the new one is used).
    previous_token: Option<String>,
    /// A renewed session the Keychain did not accept yet; saving is retried.
    unsaved: bool,
}
impl SessionCache {
    fn next_generation(&mut self) -> u64 {
        self.generation = self.generation.wrapping_add(1);
        self.generation
    }
    fn matches_token(&self, token: &str) -> bool {
        self.session
            .as_ref()
            .is_some_and(|s| s.session_token == token)
    }
    fn response_is_current(&self, token: &str, generation: u64) -> bool {
        self.generation == generation
            && (self.matches_token(token) || self.previous_token.as_deref() == Some(token))
    }
    fn accept(&mut self, session: Session, generation: u64) -> bool {
        if self.generation != generation {
            return false;
        }
        self.loaded = true;
        self.session = Some(session);
        self.previous_token = None;
        self.unsaved = false;
        true
    }
    /// Replaces the session `old_token` with what renewing it returned, unless
    /// the person signed out or in meanwhile. A sign-in or sign-out bumps the
    /// generation; a renewal does not, so calls in flight stay current.
    fn adopt_renewal(&mut self, old_token: &str, generation: u64, renewed: Session) -> bool {
        if self.generation != generation || !self.matches_token(old_token) {
            return false;
        }
        if renewed.session_token != old_token {
            self.previous_token = Some(old_token.to_owned());
        }
        self.session = Some(renewed);
        true
    }
    /// Abandons a pending browser sign-in without touching the saved session: the pending flow's next poll (and
    /// its commit) sees a newer generation and stops with `signInCancelled`.
    fn cancel_pending_sign_in(&mut self) {
        self.next_generation();
    }
}
fn session_cache() -> &'static Mutex<SessionCache> {
    static CACHE: OnceLock<Mutex<SessionCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(SessionCache::default()))
}
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn load_session() -> Result<Option<Session>, String> {
    let mut cache = session_cache()
        .lock()
        .map_err(|_| "credentialUnavailable")?;
    if !cache.loaded {
        #[cfg(target_os = "macos")]
        {
            cache.session = match security_framework::passwords::get_generic_password(
                crate::edition::keychain_service(),
                "product-session",
            ) {
                Ok(bytes) => {
                    Some(serde_json::from_slice(&bytes).map_err(|_| "credentialUnavailable")?)
                }
                Err(error) if error.code() == -25300 => None,
                Err(_) => return Err("credentialUnavailable".into()),
            };
        }
        cache.loaded = true;
    }
    Ok(cache.session.clone().filter(|s| s.expires_at_ms > now_ms()))
}
pub fn session_available() -> bool {
    client().is_ok() && load_session().ok().flatten().is_some()
}
fn persist_session(session: &Option<Session>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    match session {
        Some(s) => security_framework::passwords::set_generic_password(
            crate::edition::keychain_service(),
            "product-session",
            &serde_json::to_vec(s).map_err(|_| "credentialUnavailable")?,
        )
        .map_err(|_| "credentialUnavailable")?,
        None => {
            if let Err(error) = security_framework::passwords::delete_generic_password(
                crate::edition::keychain_service(),
                "product-session",
            ) {
                if error.code() != -25300 {
                    return Err("credentialUnavailable".into());
                }
            }
        }
    }
    Ok(())
}
fn clear_session_if_current(token: &str) -> Result<(), String> {
    let mut cache = session_cache()
        .lock()
        .map_err(|_| "credentialUnavailable")?;
    if cache.matches_token(token) {
        persist_session(&None)?;
        cache.loaded = true;
        cache.session = None;
    }
    Ok(())
}
fn logout_session() -> Result<Option<Session>, String> {
    let _ = load_session()?;
    let mut cache = session_cache()
        .lock()
        .map_err(|_| "credentialUnavailable")?;
    cache.next_generation();
    persist_session(&None)?;
    cache.loaded = true;
    cache.previous_token = None;
    cache.unsaved = false;
    Ok(cache.session.take())
}
/// Renewal starts this close to expiry (the service renews within its own
/// window, at most seven days, and answers `renewed:false` before that).
pub const RENEW_WINDOW_MS: u64 = 7 * 86_400_000;
/// True when the session is close enough to expiry to renew and the service
/// has not said that the sign-in has reached its absolute lifetime.
pub fn renewal_due(session: &Session, now: u64) -> bool {
    session.expires_at_ms.saturating_sub(now) <= RENEW_WINDOW_MS
        && session
            .sign_in_required_at_ms
            .map_or(true, |cap| session.expires_at_ms < cap)
}
/// Asks the service to renew `session`. Returns the session to keep: a new
/// token when the service rotated it, otherwise the same token with what the
/// service said about its expiry and lifetime. Nothing is saved here.
pub async fn renew_session(client: &ServiceClient, session: &Session) -> Result<Session, String> {
    let value = client
        .request(
            Method::POST,
            "/v1/auth/renew",
            Some(&json!({})),
            Some(&session.session_token),
            Duration::from_secs(15),
        )
        .await?;
    let expires = value["expiresAtMs"]
        .as_u64()
        .filter(|n| *n > now_ms())
        .ok_or("invalidServiceResponse")?;
    let cap = value["signInRequiredAtMs"].as_u64();
    if value["renewed"] == true {
        let token = value["sessionToken"]
            .as_str()
            .filter(|t| t.len() >= 32 && t.len() <= 256)
            .ok_or("invalidServiceResponse")?;
        return Ok(Session {
            session_token: token.to_owned(),
            expires_at_ms: expires,
            sign_in_required_at_ms: cap,
        });
    }
    if value["renewed"] != false {
        return Err("invalidServiceResponse".into());
    }
    Ok(Session {
        session_token: session.session_token.clone(),
        expires_at_ms: expires,
        sign_in_required_at_ms: cap,
    })
}
/// Whether the last background renewal failed; cleared by the next success.
static RENEWAL_FAILED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// Renews the saved session in the background when it is close to expiry. One
/// renewal at a time; failures are remembered for Settings and never reach
/// recording, transcription or a meeting.
pub async fn renew_if_due() {
    use std::sync::atomic::Ordering;
    static RUNNING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let Ok(_guard) = RUNNING.try_lock() else {
        return;
    };
    let Ok(client) = client() else { return };
    // A renewed token the Keychain refused earlier: try saving it again.
    if let Ok(mut cache) = session_cache().lock() {
        if cache.unsaved && persist_session(&cache.session).is_ok() {
            cache.unsaved = false;
        }
    }
    let Ok(Some(session)) = load_session() else { return };
    if !renewal_due(&session, now_ms()) {
        return;
    }
    let Ok(generation) = session_cache().lock().map(|c| c.generation) else {
        return;
    };
    match renew_session(&client, &session).await {
        Ok(renewed) => {
            let Ok(mut cache) = session_cache().lock() else {
                return;
            };
            if !cache.adopt_renewal(&session.session_token, generation, renewed.clone()) {
                return;
            }
            // One Keychain item, replaced in a single update. If the Keychain
            // refuses, the new token is still used in memory and saving is retried.
            let saved = persist_session(&Some(renewed)).is_ok();
            cache.unsaved = !saved;
            RENEWAL_FAILED.store(!saved, Ordering::SeqCst);
        }
        Err(code) => {
            if code == "unauthenticated" {
                let _ = clear_session_if_current(&session.session_token);
            }
            RENEWAL_FAILED.store(true, Ordering::SeqCst);
        }
    }
}
/// Hourly background renewal (every ten minutes after a failure), first a
/// minute after launch. It runs on its own task and never blocks anything.
pub fn start_session_renewal() {
    tauri::async_runtime::spawn(async {
        tokio::time::sleep(Duration::from_secs(60)).await;
        loop {
            renew_if_due().await;
            let failed = RENEWAL_FAILED.load(std::sync::atomic::Ordering::SeqCst);
            tokio::time::sleep(Duration::from_secs(if failed { 600 } else { 3600 })).await;
        }
    });
}
/// A meeting is starting: renew now if the session is close to expiry, so it
/// does not lapse mid-meeting. Fire and forget; the meeting never waits for it.
pub fn renew_before_meeting() {
    tauri::async_runtime::spawn(renew_if_due());
}
/// Times only, never the token: what Settings needs to warn ahead of expiry.
fn session_summary() -> Value {
    let session = load_session().ok().flatten();
    let mut out = json!({"renewalFailed": RENEWAL_FAILED.load(std::sync::atomic::Ordering::SeqCst)});
    if let Some(s) = session {
        out["expiresAtMs"] = json!(s.expires_at_ms);
        if let Some(cap) = s.sign_in_required_at_ms {
            out["signInRequiredAtMs"] = json!(cap);
        }
    }
    out
}
fn commit_login(session: Session, generation: u64) -> Result<(), String> {
    let mut cache = session_cache()
        .lock()
        .map_err(|_| "credentialUnavailable")?;
    if cache.generation != generation {
        return Err("signInCancelled".into());
    }
    persist_session(&Some(session.clone()))?;
    cache.accept(session, generation);
    Ok(())
}
pub async fn authenticated_request(
    method: Method,
    path: &str,
    body: Option<&Value>,
    timeout: Duration,
) -> Result<Value, String> {
    with_session(|client, token| async move {
        client
            .request(method, path, body, Some(&token), timeout)
            .await
    })
    .await
}
/// Streaming reasoning call with the signed-in session; see `ServiceClient::request_stream`.
pub async fn authenticated_reasoning_stream(
    body: &Value,
    timeout: Duration,
    on_update: &mut (dyn FnMut(StreamUpdate) + Send),
) -> Result<StreamedResult, String> {
    with_session(|client, token| async move {
        client
            .request_stream("/v1/reasoning/stream", body, &token, timeout, on_update)
            .await
    })
    .await
}
/// Who a managed call is made as. The app always uses `SignedIn` (the Keychain
/// session, cleared when the service rejects it); `Token` calls one service with
/// an explicit session, so the reasoning flow can run without the app (tests).
#[derive(Clone, Copy)]
pub enum Caller<'a> {
    SignedIn,
    Token(&'a ServiceClient, &'a str),
}
impl Caller<'_> {
    pub async fn request(
        self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        timeout: Duration,
    ) -> Result<Value, String> {
        match self {
            Caller::SignedIn => authenticated_request(method, path, body, timeout).await,
            Caller::Token(client, token) => {
                client.request(method, path, body, Some(token), timeout).await
            }
        }
    }
    pub async fn reasoning_stream(
        self,
        body: &Value,
        timeout: Duration,
        on_update: &mut (dyn FnMut(StreamUpdate) + Send),
    ) -> Result<StreamedResult, String> {
        match self {
            Caller::SignedIn => authenticated_reasoning_stream(body, timeout, on_update).await,
            Caller::Token(client, token) => {
                client
                    .request_stream("/v1/reasoning/stream", body, token, timeout, on_update)
                    .await
            }
        }
    }
}
async fn with_session<T, F, Fut>(call: F) -> Result<T, String>
where
    F: FnOnce(ServiceClient, String) -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let client = client()?;
    let session = load_session()?.ok_or("signInRequired")?;
    let generation = session_cache()
        .lock()
        .map_err(|_| "credentialUnavailable")?
        .generation;
    let result = call(client, session.session_token.clone()).await;
    if !session_cache()
        .lock()
        .map_err(|_| "credentialUnavailable")?
        .response_is_current(&session.session_token, generation)
    {
        return Err("sessionChanged".into());
    }
    if result
        .as_ref()
        .is_err_and(|code| code == "unauthenticated" || code == "sessionExpired")
    {
        let _ = clear_session_if_current(&session.session_token);
    }
    result
}
#[tauri::command]
pub async fn public_account_status() -> Value {
    if client().is_err() {
        return unavailable("serviceSetupRequired");
    }
    for _ in 0..2 {
        match load_session() {
            Ok(Some(_)) => {
                match authenticated_request(
                    Method::GET,
                    "/v1/account",
                    None,
                    Duration::from_secs(15),
                )
                .await
                {
                    Ok(v) => {
                        let mut status = sanitize_account(&v);
                        if status["signedIn"] == true {
                            status["session"] = session_summary();
                        }
                        return status;
                    }
                    Err(code) if code == "sessionChanged" => continue,
                    Err(code) => {
                        let mut v = unavailable(&code);
                        v["configured"] = json!(true);
                        return v;
                    }
                }
            }
            Ok(None) => {
                return json!({"configured":true,"signedIn":false,"plan":"none","subscriptionStatus":"signedOut","canUseAI":false,"canAutoPrepare":false,"billingAvailable":false});
            }
            Err(_) => return unavailable("credentialUnavailable"),
        }
    }
    unavailable("sessionChanged")
}
/// The short code the app shows for the person to type in the browser.
fn sign_in_code(value: &Value) -> Option<&str> {
    value.as_str().filter(|v| {
        !v.is_empty()
            && v.len() <= 16
            && v.chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '-' || c == '_')
    })
}
#[tauri::command]
pub async fn public_sign_in(app: AppHandle) -> Result<Value, String> {
    static FLOW: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = FLOW.try_lock().map_err(|_| "signInAlreadyPending")?;
    let client = client()?;
    let generation = session_cache()
        .lock()
        .map_err(|_| "credentialUnavailable")?
        .next_generation();
    let show = |user_code: &str, expires: u64, verification: String| {
        use tauri::Emitter;
        let _ = app.emit(
            "public-sign-in-code",
            json!({"userCode":user_code,"expiresAtMs":expires}),
        );
        app.opener()
            .open_url(verification, None::<String>)
            .map_err(|_| "browserUnavailable".to_string())
    };
    let still_current = || {
        Ok(session_cache()
            .lock()
            .map_err(|_| "credentialUnavailable")?
            .generation
            == generation)
    };
    let session = device_sign_in(&client, show, still_current).await?;
    commit_login(session, generation)?;
    Ok(public_account_status().await)
}
/// The device-code sign-in without the app window. Asks the service for a code,
/// hands the code to type, its expiry and the verification page to `show` (the
/// app emits the code and opens the browser), then polls until the person has
/// approved the code in the browser. `still_current` is asked before every poll;
/// `false` stops with `signInCancelled`. The session is returned, not saved.
pub async fn device_sign_in(
    client: &ServiceClient,
    show: impl FnOnce(&str, u64, String) -> Result<(), String>,
    still_current: impl Fn() -> Result<bool, String>,
) -> Result<Session, String> {
    let device = client
        .request(
            Method::POST,
            "/v1/auth/device",
            Some(&json!({})),
            None,
            Duration::from_secs(15),
        )
        .await?;
    let code = device["deviceCode"]
        .as_str()
        .filter(|v| v.len() >= 32 && v.len() <= 128)
        .ok_or("invalidServiceResponse")?;
    let verification = same_origin_url(
        &client.origin,
        device["verificationUri"]
            .as_str()
            .ok_or("invalidServiceResponse")?,
    )?;
    let expires = device["expiresAtMs"]
        .as_u64()
        .filter(|n| *n > now_ms())
        .ok_or("invalidServiceResponse")?
        .min(now_ms() + 900_000);
    let mut interval = device["pollIntervalSeconds"]
        .as_u64()
        .unwrap_or(5)
        .clamp(1, 10);
    // The browser page is never prefilled: the person types this code there.
    let user_code = sign_in_code(&device["userCode"]).ok_or("invalidServiceResponse")?;
    show(user_code, expires, verification)?;
    while now_ms() < expires {
        tokio::time::sleep(Duration::from_secs(interval)).await;
        if !still_current()? {
            return Err("signInCancelled".into());
        }
        match client
            .request(
                Method::POST,
                "/v1/auth/device/poll",
                Some(&json!({"deviceCode":code})),
                None,
                Duration::from_secs(15),
            )
            .await
        {
            Ok(value) if value["status"] == "pending" => {}
            Ok(value) => {
                let session: Session =
                    serde_json::from_value(value).map_err(|_| "invalidServiceResponse")?;
                if session.session_token.len() < 32 || session.expires_at_ms <= now_ms() {
                    return Err("invalidServiceResponse".into());
                }
                return Ok(session);
            }
            Err(code) if code == "slowDown" => interval = (interval + 1).min(10),
            Err(code) => return Err(code),
        }
    }
    Err("signInExpired".into())
}
#[tauri::command]
pub fn public_cancel_sign_in() -> Result<(), String> {
    session_cache()
        .lock()
        .map_err(|_| "credentialUnavailable")?
        .cancel_pending_sign_in();
    Ok(())
}
#[tauri::command]
pub async fn public_sign_out() -> Result<(), String> {
    let old = logout_session()?;
    if let (Some(session), Ok(client)) = (old, client()) {
        let _ = client
            .request(
                Method::POST,
                "/v1/auth/logout",
                Some(&json!({})),
                Some(&session.session_token),
                Duration::from_secs(10),
            )
            .await;
    }
    Ok(())
}
/// Signs out every Mac of the account with `token`: `POST /v1/auth/logout-all`.
pub async fn sign_out_all(client: &ServiceClient, token: &str) -> Result<(), String> {
    let result = client
        .request(
            Method::POST,
            "/v1/auth/logout-all",
            Some(&json!({})),
            Some(token),
            Duration::from_secs(15),
        )
        .await?;
    if result["ok"] != true {
        return Err("invalidServiceResponse".into());
    }
    Ok(())
}
/// "Sign out of all Macs" (the interface asks for confirmation first). The
/// service revokes every session of the account, then this Mac forgets its
/// own. If the service cannot be reached this Mac stays signed in.
#[tauri::command]
pub async fn public_sign_out_all() -> Result<Value, String> {
    with_session(|client, token| async move { sign_out_all(&client, &token).await }).await?;
    let _ = logout_session();
    Ok(json!({"signedOutEverywhere":true}))
}
#[tauri::command]
pub async fn public_checkout(plan: String) -> Result<Value, String> {
    if !matches!(plan.as_str(), "standard" | "premium") {
        return Err("invalidPlan".into());
    }
    let result = authenticated_request(
        Method::POST,
        "/v1/billing/checkout",
        Some(&json!({"plan":plan})),
        Duration::from_secs(20),
    )
    .await?;
    Ok(json!({"url":billing_url(result["url"].as_str().ok_or("invalidBillingResponse")?)?}))
}
#[tauri::command]
pub async fn public_billing_portal() -> Result<Value, String> {
    let result = authenticated_request(
        Method::POST,
        "/v1/billing/portal",
        Some(&json!({})),
        Duration::from_secs(20),
    )
    .await?;
    Ok(json!({"url":billing_url(result["url"].as_str().ok_or("invalidBillingResponse")?)?}))
}
/// An export is plain account data. Anything else is not written to disk.
fn checked_export(value: &Value) -> Result<(), String> {
    if value["formatVersion"] == 1
        && value["account"]["id"].as_str().is_some_and(|s| !s.is_empty())
        && value["exportedAtMs"].is_u64()
    {
        Ok(())
    } else {
        Err("invalidServiceResponse".into())
    }
}
/// Writes the export as a new private file; an earlier export is never overwritten.
fn write_export_file(dir: &std::path::Path, export: &Value) -> Result<std::path::PathBuf, String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    checked_export(export)?;
    let day = chrono::DateTime::from_timestamp_millis(export["exportedAtMs"].as_i64().unwrap_or(0))
        .map(|t| t.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| "export".into());
    let bytes = serde_json::to_vec_pretty(export).map_err(|_| "invalidServiceResponse")?;
    for n in 1..=50 {
        let name = if n == 1 {
            format!("live-interview-account-export-{day}.json")
        } else {
            format!("live-interview-account-export-{day}-{n}.json")
        };
        let path = dir.join(name);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
        {
            Ok(mut file) => {
                file.write_all(&bytes).map_err(|_| "exportWriteFailed")?;
                return Ok(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("exportWriteFailed".into()),
        }
    }
    Err("exportWriteFailed".into())
}
/// Downloads everything the service stores about the signed-in account and saves it
/// to the Downloads folder. Local meeting data is not part of it and is never read.
#[tauri::command]
pub async fn public_export_account() -> Result<Value, String> {
    let export = authenticated_request(
        Method::GET,
        "/v1/account/export",
        None,
        Duration::from_secs(20),
    )
    .await?;
    checked_export(&export)?;
    let downloads = std::path::PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
        .join("Downloads");
    if !downloads.is_dir() {
        return Err("exportWriteFailed".into());
    }
    let path = write_export_file(&downloads, &export)?;
    Ok(json!({"path":path.to_string_lossy(),"bytes":std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0)}))
}
/// Deletes the service account (the interface asks for confirmation first) and then
/// forgets the session. Local data stays on this Mac.
#[tauri::command]
pub async fn public_delete_account() -> Result<Value, String> {
    let result = authenticated_request(
        Method::POST,
        "/v1/account/delete",
        Some(&json!({"confirm":"delete-account"})),
        Duration::from_secs(60),
    )
    .await?;
    if result["deleted"] != true {
        return Err("invalidServiceResponse".into());
    }
    // The account is already gone; a failure to forget the session must not read as "not deleted".
    let _ = logout_session();
    Ok(json!({"deleted":true,"stripeCustomerDeleted":result["stripeCustomerDeleted"]==true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn account_or_model_success_from_an_older_login_is_never_current() {
        let mut cache = SessionCache::default();
        let first = cache.next_generation();
        cache.accept(
            Session {
                session_token: "session-one".into(),
                expires_at_ms: 1,
                sign_in_required_at_ms: None,
            },
            first,
        );
        assert!(cache.response_is_current("session-one", first));
        let second = cache.next_generation();
        assert!(!cache.response_is_current("session-one", first));
        cache.accept(
            Session {
                session_token: "session-two".into(),
                expires_at_ms: 1,
                sign_in_required_at_ms: None,
            },
            second,
        );
        assert!(!cache.response_is_current("session-one", first));
        assert!(cache.response_is_current("session-two", second));
        cache.next_generation();
        cache.session = None;
        assert!(!cache.response_is_current("session-two", second));
    }
    #[test]
    fn export_files_are_private_new_and_never_overwritten() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("li-export-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let export = json!({"formatVersion":1,"exportedAtMs":1_792_000_000_000u64,"account":{"id":"user-a"}});
        let first = write_export_file(&dir, &export).unwrap();
        let second = write_export_file(&dir, &export).unwrap();
        assert_ne!(first, second);
        assert!(first.file_name().unwrap().to_string_lossy().starts_with("live-interview-account-export-2026-10-"));
        assert_eq!(std::fs::metadata(&first).unwrap().permissions().mode() & 0o777, 0o600);
        let saved: Value = serde_json::from_slice(&std::fs::read(&first).unwrap()).unwrap();
        assert_eq!(saved["account"]["id"], "user-a");
        std::fs::remove_dir_all(&dir).unwrap();
    }
    #[test]
    fn only_account_exports_reach_the_disk() {
        let dir = std::env::temp_dir().join(format!("li-export-bad-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        for bad in [json!({}), json!({"formatVersion":2,"account":{"id":"a"},"exportedAtMs":1}), json!({"formatVersion":1,"account":{},"exportedAtMs":1}), json!("text")] {
            assert!(write_export_file(&dir, &bad).is_err());
        }
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }
    #[test]
    fn account_deletion_errors_keep_their_meaning_and_nothing_else() {
        for code in ["rateLimited", "confirmationRequired", "billingOwnershipMismatch", "billingUnavailable", "billingNotConfigured"] {
            assert_eq!(safe_code(code), code);
        }
        assert_eq!(safe_code("synthetic upstream detail"), "serviceUnavailable");
    }
    #[test]
    fn origin_policy_rejects_userinfo_non_https_and_remote_development_http() {
        assert!(checked_origin("https://api.example.test", false).is_ok());
        for value in [
            "http://api.example.test",
            "https://person:secret@api.example.test",
            "https://api.example.test/path",
            "file:///tmp/x",
            "https://api.example.test?token=x",
        ] {
            assert!(checked_origin(value, false).is_err());
        }
        assert!(checked_origin("http://127.0.0.1:4545", true).is_ok());
        assert!(checked_origin("http://127.0.0.1:4545", false).is_err());
        assert!(checked_origin("http://192.168.1.2:4545", true).is_err());
    }
    #[test]
    fn account_output_passes_reset_and_payment_grace_times_only_as_numbers() {
        let status = sanitize_account(
            &json!({"configured":true,"signedIn":true,"plan":"standard","subscriptionStatus":"past_due","canUseAI":true,"user":{"id":"user-a"},"usageResetsAtMs":1794689575000u64,"paymentGraceEndsAtMs":1794430375000u64}),
        );
        assert_eq!(status["usageResetsAtMs"], 1794689575000u64);
        assert_eq!(status["paymentGraceEndsAtMs"], 1794430375000u64);
        let odd = sanitize_account(
            &json!({"configured":true,"signedIn":true,"user":{"id":"user-a"},"paymentGraceEndsAtMs":"soon"}),
        );
        assert!(odd.get("paymentGraceEndsAtMs").is_none());
        let signed_out = sanitize_account(&json!({"paymentGraceEndsAtMs":1u64}));
        assert!(signed_out.get("paymentGraceEndsAtMs").is_none());
    }
    #[test]
    fn account_output_cannot_expose_backend_credentials_or_grant_missing_state() {
        let status = sanitize_account(
            &json!({"configured":true,"signedIn":true,"plan":"premium","subscriptionStatus":"active","canUseAI":true,"canAutoPrepare":true,"billingAvailable":true,"sessionToken":"private-fixture","user":{"id":"user-a","email":"user@example.test","token":"nested-private-fixture"}}),
        );
        assert_eq!(status["user"]["id"], "user-a");
        assert!(!status.to_string().contains("private-fixture"));
        assert_eq!(
            sanitize_account(&json!({"plan":"premium"}))["canUseAI"],
            false
        );
    }
    #[test]
    fn response_cannot_cross_job_or_context_revision() {
        let job = json!({"id":"job-a","basis":{"stateRevision":4}});
        let response = json!({"jobId":"job-a","basis":{"stateRevision":4},"outcome":"complete","output":{"say":"text"}});
        assert!(validate_model_result(&job, &response).is_ok());
        assert!(validate_model_result(
            &job,
            &json!({"jobId":"other","basis":{"stateRevision":4},"outcome":"complete"})
        )
        .is_err());
        assert!(validate_model_result(
            &job,
            &json!({"jobId":"job-a","basis":{"stateRevision":3},"outcome":"complete"})
        )
        .is_err());
    }
    #[test]
    fn sign_in_codes_are_short_plain_text() {
        assert_eq!(sign_in_code(&json!("BCDF-GHJK")), Some("BCDF-GHJK"));
        for bad in [json!(""), json!("<b>x</b>"), json!("A".repeat(17)), json!(5)] {
            assert_eq!(sign_in_code(&bad), None);
        }
    }
    #[test]
    fn billing_and_device_urls_remain_on_their_authorized_destinations() {
        let origin = checked_origin("https://service.example.test", false).unwrap();
        assert!(same_origin_url(&origin, "https://service.example.test/auth/device").is_ok());
        assert!(same_origin_url(&origin, "https://evil.example/auth").is_err());
        assert!(billing_url("https://checkout.stripe.com/c/fixture").is_ok());
        assert!(billing_url("https://billing.stripe.com/p/session/fixture").is_ok());
        assert!(billing_url("https://checkout.stripe.com.evil.test/c/fixture").is_err());
        assert!(billing_url("https://checkout.stripe.com:8443/c/fixture").is_err());
    }
    #[test]
    fn cancelling_a_pending_sign_in_keeps_the_saved_session_and_rejects_the_late_approval() {
        let mut cache = SessionCache::default();
        let first = cache.next_generation();
        assert!(cache.accept(
            Session {
                session_token: "session-one".into(),
                expires_at_ms: 1,
                sign_in_required_at_ms: None,
            },
            first
        ));
        let pending = cache.next_generation();
        cache.cancel_pending_sign_in();
        assert!(!cache.accept(
            Session {
                session_token: "late-approval".into(),
                expires_at_ms: 1,
                sign_in_required_at_ms: None,
            },
            pending
        ));
        assert!(cache.matches_token("session-one"));
    }
    fn session(token: &str, expires: u64, cap: Option<u64>) -> Session {
        Session {
            session_token: token.into(),
            expires_at_ms: expires,
            sign_in_required_at_ms: cap,
        }
    }
    #[test]
    fn renewal_is_due_only_near_expiry_and_before_the_sign_in_lifetime_ends() {
        let now = 1_000_000_000_000u64;
        let day = 86_400_000;
        assert!(!renewal_due(&session("t", now + 8 * day, None), now));
        assert!(renewal_due(&session("t", now + 7 * day, None), now));
        assert!(renewal_due(&session("t", now + day, Some(now + 60 * day)), now));
        // The service said this sign-in cannot be extended further.
        assert!(!renewal_due(&session("t", now + day, Some(now + day)), now));
    }
    #[test]
    fn a_renewal_keeps_calls_in_flight_current_and_never_revives_a_signed_out_session() {
        let mut cache = SessionCache::default();
        let generation = cache.next_generation();
        assert!(cache.accept(session("old", 10, None), generation));
        assert!(cache.adopt_renewal("old", generation, session("new", 20, Some(30))));
        assert!(cache.matches_token("new"));
        // A call that started with the old token is still answered.
        assert!(cache.response_is_current("old", generation));
        assert!(cache.response_is_current("new", generation));
        // A late renewal of a token that is no longer current changes nothing.
        assert!(!cache.adopt_renewal("old", generation, session("other", 40, None)));
        assert!(cache.matches_token("new"));
        // Signing out (a new generation) wins over a renewal that finishes later.
        let signed_out = cache.next_generation();
        cache.session = None;
        assert!(!cache.adopt_renewal("new", generation, session("late", 50, None)));
        assert!(cache.session.is_none());
        assert!(!cache.response_is_current("old", generation));
        // A new sign-in forgets the replaced token.
        assert!(cache.accept(session("fresh", 60, None), signed_out));
        assert!(!cache.response_is_current("old", signed_out));
    }
    #[test]
    fn a_saved_session_without_a_lifetime_cap_still_loads() {
        let s: Session = serde_json::from_str(r#"{"sessionToken":"t","expiresAtMs":5}"#).unwrap();
        assert_eq!(s.sign_in_required_at_ms, None);
        let saved = serde_json::to_string(&session("t", 5, Some(9))).unwrap();
        assert!(saved.contains("\"signInRequiredAtMs\":9"));
    }
    #[test]
    fn stale_auth_failure_and_cancelled_login_cannot_replace_a_new_session() {
        let mut cache = SessionCache::default();
        let generation = cache.next_generation();
        assert!(cache.accept(
            Session {
                session_token: "session-one".into(),
                expires_at_ms: 1,
                sign_in_required_at_ms: None,
            },
            generation
        ));
        let login_two = cache.next_generation();
        cache.next_generation(); // explicit logout invalidates pending approval
        assert!(!cache.accept(
            Session {
                session_token: "cancelled-session".into(),
                expires_at_ms: 1,
                sign_in_required_at_ms: None,
            },
            login_two
        ));
        let login_three = cache.next_generation();
        assert!(cache.accept(
            Session {
                session_token: "session-three".into(),
                expires_at_ms: 1,
                sign_in_required_at_ms: None,
            },
            login_three
        ));
        assert!(!cache.matches_token("session-one"));
        assert!(cache.matches_token("session-three"));
    }
}

#[cfg(test)]
mod transport_tests {
    use super::*;
    use std::io::{Read, Write};
    fn fixture(status: &str, body: &str, extra: &str) -> (String, std::thread::JoinHandle<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let response=format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}",body.len());
        let thread = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut bytes = [0u8; 8192];
            let read = stream.read(&mut bytes).unwrap();
            stream.write_all(response.as_bytes()).unwrap();
            String::from_utf8_lossy(&bytes[..read]).into_owned()
        });
        (format!("http://{address}"), thread)
    }
    #[tokio::test]
    async fn authenticated_http_keeps_bearer_in_native_header_and_sanitizes_service_errors() {
        let (origin, server) = fixture(
            "401 Unauthorized",
            r#"{"error":{"code":"unauthenticated","detail":"private server message"}}"#,
            "",
        );
        let client = ServiceClient::new(&origin, true).unwrap();
        let result = client
            .request(
                Method::GET,
                "/v1/account",
                None,
                Some("synthetic-session-only"),
                Duration::from_secs(2),
            )
            .await;
        assert_eq!(result.unwrap_err(), "unauthenticated");
        let request = server.join().unwrap();
        assert!(request
            .to_lowercase()
            .contains("authorization: bearer synthetic-session-only"));
        assert!(!request
            .lines()
            .next()
            .unwrap()
            .contains("synthetic-session-only"));
    }
    #[tokio::test]
    async fn renewal_reads_a_rotated_token_or_keeps_the_old_one_and_rejects_anything_else() {
        let far = now_ms() + 30 * 86_400_000;
        let old = Session {
            session_token: "synthetic-old-session-token-0123456789".into(),
            expires_at_ms: now_ms() + 86_400_000,
            sign_in_required_at_ms: None,
        };
        let body = format!(r#"{{"renewed":true,"sessionToken":"synthetic-new-session-token-0123456789","expiresAtMs":{far},"signInRequiredAtMs":{}}}"#, far + 1);
        let (origin, server) = fixture("200 OK", &body, "");
        let renewed = renew_session(&ServiceClient::new(&origin, true).unwrap(), &old).await.unwrap();
        assert_eq!(renewed.session_token, "synthetic-new-session-token-0123456789");
        assert_eq!((renewed.expires_at_ms, renewed.sign_in_required_at_ms), (far, Some(far + 1)));
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /v1/auth/renew "));
        assert!(request.to_lowercase().contains("authorization: bearer synthetic-old-session-token"));
        let body = format!(r#"{{"renewed":false,"expiresAtMs":{far},"signInRequiredAtMs":{far}}}"#);
        let (origin, _server) = fixture("200 OK", &body, "");
        let kept = renew_session(&ServiceClient::new(&origin, true).unwrap(), &old).await.unwrap();
        assert_eq!(kept.session_token, old.session_token);
        assert_eq!(kept.sign_in_required_at_ms, Some(far));
        for bad in [
            format!(r#"{{"renewed":true,"sessionToken":"short","expiresAtMs":{far}}}"#),
            r#"{"renewed":true,"sessionToken":"synthetic-new-session-token-0123456789","expiresAtMs":1}"#.to_string(),
            format!(r#"{{"renewed":"yes","expiresAtMs":{far}}}"#),
        ] {
            let (origin, _server) = fixture("200 OK", &bad, "");
            // Session has no Debug (it holds a token), so no unwrap_err here.
            let result = renew_session(&ServiceClient::new(&origin, true).unwrap(), &old).await;
            assert_eq!(result.err().as_deref(), Some("invalidServiceResponse"));
        }
    }
    #[tokio::test]
    async fn redirects_do_not_forward_a_product_session_to_another_origin() {
        let (origin, server) = fixture(
            "302 Found",
            "{}",
            "Location: https://untrusted.example/v1/account\r\n",
        );
        let client = ServiceClient::new(&origin, true).unwrap();
        assert_eq!(
            client
                .request(
                    Method::GET,
                    "/v1/account",
                    None,
                    Some("synthetic-session-only"),
                    Duration::from_secs(2)
                )
                .await
                .unwrap_err(),
            "serviceUnavailable"
        );
        server.join().unwrap();
    }
    #[tokio::test]
    async fn malformed_responses_are_not_presented_as_a_signed_in_account() {
        let (origin, server) = fixture("200 OK", "not json", "");
        let client = ServiceClient::new(&origin, true).unwrap();
        assert_eq!(
            client
                .request(
                    Method::GET,
                    "/v1/account",
                    None,
                    None,
                    Duration::from_secs(2)
                )
                .await
                .unwrap_err(),
            "invalidServiceResponse"
        );
        server.join().unwrap();
    }
    #[tokio::test]
    async fn oversized_stream_is_rejected_before_waiting_for_the_body_to_finish() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 8192];
            let _ = stream.read(&mut request);
            let _ = stream.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
            );
            let _ = stream.write_all(&vec![b' '; 1_010_000]);
            std::thread::sleep(Duration::from_secs(1));
        });
        let client = ServiceClient::new(&format!("http://{address}"), true).unwrap();
        let request = client.request(
            Method::GET,
            "/v1/account",
            None,
            None,
            Duration::from_secs(2),
        );
        let result = tokio::time::timeout(Duration::from_millis(500), request).await;
        server.join().unwrap();
        assert_eq!(
            result
                .expect("must reject bounded body without waiting for connection close")
                .unwrap_err(),
            "invalidServiceResponse"
        );
    }
    /// Serves one canned HTTP response in the given pieces (pausing between them),
    /// then closes the connection. Returns the origin to call.
    fn serve(status_and_headers: &'static str, pieces: Vec<Vec<u8>>) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 8192];
            let _ = stream.read(&mut request);
            let _ = stream.write_all(status_and_headers.as_bytes());
            for piece in pieces {
                let _ = stream.write_all(&piece);
                let _ = stream.flush();
                std::thread::sleep(Duration::from_millis(60));
            }
        });
        format!("http://{address}")
    }
    const SSE: &str =
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nConnection: close\r\n\r\n";
    async fn stream_call(origin: &str) -> Result<StreamedResult, String> {
        stream_updates(origin, &mut |_| {}).await
    }
    async fn stream_updates(
        origin: &str,
        on_update: &mut (dyn FnMut(StreamUpdate) + Send),
    ) -> Result<StreamedResult, String> {
        ServiceClient::new(origin, true)
            .unwrap()
            .request_stream(
                "/v1/reasoning/stream",
                &json!({"job":{"id":"job-a"},"prompt":"p"}),
                "token",
                Duration::from_secs(5),
                on_update,
            )
            .await
    }
    #[test]
    fn sse_parser_frames_events_across_chunks_and_crlf() {
        let mut parser = SseParser::default();
        assert!(parser
            .push(b"event: delta\ndata: {\"te")
            .unwrap()
            .is_empty());
        let events = parser
            .push(b"xt\":\"a\"}\n\nevent: result\r\ndata: {\"ok\":true}\r\n\r\n: comment\n\n")
            .unwrap();
        assert_eq!(
            events,
            vec![
                SseEvent {
                    event: "delta".into(),
                    data: "{\"text\":\"a\"}".into()
                },
                SseEvent {
                    event: "result".into(),
                    data: "{\"ok\":true}".into()
                },
            ]
        );
    }
    #[test]
    fn sse_parser_bounds_events_and_streams() {
        let mut parser = SseParser::default();
        assert_eq!(
            parser.push(&vec![b'x'; 1_000_001]).unwrap_err(),
            "invalidServiceResponse"
        );
        let mut parser = SseParser::default();
        let event = format!("event: delta\ndata: {}\n\n", "x".repeat(900_000));
        let mut failed = false;
        for _ in 0..6 {
            failed |= parser.push(event.as_bytes()).is_err();
        }
        assert!(failed, "the whole stream is bounded too");
        assert!(SseParser::default()
            .push(b"event: x\ndata: \xff\n\n")
            .is_err());
    }
    #[tokio::test]
    async fn stream_returns_the_result_and_times_the_first_delta() {
        let origin = serve(
            SSE,
            vec![
                b"event: delta\ndata: {\"text\":\"{\"}\n\n".to_vec(),
                b"event: delta\ndata: {\"text\":\"x\"}\n\n".to_vec(),
                b"event: result\ndata: {\"jobId\":\"job-a\",\"outcome\":\"complete\"}\n\n".to_vec(),
            ],
        );
        let streamed = stream_call(&origin).await.unwrap();
        assert_eq!(streamed.value["jobId"], "job-a");
        assert!(streamed.first_token_ms.is_some());
    }
    #[tokio::test]
    async fn stream_reports_provisional_text_and_resets_before_the_result() {
        let origin = serve(
            SSE,
            vec![
                b"event: delta\ndata: {\"text\":\"{\\\"say\\\":\\\"De\"}\n\n".to_vec(),
                b"event: reset\ndata: {}\n\n".to_vec(),
                b"event: delta\ndata: {not json}\n\n".to_vec(),
                b"event: delta\ndata: {\"text\":\"{\\\"say\\\":\\\"Fa\"}\n\n".to_vec(),
                b"event: result\ndata: {\"jobId\":\"job-a\",\"outcome\":\"complete\"}\n\n".to_vec(),
            ],
        );
        let mut updates = Vec::new();
        let streamed = stream_updates(&origin, &mut |u| updates.push(u))
            .await
            .unwrap();
        assert_eq!(
            updates,
            vec![
                StreamUpdate::Delta("{\"say\":\"De".into()),
                StreamUpdate::Reset,
                StreamUpdate::Delta("{\"say\":\"Fa".into()),
            ]
        );
        assert_eq!(streamed.value["jobId"], "job-a");
    }
    #[tokio::test]
    async fn a_reset_clears_the_first_token_of_the_abandoned_route() {
        let origin = serve(
            SSE,
            vec![
                b"event: delta\ndata: {\"text\":\"{\"}\n\n".to_vec(),
                b"event: reset\ndata: {}\n\n".to_vec(),
                b"event: result\ndata: {\"jobId\":\"job-a\",\"outcome\":\"complete\"}\n\n".to_vec(),
            ],
        );
        assert!(stream_call(&origin).await.unwrap().first_token_ms.is_none());
    }
    #[tokio::test]
    async fn stream_without_a_delta_still_returns_the_result_with_no_first_token() {
        let origin = serve(
            SSE,
            vec![
                b"event: result\ndata: {\"jobId\":\"job-a\",\"outcome\":\"complete\"}\n\n".to_vec(),
            ],
        );
        let streamed = stream_call(&origin).await.unwrap();
        assert!(streamed.first_token_ms.is_none());
    }
    #[tokio::test]
    async fn stream_failures_surface_only_safe_codes() {
        let after_text = serve(
            SSE,
            vec![
                b"event: delta\ndata: {\"text\":\"{\"}\n\n".to_vec(),
                b"event: error\ndata: {\"code\":\"providerUnavailable\"}\n\n".to_vec(),
            ],
        );
        assert_eq!(
            stream_call(&after_text).await.err().unwrap(),
            "providerUnavailable"
        );
        let unknown = serve(
            SSE,
            vec![b"event: error\ndata: {\"code\":\"upstream secret detail\"}\n\n".to_vec()],
        );
        assert_eq!(
            stream_call(&unknown).await.err().unwrap(),
            "serviceUnavailable"
        );
        let cut = serve(
            SSE,
            vec![b"event: delta\ndata: {\"text\":\"{\"}\n\n".to_vec()],
        );
        assert_eq!(stream_call(&cut).await.err().unwrap(), "streamInterrupted");
        let json = serve(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
            vec![b"{}".to_vec()],
        );
        assert_eq!(
            stream_call(&json).await.err().unwrap(),
            "invalidServiceResponse"
        );
    }
    #[tokio::test]
    async fn stream_admission_errors_are_the_ordinary_json_errors() {
        let refused = serve(
            "HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
            vec![b"{\"error\":{\"code\":\"allowanceExceeded\"}}".to_vec()],
        );
        assert_eq!(
            stream_call(&refused).await.err().unwrap(),
            "allowanceExceeded"
        );
        let replay = serve(
            "HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
            vec![b"{\"error\":{\"code\":\"jobAlreadyFailed\"}}".to_vec()],
        );
        // A dispatched job is never retried on the other route.
        assert_eq!(
            stream_call(&replay).await.err().unwrap(),
            "serviceUnavailable"
        );
    }
    #[tokio::test]
    async fn only_a_missing_route_asks_for_the_non_streaming_fallback() {
        for status in [
            "404 Not Found",
            "405 Method Not Allowed",
            "501 Not Implemented",
        ] {
            let head: &'static str = Box::leak(
                format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n")
                    .into_boxed_str(),
            );
            let origin = serve(head, vec![b"{\"error\":{\"code\":\"notFound\"}}".to_vec()]);
            assert_eq!(
                stream_call(&origin).await.err().unwrap(),
                "streamUnsupported"
            );
        }
        let server_error = serve(
            "HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
            vec![b"{\"error\":{\"code\":\"providerNotConfigured\"}}".to_vec()],
        );
        assert_eq!(
            stream_call(&server_error).await.err().unwrap(),
            "providerNotConfigured"
        );
    }
}
