//! Direct, read-only calendar connections. OAuth credentials remain in the public app Keychain.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::Duration,
};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use url::Url;
const KEYCHAIN_SERVICE: &str = "com.karim.liveinterview.public";
/// Serialises read-modify-write sequences on `calendars.sqlite` (accounts, selections, cached
/// events). Held only around local store work: never across the OAuth browser wait, network
/// requests or a calendar helper spawn, so a reviewed calendar move never waits on a sync.
static STORE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// Serialises Keychain token changes: refresh, replacement on connect and deletion on disconnect.
/// The refresh path loads the tokens only after taking it, so a second caller sees the token the
/// first one saved instead of redeeming the same refresh token twice (Microsoft rotates refresh
/// tokens), and a disconnect cannot be undone by a refresh that finishes after it. It is held
/// across the token request itself, which is bounded by the HTTP client timeout. Lock order:
/// `TOKEN_LOCK` before `STORE_LOCK`.
static TOKEN_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// Least-privilege scopes. Changing these after a provider review re-triggers verification
/// (Google) or re-consent (both), so the exact lists are pinned by tests and by
/// docs/public/calendar-verification-pack.md. Google: `calendarList.list` needs
/// `calendar.calendarlist.readonly` and `events.list` needs `calendar.events.readonly`; the
/// broader `calendar.readonly` is not requested any more. Microsoft stays on `Calendars.Read`
/// because Graph does not document that `Calendars.ReadBasic` returns attendees, organizer or
/// online-meeting join links (see the pack, finding 2).
pub const GOOGLE_SCOPES: [&str; 5] = [
    "openid",
    "profile",
    "email",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events.readonly",
];
pub const MICROSOFT_SCOPES: [&str; 5] = [
    "openid",
    "profile",
    "email",
    "offline_access",
    "https://graph.microsoft.com/Calendars.Read",
];
const GOOGLE_LEGACY_READONLY_SCOPE: &str = "https://www.googleapis.com/auth/calendar.readonly";
/// Only the fields `parse_event` and `refresh_sources` read are requested from the providers.
pub const GOOGLE_CALENDAR_LIST_FIELDS: &str =
    "nextPageToken,items(id,summary,summaryOverride,accessRole,timeZone,backgroundColor)";
pub const GOOGLE_EVENT_FIELDS: &str = "nextPageToken,items(id,status,summary,start,end,originalStartTime,recurringEventId,organizer(email),attendees(displayName,email),hangoutLink,etag)";
pub const MICROSOFT_CALENDAR_SELECT: &str = "id,name,hexColor";
pub const MICROSOFT_EVENT_SELECT: &str = "id,subject,start,end,isAllDay,type,originalStart,seriesMasterId,isCancelled,organizer,attendees,onlineMeeting,changeKey";
pub const GOOGLE_REVOKE_ENDPOINT: &str = "https://oauth2.googleapis.com/revoke";
pub fn scope_string(provider: &str) -> String {
    if provider == "microsoft" {
        MICROSOFT_SCOPES.join(" ")
    } else {
        GOOGLE_SCOPES.join(" ")
    }
}
/// Whether the scopes a token response reports are enough for the two calendar requests the app
/// makes. A Google user can untick one box on the consent screen (granular consent), so the new
/// pair may arrive partly granted; tokens issued under the legacy `calendar.readonly` scope
/// remain sufficient for both endpoints.
pub fn scope_covers(provider: &str, granted: &str) -> bool {
    let granted = granted.to_ascii_lowercase();
    let has = |scope: &str| granted.split_whitespace().any(|g| g == scope.to_ascii_lowercase());
    if provider == "microsoft" {
        // Graph may report scopes with or without the resource prefix, possibly URL-encoded.
        // Compare each scope exactly so ReadBasic, ReadWrite or .Shared do not count.
        granted
            .replace("%20", " ")
            .replace('+', " ")
            .replace("%2f", "/")
            .replace("%3a", ":")
            .split_whitespace()
            .any(|g| {
                g.strip_prefix("https://graph.microsoft.com/")
                    .unwrap_or(g)
                    == "calendars.read"
            })
    } else {
        let legacy = has(GOOGLE_LEGACY_READONLY_SCOPE);
        (legacy || has(GOOGLE_SCOPES[3])) && (legacy || has(GOOGLE_SCOPES[4]))
    }
}
fn now() -> u64 {
    crate::public_domain::now_ms()
}
fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn random() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}
fn provider_valid(p: &str) -> bool {
    matches!(p, "microsoft" | "google" | "apple")
}
fn same_secret(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |d, (a, b)| d | (a ^ b)) == 0
}
fn client_id(provider: &str) -> anyhow::Result<String> {
    let id = match provider {
        "microsoft" => option_env!("PUBLIC_MICROSOFT_CLIENT_ID"),
        "google" => option_env!("PUBLIC_GOOGLE_CLIENT_ID"),
        _ => None,
    };
    id.filter(|id| !id.trim().is_empty() && id.len() <= 512)
        .map(str::to_owned)
        .ok_or_else(|| anyhow::anyhow!("calendarPublisherConfigurationRequired"))
}
fn http() -> anyhow::Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(25))
        .build()?)
}
async fn response_json(response: reqwest::Response) -> anyhow::Result<Value> {
    use futures_util::StreamExt;
    anyhow::ensure!(
        response.status().is_success(),
        match response.status().as_u16() {
            401 => "calendarReauthenticationRequired",
            403 => "calendarAccessDenied",
            429 => "calendarRateLimited",
            _ => "calendarProviderUnavailable",
        }
    );
    let mut body = vec![];
    let mut chunks = response.bytes_stream();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk.map_err(|_| anyhow::anyhow!("calendarNetworkUnavailable"))?;
        anyhow::ensure!(
            body.len() + chunk.len() <= 4_000_000,
            "calendarResponseTooLarge"
        );
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| anyhow::anyhow!("calendarMalformedResponse"))
}
/// The local OAuth callback listener. It always listens on 127.0.0.1; for a `localhost` redirect
/// it also listens on `[::1]` at the same port (when the Mac has an IPv6 loopback), so the
/// browser reaches it whichever address `localhost` resolves to first.
pub struct LoopbackListener {
    pub port: u16,
    v4: tokio::net::TcpListener,
    v6: Option<tokio::net::TcpListener>,
}
impl LoopbackListener {
    pub fn has_ipv6(&self) -> bool {
        self.v6.is_some()
    }
    pub async fn accept(&self) -> std::io::Result<(tokio::net::TcpStream, std::net::SocketAddr)> {
        match &self.v6 {
            None => self.v4.accept().await,
            Some(v6) => tokio::select! {
                r = self.v4.accept() => r,
                r = v6.accept() => r,
            },
        }
    }
}
pub async fn bind_loopback(also_ipv6: bool) -> std::io::Result<LoopbackListener> {
    let mut last = None;
    for _ in 0..16 {
        let v4 = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let port = v4.local_addr()?.port();
        if !also_ipv6 {
            return Ok(LoopbackListener { port, v4, v6: None });
        }
        match tokio::net::TcpListener::bind(("::1", port)).await {
            Ok(v6) => {
                return Ok(LoopbackListener {
                    port,
                    v4,
                    v6: Some(v6),
                })
            }
            // The IPv6 side of this port is taken by another process: try another port.
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => last = Some(e),
            // No usable IPv6 loopback on this Mac (not available, not permitted, ...): the
            // previous IPv4-only listener keeps working, so never fail the sign-in over it.
            Err(_) => return Ok(LoopbackListener { port, v4, v6: None }),
        }
    }
    Err(last.unwrap_or_else(|| std::io::Error::other("loopback unavailable")))
}
/// Microsoft registers `http://localhost` (the port is ignored when matching; [::1] is not
/// supported as a redirect) so the redirect uses `localhost`; Google uses the literal IP.
pub fn loopback_redirect(provider: &str, port: u16) -> String {
    format!(
        "http://{}:{port}/",
        if provider == "microsoft" {
            "localhost"
        } else {
            "127.0.0.1"
        }
    )
}
/// One bounded, single-use browser login. Only its random state is exposed to test callers.
pub struct OAuthAttempt {
    provider: String,
    client_id: String,
    redirect_uri: String,
    pub state: String,
    nonce: String,
    verifier: String,
    expires_ms: u64,
}
impl OAuthAttempt {
    pub fn new(
        provider: &str,
        client_id: &str,
        redirect_uri: &str,
        now_ms: u64,
    ) -> anyhow::Result<Self> {
        anyhow::ensure!(
            matches!(provider, "microsoft" | "google") && !client_id.is_empty(),
            "calendarPublisherConfigurationRequired"
        );
        let redirect = Url::parse(redirect_uri)?;
        anyhow::ensure!(
            redirect.scheme() == "http"
                && matches!(redirect.host_str(), Some("127.0.0.1" | "localhost"))
                && redirect.port().is_some()
                && redirect.query().is_none()
                && redirect.fragment().is_none()
                && redirect.username().is_empty()
                && redirect.password().is_none(),
            "invalidCallback"
        );
        Ok(Self {
            provider: provider.into(),
            client_id: client_id.into(),
            redirect_uri: redirect_uri.into(),
            state: random(),
            nonce: random(),
            verifier: random(),
            expires_ms: now_ms + 300_000,
        })
    }
    pub fn authorization_url(&self) -> anyhow::Result<String> {
        let mut url = Url::parse(if self.provider == "microsoft" {
            "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
        } else {
            "https://accounts.google.com/o/oauth2/v2/auth"
        })?;
        let scope = scope_string(&self.provider);
        url.query_pairs_mut().extend_pairs([
            ("client_id", self.client_id.as_str()),
            ("response_type", "code"),
            ("redirect_uri", self.redirect_uri.as_str()),
            ("scope", scope.as_str()),
            ("state", self.state.as_str()),
            ("nonce", self.nonce.as_str()),
            (
                "code_challenge",
                URL_SAFE_NO_PAD
                    .encode(Sha256::digest(self.verifier.as_bytes()))
                    .as_str(),
            ),
            ("code_challenge_method", "S256"),
            ("prompt", "select_account"),
        ]);
        if self.provider == "google" {
            url.query_pairs_mut()
                .append_pair("access_type", "offline")
                .append_pair("prompt", "consent select_account");
        }
        Ok(url.into())
    }
    pub fn validate_callback(&self, target: &str, now_ms: u64) -> anyhow::Result<String> {
        anyhow::ensure!(now_ms < self.expires_ms, "calendarAuthorizationExpired");
        anyhow::ensure!(
            target.starts_with('/') && !target.starts_with("//") && target.len() <= 16_384,
            "invalidCallback"
        );
        let redirect = Url::parse(&self.redirect_uri)?;
        let callback = redirect.join(target)?;
        anyhow::ensure!(
            callback.path() == redirect.path() && callback.fragment().is_none(),
            "invalidCallback"
        );
        let pairs = callback.query_pairs().collect::<Vec<_>>();
        let states = pairs
            .iter()
            .filter(|(k, _)| k == "state")
            .collect::<Vec<_>>();
        anyhow::ensure!(
            states.len() == 1 && same_secret(states[0].1.as_ref(), &self.state),
            "calendarAuthorizationStateMismatch"
        );
        anyhow::ensure!(
            !pairs.iter().any(|(k, _)| k == "error"),
            "calendarAuthorizationDenied"
        );
        let codes = pairs
            .iter()
            .filter(|(k, _)| k == "code")
            .collect::<Vec<_>>();
        anyhow::ensure!(
            codes.len() == 1 && !codes[0].1.is_empty() && codes[0].1.len() <= 8192,
            "invalidCallback"
        );
        Ok(codes[0].1.to_string())
    }
    pub fn validate_claims(&self, claims: &Value, now_ms: u64) -> anyhow::Result<()> {
        anyhow::ensure!(now_ms < self.expires_ms, "calendarAuthorizationExpired");
        anyhow::ensure!(
            claims["nonce"]
                .as_str()
                .is_some_and(|n| same_secret(n, &self.nonce)),
            "calendarAuthorizationNonceMismatch"
        );
        anyhow::ensure!(
            claims["sub"]
                .as_str()
                .is_some_and(|s| !s.is_empty() && s.len() <= 512),
            "calendarInvalidIdentity"
        );
        let audience = claims["aud"].as_str() == Some(self.client_id.as_str())
            || claims["aud"]
                .as_array()
                .is_some_and(|a| a.len() == 1 && a[0].as_str() == Some(self.client_id.as_str()));
        anyhow::ensure!(audience, "calendarInvalidAudience");
        anyhow::ensure!(
            claims["exp"].as_u64().is_some_and(|e| e > now_ms / 1000)
                && claims["iat"]
                    .as_u64()
                    .is_none_or(|i| i <= now_ms / 1000 + 60),
            "calendarExpiredIdentity"
        );
        let issuer = claims["iss"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("calendarInvalidIssuer"))?;
        if self.provider == "google" {
            anyhow::ensure!(
                matches!(
                    issuer,
                    "https://accounts.google.com" | "accounts.google.com"
                ),
                "calendarInvalidIssuer"
            );
        } else {
            let tenant = claims["tid"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("calendarInvalidIssuer"))?;
            anyhow::ensure!(
                uuid::Uuid::parse_str(tenant).is_ok()
                    && issuer == format!("https://login.microsoftonline.com/{tenant}/v2.0"),
                "calendarInvalidIssuer"
            );
        }
        Ok(())
    }
    async fn verify_identity(
        &self,
        client: &reqwest::Client,
        token: &str,
    ) -> anyhow::Result<Value> {
        let endpoint = if self.provider == "microsoft" {
            "https://login.microsoftonline.com/common/discovery/v2.0/keys"
        } else {
            "https://www.googleapis.com/oauth2/v3/certs"
        };
        let keys = response_json(
            client
                .get(endpoint)
                .send()
                .await
                .map_err(|_| anyhow::anyhow!("calendarNetworkUnavailable"))?,
        )
        .await?;
        let keys: jsonwebtoken::jwk::JwkSet = serde_json::from_value(keys)
            .map_err(|_| anyhow::anyhow!("calendarInvalidSignature"))?;
        self.verify_signed_identity(token, &keys, now())
    }
    fn verify_signed_identity(
        &self,
        token: &str,
        keys: &jsonwebtoken::jwk::JwkSet,
        now_ms: u64,
    ) -> anyhow::Result<Value> {
        let header = jsonwebtoken::decode_header(token)
            .map_err(|_| anyhow::anyhow!("calendarInvalidIdentity"))?;
        anyhow::ensure!(
            header.alg == jsonwebtoken::Algorithm::RS256,
            "calendarInvalidSignature"
        );
        let kid = header
            .kid
            .ok_or_else(|| anyhow::anyhow!("calendarInvalidSignature"))?;
        let key = keys
            .find(&kid)
            .ok_or_else(|| anyhow::anyhow!("calendarInvalidSignature"))?;
        let key = jsonwebtoken::DecodingKey::from_jwk(key)
            .map_err(|_| anyhow::anyhow!("calendarInvalidSignature"))?;
        let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
        validation.set_audience(&[&self.client_id]);
        validation.leeway = 30;
        let token = jsonwebtoken::decode::<Value>(token, &key, &validation)
            .map_err(|_| anyhow::anyhow!("calendarInvalidIdentity"))?;
        self.validate_claims(&token.claims, now_ms)?;
        Ok(token.claims)
    }
}
#[derive(serde::Serialize, serde::Deserialize)]
struct Tokens {
    access_token: String,
    refresh_token: Option<String>,
    expires_ms: u64,
    client_id: String,
    provider: String,
}
fn token_endpoint(provider: &str) -> &'static str {
    if provider == "microsoft" {
        "https://login.microsoftonline.com/common/oauth2/v2.0/token"
    } else {
        "https://oauth2.googleapis.com/token"
    }
}
#[cfg(target_os = "macos")]
fn save_tokens(account: &str, tokens: &Tokens) -> anyhow::Result<()> {
    security_framework::passwords::set_generic_password(
        KEYCHAIN_SERVICE,
        &format!("calendar:{account}"),
        &serde_json::to_vec(tokens)?,
    )
    .map_err(|_| anyhow::anyhow!("calendarKeychainUnavailable"))
}
#[cfg(target_os = "macos")]
fn load_tokens(account: &str) -> anyhow::Result<Tokens> {
    let bytes = security_framework::passwords::get_generic_password(
        KEYCHAIN_SERVICE,
        &format!("calendar:{account}"),
    )
    .map_err(|_| anyhow::anyhow!("calendarReauthenticationRequired"))?;
    serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("calendarReauthenticationRequired"))
}
#[cfg(target_os = "macos")]
fn delete_tokens(account: &str) -> anyhow::Result<()> {
    match security_framework::passwords::delete_generic_password(
        KEYCHAIN_SERVICE,
        &format!("calendar:{account}"),
    ) {
        Ok(()) => Ok(()),
        Err(e) if e.code() == -25300 => Ok(()),
        Err(_) => anyhow::bail!("calendarKeychainUnavailable"),
    }
}
#[cfg(not(target_os = "macos"))]
fn save_tokens(_: &str, _: &Tokens) -> anyhow::Result<()> {
    anyhow::bail!("calendarPlatformUnsupported")
}
#[cfg(not(target_os = "macos"))]
fn load_tokens(_: &str) -> anyhow::Result<Tokens> {
    anyhow::bail!("calendarPlatformUnsupported")
}
#[cfg(not(target_os = "macos"))]
fn delete_tokens(_: &str) -> anyhow::Result<()> {
    anyhow::bail!("calendarPlatformUnsupported")
}
fn tokens_from(
    value: &Value,
    provider: &str,
    client_id: &str,
    old_refresh: Option<String>,
) -> anyhow::Result<Tokens> {
    let access = value["access_token"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 32768)
        .ok_or_else(|| anyhow::anyhow!("calendarInvalidToken"))?;
    anyhow::ensure!(
        value["token_type"]
            .as_str()
            .is_some_and(|s| s.eq_ignore_ascii_case("bearer")),
        "calendarInvalidToken"
    );
    let expiry = value["expires_in"]
        .as_u64()
        .filter(|s| *s > 0 && *s <= 604800)
        .ok_or_else(|| anyhow::anyhow!("calendarInvalidToken"))?;
    let refresh = value["refresh_token"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 32768)
        .map(str::to_owned)
        .or(old_refresh);
    Ok(Tokens {
        access_token: access.into(),
        refresh_token: refresh,
        expires_ms: now() + expiry * 1000,
        client_id: client_id.into(),
        provider: provider.into(),
    })
}
/// A refresh request never names a scope: the provider re-issues exactly what the user already
/// granted, so connections made under the former broader scopes keep working unchanged.
pub fn refresh_form<'a>(refresh: &'a str, client_id: &'a str) -> [(&'static str, &'a str); 3] {
    [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh),
        ("client_id", client_id),
    ]
}
/// The one token to revoke at the provider on disconnect. Google documents a revoke endpoint
/// (a refresh token revokes its access tokens too). Microsoft's v2 endpoint documents none for a
/// public client, so nothing is sent there (see the verification pack, finding 6).
fn revocation_token(tokens: &Tokens) -> Option<String> {
    (tokens.provider == "google").then(|| {
        tokens
            .refresh_token
            .clone()
            .unwrap_or_else(|| tokens.access_token.clone())
    })
}
/// Best-effort provider-side revocation. Any failure, including being offline, is only reported
/// as `false`: it never blocks or reverses a disconnect and is never shown as an error.
pub async fn revoke_google_grant(client: &reqwest::Client, endpoint: &str, token: &str) -> bool {
    client
        .post(endpoint)
        .timeout(Duration::from_secs(8))
        .form(&[("token", token)])
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}
fn revoke_in_background(token: String) {
    tauri::async_runtime::spawn(async move {
        if let Ok(client) = http() {
            let _ = revoke_google_grant(&client, GOOGLE_REVOKE_ENDPOINT, &token).await;
        }
    });
}
async fn access_token(client: &reqwest::Client, account: &str) -> anyhow::Result<String> {
    let _tokens = TOKEN_LOCK.lock().await;
    let mut tokens = load_tokens(account)?;
    if tokens.expires_ms <= now() + 60_000 {
        let refresh = tokens
            .refresh_token
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("calendarReauthenticationRequired"))?;
        let response = client
            .post(token_endpoint(&tokens.provider))
            .form(&refresh_form(refresh, tokens.client_id.as_str()))
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("calendarNetworkUnavailable"))?;
        let value = response_json(refresh_status(response)?).await?;
        tokens = tokens_from(
            &value,
            &tokens.provider,
            &tokens.client_id,
            tokens.refresh_token,
        )?;
        save_tokens(account, &tokens)?;
    }
    Ok(tokens.access_token)
}
/// A refused refresh token (`invalid_grant` is a 400) means the person must sign in again; other
/// failures keep their own code so being offline is not shown as "sign in again".
fn refresh_status(response: reqwest::Response) -> anyhow::Result<reqwest::Response> {
    anyhow::ensure!(
        !matches!(response.status().as_u16(), 400 | 401),
        "calendarReauthenticationRequired"
    );
    Ok(response)
}
/// The code shown for a calendar whose account token could not be obtained: the token error's own
/// code (offline, rate limited, provider down ...), never a blanket "sign in again".
pub fn token_failure_code(error: &anyhow::Error) -> String {
    code(anyhow::anyhow!(error.to_string()))
}
/// Bounded full-range pagination. Partial pages never authorize deletion of unseen cached events.
pub struct PageResult {
    pub items: Vec<Value>,
    pub complete: bool,
    pub code: Option<String>,
}
pub async fn collect_pages(
    client: &reqwest::Client,
    provider: &str,
    initial: &str,
    token: &str,
    max_pages: usize,
    allow_loopback: bool,
) -> anyhow::Result<PageResult> {
    anyhow::ensure!(
        matches!(provider, "microsoft" | "google"),
        "invalidProvider"
    );
    let base = Url::parse(initial).map_err(|_| anyhow::anyhow!("invalidCalendarEndpoint"))?;
    let trusted = base.scheme() == "https"
        && base.host_str()
            == Some(if provider == "microsoft" {
                "graph.microsoft.com"
            } else {
                "www.googleapis.com"
            });
    let fixture = allow_loopback && base.scheme() == "http" && base.host_str() == Some("127.0.0.1");
    anyhow::ensure!(
        (trusted || fixture)
            && base.username().is_empty()
            && base.password().is_none()
            && base.fragment().is_none(),
        "invalidCalendarEndpoint"
    );
    let mut next = base.clone();
    let mut seen = HashSet::new();
    let mut items = vec![];
    for _ in 0..max_pages.clamp(1, 100) {
        if !seen.insert(next.to_string()) {
            return Ok(PageResult {
                items,
                complete: false,
                code: Some("calendarPaginationCycle".into()),
            });
        }
        anyhow::ensure!(
            next.origin() == base.origin() && (next.path() == base.path() || fixture),
            "invalidCalendarNextPage"
        );
        let response = client
            .get(next.clone())
            .bearer_auth(token)
            .header("Prefer", "outlook.timezone=\"UTC\", IdType=\"ImmutableId\"")
            .send()
            .await;
        let value = match response {
            Ok(r) => response_json(r).await,
            Err(_) => Err(anyhow::anyhow!("calendarNetworkUnavailable")),
        };
        let value = match value {
            Ok(v) => v,
            Err(e) => {
                return Ok(PageResult {
                    items,
                    complete: false,
                    code: Some(e.to_string()),
                });
            }
        };
        let rows = value[if provider == "microsoft" {
            "value"
        } else {
            "items"
        }]
        .as_array();
        let Some(rows) = rows else {
            return Ok(PageResult {
                items,
                complete: false,
                code: Some("calendarMalformedResponse".into()),
            });
        };
        if items.len() + rows.len() > 20_000 {
            return Ok(PageResult {
                items,
                complete: false,
                code: Some("calendarEventLimit".into()),
            });
        }
        items.extend(rows.iter().cloned());
        let continuation = if provider == "microsoft" {
            value["@odata.nextLink"].as_str().map(str::to_owned)
        } else {
            value["nextPageToken"].as_str().map(|t| {
                let mut u = base.clone();
                let pairs = u
                    .query_pairs()
                    .filter(|(k, _)| k != "pageToken")
                    .map(|(k, v)| (k.into_owned(), v.into_owned()))
                    .collect::<Vec<_>>();
                u.set_query(None);
                u.query_pairs_mut()
                    .extend_pairs(pairs)
                    .append_pair("pageToken", t);
                u.into()
            })
        };
        match continuation {
            None => {
                return Ok(PageResult {
                    items,
                    complete: true,
                    code: None,
                })
            }
            Some(s) => {
                next = Url::parse(&s).map_err(|_| anyhow::anyhow!("invalidCalendarNextPage"))?;
            }
        }
    }
    Ok(PageResult {
        items,
        complete: false,
        code: Some("calendarPageLimit".into()),
    })
}
fn parse_date(value: &Value) -> anyhow::Result<i64> {
    use chrono::TimeZone;
    if let Some(ms) = value.as_i64() {
        return Ok(ms);
    }
    let raw = value["dateTime"]
        .as_str()
        .or_else(|| value["date"].as_str())
        .or_else(|| value.as_str())
        .ok_or_else(|| anyhow::anyhow!("calendarInvalidEventDate"))?;
    if let Ok(date) = chrono::DateTime::parse_from_rfc3339(raw) {
        return Ok(date.timestamp_millis());
    }
    let day = chrono::NaiveDate::parse_from_str(raw, "%Y-%m-%d").ok();
    let naive = day
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .or_else(|| chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S%.f").ok())
        .ok_or_else(|| anyhow::anyhow!("calendarInvalidEventDate"))?;
    let zone = value["timeZone"]
        .as_str()
        .or(if day.is_some() { Some("UTC") } else { None })
        .ok_or_else(|| anyhow::anyhow!("calendarEventTimeZoneRequired"))?;
    let zone: chrono_tz::Tz = zone
        .parse()
        .map_err(|_| anyhow::anyhow!("calendarEventTimeZoneUnsupported"))?;
    // A naive time during a DST overlap has two possible instants; preserve uncertainty.
    zone.from_local_datetime(&naive)
        .single()
        .map(|d| d.timestamp_millis())
        .ok_or_else(|| anyhow::anyhow!("calendarAmbiguousEventDate"))
}
/// Version of the event shape stored in the cache and stamped on coverage rows. Rows written
/// before version 2 lack `isAllDay`/`startDay`/`endDay`/`recurring`/`seriesId`; the app always
/// refetches a range before showing it, and rewrites those rows with the same ids. Version 3 adds
/// the macOS `calendarWritable`/`invitation`/`organiserIsCurrentUser` flags; older macOS rows read
/// as read-only until refetched.
pub const EVENT_SCHEMA: u32 = 3;
/// The calendar days an all-day event covers, `end` exclusive, as the provider states them
/// (never converted between time zones: an all-day event belongs to its own dates).
pub fn all_day_span(
    provider: &str,
    v: &Value,
) -> Option<(chrono::NaiveDate, chrono::NaiveDate)> {
    let day = |raw: Option<&str>| {
        raw.and_then(|s| s.get(..10))
            .and_then(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
    };
    let (start, end) = match provider {
        "google" => (
            day(v["start"]["date"].as_str()),
            day(v["end"]["date"].as_str()),
        ),
        // Graph is asked for UTC (`Prefer: outlook.timezone="UTC"`); all-day values are midnight
        // on the event's own dates, so the zone is ignored and only the date part is read.
        "microsoft" if v["isAllDay"] == true => (
            day(v["start"]["dateTime"].as_str()),
            day(v["end"]["dateTime"].as_str()),
        ),
        "apple" if v["isAllDay"] == true => (
            day(v["startDay"].as_str()),
            day(v["endDay"].as_str()),
        ),
        _ => return None,
    };
    match (start, end) {
        (Some(start), Some(end)) if end > start => Some((start, end)),
        _ => None,
    }
}
/// Midnight at the start of `day` in `zone` as epoch milliseconds. Where midnight does not
/// exist (a DST gap at 00:00) the first valid time after it is used; it never panics.
pub fn midnight_ms_in<Tz: chrono::TimeZone>(zone: &Tz, day: chrono::NaiveDate) -> i64 {
    let midnight = day.and_hms_opt(0, 0, 0).unwrap_or_default();
    for minutes in (0..=24 * 60).step_by(15) {
        let candidate = midnight + chrono::Duration::minutes(minutes);
        if let Some(found) = zone.from_local_datetime(&candidate).earliest() {
            return found.timestamp_millis();
        }
    }
    midnight.and_utc().timestamp_millis()
}
fn local_midnight_ms(day: chrono::NaiveDate) -> i64 {
    midnight_ms_in(&chrono::Local, day)
}
pub fn parse_event(
    provider: &str,
    account: &str,
    calendar: &str,
    v: &Value,
) -> anyhow::Result<Value> {
    anyhow::ensure!(provider_valid(provider), "invalidProvider");
    let source = if provider == "apple" {
        v["stableId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .or_else(|| v["id"].as_str())
    } else {
        v["id"].as_str()
    };
    let source = source
        .filter(|s| !s.is_empty() && s.len() <= 4096)
        .ok_or_else(|| anyhow::anyhow!("calendarInvalidEvent"))?;
    if (v["status"] == "cancelled" || v["isCancelled"] == true || v["cancelled"] == true)
        && v["start"].is_null()
        && provider != "apple"
    {
        let occurrence = v
            .get("originalStartTime")
            .or_else(|| v.get("originalStart"))
            .map(parse_date)
            .transpose()?;
        let series = v["recurringEventId"]
            .as_str()
            .or_else(|| v["seriesMasterId"].as_str());
        let identity = match (series, occurrence) {
            (Some(series), Some(time)) => format!("series:{series}:{time}"),
            _ => source.to_owned(),
        };
        return Ok(
            json!({"id":format!("{provider}:{}",hash(&format!("{account}\0{calendar}\0{identity}"))),"accountId":account,"calendarId":calendar,"sourceEventId":source,"cancelled":true}),
        );
    }
    let (start, end) = if provider == "apple" {
        (parse_date(&v["startMs"]), parse_date(&v["endMs"]))
    } else {
        (parse_date(&v["start"]), parse_date(&v["end"]))
    };
    let start = start?;
    let end = end?;
    anyhow::ensure!(end > start, "calendarInvalidEventDate");
    let series = v["recurringEventId"]
        .as_str()
        .or_else(|| v["seriesMasterId"].as_str());
    let occurrence = if provider == "google" {
        v.get("originalStartTime").map(parse_date).transpose()?
    } else if provider == "microsoft" {
        v.get("originalStart")
            .filter(|v| !v.is_null())
            .map(parse_date)
            .transpose()?
    } else {
        v.get("occurrenceStartMs").map(parse_date).transpose()?
    };
    let identity = if let Some(series) = series {
        format!("series:{series}:{}", occurrence.unwrap_or(start))
    } else if provider == "apple" {
        format!("{source}:{}", occurrence.unwrap_or(start))
    } else {
        source.into()
    };
    let id = format!(
        "{provider}:{}",
        hash(&format!("{account}\0{calendar}\0{identity}"))
    );
    // Identity above keeps the raw provider start. Only the output times of an all-day event
    // move to local midnight, so the day grid shows the event on its own dates in any zone.
    let (out_start, out_end, all_day) = match all_day_span(provider, v) {
        Some((first, after)) => {
            let (s, e) = (local_midnight_ms(first), local_midnight_ms(after));
            if e > s {
                (s, e, Some((first, after)))
            } else {
                (start, end, None)
            }
        }
        None => (start, end, None),
    };
    let recurring = series.is_some()
        || (provider == "microsoft" && matches!(v["type"].as_str(), Some("occurrence" | "exception")))
        || (provider == "apple" && v["recurring"] == true);
    let series_key = if provider == "apple" { Some(source) } else { series };
    let series_id = series_key
        .filter(|_| recurring)
        .map(|s| format!("{provider}:{}", hash(&format!("{account}\0{calendar}\0{s}"))));
    let title = v["summary"]
        .as_str()
        .or_else(|| v["subject"].as_str())
        .or_else(|| v["title"].as_str())
        .unwrap_or("Untitled meeting");
    anyhow::ensure!(title.len() <= 8192, "calendarInvalidEvent");
    let attendees=v["attendees"].as_array().into_iter().flatten().take(200).map(|a|json!({"name":a["displayName"].as_str().or_else(||a["emailAddress"]["name"].as_str()).or_else(||a["name"].as_str()).or_else(||a["email"].as_str()).unwrap_or("Attendee"),"email":a["email"].as_str().or_else(||a["emailAddress"]["address"].as_str())})).collect::<Vec<_>>();
    let join = v["hangoutLink"]
        .as_str()
        .or_else(|| v["onlineMeeting"]["joinUrl"].as_str())
        .or_else(|| v["joinUrl"].as_str())
        .filter(|u| Url::parse(u).is_ok_and(|u| matches!(u.scheme(), "https" | "http")));
    let mut event = json!({"id":id,"title":title,"startMs":out_start,"endMs":out_end,"isAllDay":all_day.is_some(),"recurring":recurring,"accountId":account,"calendarId":calendar,"provider":provider,"sourceEventId":source,"timeZone":v["start"]["timeZone"].as_str().or_else(||v["timeZone"].as_str()),"joinUrl":join,"organiser":v["organizer"]["email"].as_str().or_else(||v["organizer"]["emailAddress"]["address"].as_str()).or_else(||v["organiser"].as_str()),"attendees":attendees,"cancelled":v["status"]=="cancelled"||v["isCancelled"]==true||v["cancelled"]==true,"version":v["etag"].as_str().or_else(||v["changeKey"].as_str()).or_else(||v["version"].as_str()),"readOnly":true});
    // Optional fields are left out, not null, so a reader can tell "not applicable" from "unknown".
    if let (Some((first, after)), Some(map)) = (all_day, event.as_object_mut()) {
        map.insert("startDay".into(), json!(first.to_string()));
        map.insert("endDay".into(), json!(after.to_string()));
    }
    if let (Some(series_id), Some(map)) = (series_id, event.as_object_mut()) {
        map.insert("seriesId".into(), json!(series_id));
    }
    // macOS events can be moved through the reviewed executor when their calendar allows changes;
    // Google and Microsoft connections are read-only (read-only OAuth scopes). The helper's
    // organiser flags pass through so the app can warn before moving an invitation.
    if provider == "apple" {
        if let Some(map) = event.as_object_mut() {
            map.insert("readOnly".into(), json!(v["calendarWritable"] != true));
            for key in ["calendarWritable", "invitation", "organiserIsCurrentUser"] {
                if let Some(flag) = v[key].as_bool() {
                    map.insert(key.into(), json!(flag));
                }
            }
        }
    }
    Ok(event)
}
/// Cached calendar events are kept from 90 days before now to 400 days after it: enough for
/// the Today/Week/Month views and a year of planning, while the cache cannot grow without bound.
pub const CACHE_PAST_MS: i64 = 90 * 86_400_000;
pub const CACHE_FUTURE_MS: i64 = 400 * 86_400_000;
/// When the cache was last pruned in this process. Pruning runs at most once a day, so a month older
/// than the window that the person just opened is served from the cache instead of fetched on every load.
static LAST_PRUNE_MS: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(i64::MIN);
fn prune_due(last: &std::sync::atomic::AtomicI64, now: i64) -> bool {
    use std::sync::atomic::Ordering;
    let previous = last.load(Ordering::SeqCst);
    if previous != i64::MIN && now - previous < 86_400_000 {
        return false;
    }
    last.compare_exchange(previous, now, Ordering::SeqCst, Ordering::SeqCst).is_ok()
}
pub struct CalendarStore {
    root: PathBuf,
}
impl CalendarStore {
    pub fn open(root: &Path) -> anyhow::Result<Self> {
        let s = Self { root: root.into() };
        crate::schema::migrate(&mut s.db()?, crate::schema::CALENDARS)?;
        Ok(s)
    }
    fn db(&self) -> anyhow::Result<Connection> {
        let c = Connection::open(crate::owned_paths::file(
            &self.root,
            &["calendars.sqlite"],
            true,
        )?)?;
        c.busy_timeout(Duration::from_secs(5))?;
        Ok(c)
    }
    pub fn accounts(&self) -> anyhow::Result<Vec<Value>> {
        let c = self.db()?;
        let mut q = c.prepare("SELECT body FROM accounts ORDER BY id")?;
        let raw = q
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        raw.into_iter()
            .map(|s| Ok(serde_json::from_str(&s)?))
            .collect()
    }
    pub fn save_account(&self, a: &Value) -> anyhow::Result<()> {
        let id = a["id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("calendarInvalidAccount"))?;
        anyhow::ensure!(
            crate::meeting_records::valid_id(id)
                && provider_valid(a["provider"].as_str().unwrap_or("")),
            "calendarInvalidAccount"
        );
        self.db()?.execute("INSERT INTO accounts(id,body) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET body=excluded.body",params![id,a.to_string()])?;
        Ok(())
    }
    pub fn account(&self, id: &str) -> anyhow::Result<Value> {
        let raw: String =
            self.db()?
                .query_row("SELECT body FROM accounts WHERE id=?1", [id], |r| r.get(0))?;
        Ok(serde_json::from_str(&raw)?)
    }
    pub fn sources(&self, account: &str) -> anyhow::Result<Vec<Value>> {
        let c = self.db()?;
        let mut q = c.prepare("SELECT body FROM calendars WHERE account=?1 ORDER BY id")?;
        let raw = q
            .query_map([account], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        raw.into_iter()
            .map(|s| Ok(serde_json::from_str(&s)?))
            .collect()
    }
    /// Whether the person has saved a calendar selection for this account (`selectionSaved` in the account body).
    ///
    /// Accounts written before the marker existed have no field. Every calendar used to arrive unticked, so a
    /// non-empty selection on such an account can only come from the person (or a reviewed save that added its
    /// calendar), and is treated as saved; an empty one is treated as never chosen. The first write after this
    /// stores the answer explicitly, so the inference runs at most once per account.
    pub fn selection_saved(account: &Value) -> bool {
        match account.get("selectionSaved").and_then(Value::as_bool) {
            Some(saved) => saved,
            None => account["selectedCalendarIds"]
                .as_array()
                .is_some_and(|ids| !ids.is_empty()),
        }
    }
    /// Stores the calendars an account offers.
    ///
    /// Selection rule: macOS calendars are read by default (product decision; the app only reads them, and writes still
    /// go through review to writable calendars only). While the person has never saved a selection for the macOS
    /// account, every readable calendar is ticked, including ones that appear later (a new account added in
    /// Calendar.app). Once the person saves a selection, even an empty one, it is never overridden: known calendars
    /// keep the person's choice and calendars that appear afterwards arrive unticked. Microsoft and Google accounts
    /// always keep the person's choice (new calendars unticked); see `auto_selects`.
    pub fn save_sources(&self, account: &str, sources: &[Value]) -> anyhow::Result<()> {
        let old = self.sources(account)?;
        let body = self.account(account).ok();
        let saved = body.as_ref().is_some_and(Self::selection_saved);
        let auto = !saved && body.as_ref().is_some_and(Self::auto_selects);
        let mut c = self.db()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute("DELETE FROM calendars WHERE account=?1", [account])?;
        for source in sources {
            let mut source = source.clone();
            let id = source["id"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 4096)
                .ok_or_else(|| anyhow::anyhow!("calendarInvalidSource"))?
                .to_owned();
            anyhow::ensure!(source["accountId"] == account, "calendarInvalidSource");
            source["selected"] = json!(if auto {
                source["read"] == true
            } else {
                old.iter().any(|s| s["id"] == id && s["selected"] == true)
            });
            tx.execute(
                "INSERT INTO calendars(account,id,body) VALUES(?1,?2,?3)",
                params![account, id, source.to_string()],
            )?;
        }
        tx.commit()?;
        self.update_selected_account(account, saved)?;
        Ok(())
    }
    /// Only macOS calendars are ticked by default. Microsoft and Google lists routinely include colleagues' shared
    /// calendars, holidays and birthdays, each read over the network on every refresh; the product decision covers
    /// the calendars on this Mac, so those accounts keep the explicit choice.
    fn auto_selects(account: &Value) -> bool {
        account["provider"] == "apple"
    }
    fn update_selected_account(&self, account: &str, saved: bool) -> anyhow::Result<()> {
        let mut a = self.account(account)?;
        a["selectedCalendarIds"] = json!(self
            .sources(account)?
            .iter()
            .filter(|s| s["selected"] == true)
            .filter_map(|s| s["id"].as_str())
            .collect::<Vec<_>>());
        a["selectionSaved"] = json!(saved);
        self.save_account(&a)
    }
    /// The person saved this selection in Settings → Calendars. From now on it is never replaced by the default.
    pub fn select(&self, account: &str, ids: &[String]) -> anyhow::Result<()> {
        self.apply_selection(account, ids, true)
    }
    fn apply_selection(&self, account: &str, ids: &[String], by_person: bool) -> anyhow::Result<()> {
        let saved = by_person || self.account(account).is_ok_and(|a| Self::selection_saved(&a));
        anyhow::ensure!(
            ids.len() <= 100 && ids.iter().collect::<HashSet<_>>().len() == ids.len(),
            "calendarInvalidSelection"
        );
        let sources = self.sources(account)?;
        anyhow::ensure!(
            ids.iter()
                .all(|id| sources.iter().any(|s| s["id"] == *id && s["read"] == true)),
            "calendarUnknownSource"
        );
        let mut c = self.db()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        for mut source in sources {
            let id = source["id"].as_str().unwrap().to_owned();
            source["selected"] = json!(ids.contains(&id));
            tx.execute(
                "UPDATE calendars SET body=?3 WHERE account=?1 AND id=?2",
                params![account, id, source.to_string()],
            )?;
            if !ids.contains(&id) {
                tx.execute(
                    "DELETE FROM events WHERE account=?1 AND calendar=?2",
                    params![account, id],
                )?;
                tx.execute(
                    "DELETE FROM coverage WHERE account=?1 AND calendar=?2",
                    params![account, id],
                )?;
            }
        }
        tx.commit()?;
        self.update_selected_account(account, saved)?;
        Ok(())
    }
    /// Adds one calendar to the selection, keeping the others (and their cached events) as they are.
    pub fn include_selected(&self, account: &str, id: &str) -> anyhow::Result<()> {
        let mut ids = self
            .sources(account)?
            .iter()
            .filter(|s| s["selected"] == true)
            .filter_map(|s| s["id"].as_str().map(str::to_owned))
            .collect::<Vec<_>>();
        if ids.iter().any(|s| s == id) {
            return Ok(());
        }
        ids.push(id.to_owned());
        // Not a choice by the person: the marker stays as it was, so a never-chosen account keeps its default.
        self.apply_selection(account, &ids, false)
    }
    pub fn reconcile(
        &self,
        account: &str,
        calendar: &str,
        start: i64,
        end: i64,
        events: &[Value],
        complete: bool,
    ) -> anyhow::Result<()> {
        let mut c = self.db()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if complete {
            tx.execute(
                "DELETE FROM events WHERE account=?1 AND calendar=?2 AND end_ms>?3 AND start_ms<?4",
                params![account, calendar, start, end],
            )?;
        }
        for e in events {
            let id = e["id"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("calendarInvalidEvent"))?;
            if e["cancelled"] == true {
                tx.execute(
                    "DELETE FROM events WHERE account=?1 AND calendar=?2 AND id=?3",
                    params![account, calendar, id],
                )?;
                continue;
            }
            let s = e["startMs"]
                .as_i64()
                .ok_or_else(|| anyhow::anyhow!("calendarInvalidEventDate"))?;
            let end = e["endMs"]
                .as_i64()
                .ok_or_else(|| anyhow::anyhow!("calendarInvalidEventDate"))?;
            anyhow::ensure!(end > s, "calendarInvalidEventDate");
            if e["cancelled"] == true {
                tx.execute(
                    "DELETE FROM events WHERE account=?1 AND calendar=?2 AND id=?3",
                    params![account, calendar, id],
                )?;
            } else {
                tx.execute("INSERT INTO events(account,calendar,id,start_ms,end_ms,body) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(account,calendar,id) DO UPDATE SET start_ms=excluded.start_ms,end_ms=excluded.end_ms,body=excluded.body",params![account,calendar,id,s,end,e.to_string()])?;
            }
        }
        tx.commit()?;
        Ok(())
    }
    /// Drops cached events and coverage outside the retention window (`CACHE_PAST_MS` before
    /// `now` to `CACHE_FUTURE_MS` after it). The cache is derived from the providers, so anything
    /// dropped is read again when the person looks at that range. Coverage only partly inside the
    /// window is dropped too: its events outside the window are gone, so the range must read as not
    /// loaded rather than ready.
    pub fn prune_outside_window(&self, now: i64) -> anyhow::Result<()> {
        let (from, until) = (now - CACHE_PAST_MS, now + CACHE_FUTURE_MS);
        let mut c = self.db()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "DELETE FROM events WHERE end_ms<?1 OR start_ms>?2",
            params![from, until],
        )?;
        tx.execute(
            "DELETE FROM coverage WHERE start_ms<?1 OR end_ms>?2",
            params![from, until],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn cached(
        &self,
        account: &str,
        calendar: &str,
        start: i64,
        end: i64,
    ) -> anyhow::Result<Vec<Value>> {
        let c = self.db()?;
        let mut q=c.prepare("SELECT body FROM events WHERE account=?1 AND calendar=?2 AND end_ms>?3 AND start_ms<?4 ORDER BY start_ms,id")?;
        let raw = q
            .query_map(params![account, calendar, start, end], |r| {
                r.get::<_, String>(0)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        raw.into_iter()
            .map(|s| Ok(serde_json::from_str(&s)?))
            .collect()
    }
    fn save_coverage(&self, coverage: &Value) -> anyhow::Result<()> {
        self.db()?.execute("INSERT INTO coverage(account,calendar,start_ms,end_ms,body) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(account,calendar,start_ms,end_ms) DO UPDATE SET body=excluded.body",params![coverage["accountId"].as_str(),coverage["calendarId"].as_str(),coverage["startMs"].as_i64(),coverage["endMs"].as_i64(),coverage.to_string()])?;
        Ok(())
    }
    fn last_ready(
        &self,
        account: &str,
        calendar: &str,
        start: i64,
        end: i64,
    ) -> anyhow::Result<Option<u64>> {
        let raw:Option<String>=self.db()?.query_row("SELECT body FROM coverage WHERE account=?1 AND calendar=?2 AND start_ms<=?3 AND end_ms>=?4 AND json_extract(body,'$.status')='ready' ORDER BY json_extract(body,'$.refreshedAtMs') DESC LIMIT 1",params![account,calendar,start,end],|r|r.get(0)).optional()?;
        Ok(raw
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v["refreshedAtMs"].as_u64()))
    }
    pub fn apple_enabled(&self) -> anyhow::Result<bool> {
        let disabled: Option<bool> = self
            .db()?
            .query_row(
                "SELECT value FROM calendar_settings WHERE key='appleDisabled'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        Ok(!disabled.unwrap_or(false))
    }
    pub fn set_apple_enabled(&self, enabled: bool) -> anyhow::Result<()> {
        self.db()?.execute("INSERT INTO calendar_settings(key,value) VALUES('appleDisabled',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[!enabled])?;
        Ok(())
    }
    pub fn disconnect(&self, account: &str) -> anyhow::Result<()> {
        if account == "apple-local" {
            self.set_apple_enabled(false)?;
        }
        self.forget_account(account)
    }
    /// Removes an account and everything read from it without recording that the person turned it off. Used when
    /// macOS calendar access is withdrawn in System Settings: the app must stop showing those calendars, but it was
    /// not disconnected here, so the Calendar view can say "access is off" instead of "connect a calendar".
    pub fn forget_account(&self, account: &str) -> anyhow::Result<()> {
        let mut c = self.db()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute("DELETE FROM accounts WHERE id=?1", [account])?;
        for table in ["calendars", "events", "coverage"] {
            tx.execute(&format!("DELETE FROM {table} WHERE account=?1"), [account])?;
        }
        tx.commit()?;
        Ok(())
    }
}
pub fn calendar_list_url(provider: &str) -> String {
    let (base, pairs): (&str, [(&str, &str); 2]) = if provider == "microsoft" {
        (
            "https://graph.microsoft.com/v1.0/me/calendars",
            [("$top", "100"), ("$select", MICROSOFT_CALENDAR_SELECT)],
        )
    } else {
        (
            "https://www.googleapis.com/calendar/v3/users/me/calendarList",
            [("maxResults", "250"), ("fields", GOOGLE_CALENDAR_LIST_FIELDS)],
        )
    };
    let mut url = Url::parse(base).expect("static calendar list endpoint");
    url.query_pairs_mut().extend_pairs(pairs);
    url.into()
}
async fn refresh_sources(
    store: &CalendarStore,
    client: &reqwest::Client,
    account: &str,
    provider: &str,
    token: &str,
) -> anyhow::Result<Vec<Value>> {
    let page = collect_pages(
        client,
        provider,
        &calendar_list_url(provider),
        token,
        100,
        false,
    )
    .await?;
    anyhow::ensure!(page.complete, "calendarSourcesPartial");
    let mut sources = vec![];
    for v in page.items {
        let id = v["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| anyhow::anyhow!("calendarInvalidSource"))?;
        let read = if provider == "google" {
            matches!(
                v["accessRole"].as_str(),
                Some("reader" | "writer" | "owner" | "writerWithoutPrivateAccess")
            )
        } else {
            true
        };
        let mut source = json!({"id":id,"accountId":account,"name":v["name"].as_str().or_else(||v["summaryOverride"].as_str()).or_else(||v["summary"].as_str()).unwrap_or("Calendar"),"read":read,"edit":false,"selected":false,"timeZone":v["timeZone"]});
        // Google sends backgroundColor, Microsoft hexColor (empty when the calendar uses an automatic colour; the
        // `color` enum is not mapped to guesses).
        set_calendar_color(&mut source, if provider == "google" { &v["backgroundColor"] } else { &v["hexColor"] });
        sources.push(source);
    }
    let _store = STORE_LOCK.lock().await;
    store.account(account).map_err(|_| anyhow::anyhow!("calendarAccountRemoved"))?;
    store.save_sources(account, &sources)?;
    store.sources(account)
}
pub fn event_url(provider: &str, calendar: &str, start: i64, end: i64) -> anyhow::Result<String> {
    let mut url = Url::parse(if provider == "microsoft" {
        "https://graph.microsoft.com/v1.0/me/calendars/"
    } else {
        "https://www.googleapis.com/calendar/v3/calendars/"
    })?;
    url.path_segments_mut()
        .map_err(|_| anyhow::anyhow!("invalidCalendarEndpoint"))?
        .pop_if_empty()
        .push(calendar)
        .push(if provider == "microsoft" {
            "calendarView"
        } else {
            "events"
        });
    let start = time::OffsetDateTime::from_unix_timestamp_nanos(start as i128 * 1_000_000)?
        .format(&time::format_description::well_known::Rfc3339)?;
    let end = time::OffsetDateTime::from_unix_timestamp_nanos(end as i128 * 1_000_000)?
        .format(&time::format_description::well_known::Rfc3339)?;
    if provider == "microsoft" {
        url.query_pairs_mut().extend_pairs([
            ("startDateTime", start.as_str()),
            ("endDateTime", end.as_str()),
            ("$top", "1000"),
            ("$select", MICROSOFT_EVENT_SELECT),
        ]);
    } else {
        url.query_pairs_mut().extend_pairs([
            ("timeMin", start.as_str()),
            ("timeMax", end.as_str()),
            ("singleEvents", "true"),
            ("showDeleted", "true"),
            ("maxResults", "2500"),
            ("timeZone", "UTC"),
            ("fields", GOOGLE_EVENT_FIELDS),
        ]);
    }
    Ok(url.into())
}
async fn sync_range(
    store: &CalendarStore,
    client: &reqwest::Client,
    account: &str,
    calendar: &str,
    provider: &str,
    token: &str,
    start: i64,
    end: i64,
) -> anyhow::Result<(Vec<Value>, Value)> {
    let pages = collect_pages(
        client,
        provider,
        &event_url(provider, calendar, start, end)?,
        token,
        100,
        false,
    )
    .await?;
    if !pages.complete && pages.items.is_empty() {
        anyhow::bail!(pages
            .code
            .unwrap_or_else(|| "calendarProviderUnavailable".into()));
    }
    let mut events = vec![];
    let mut malformed = false;
    let calendar_zone = store
        .sources(account)?
        .into_iter()
        .find(|s| s["id"] == calendar)
        .and_then(|s| s["timeZone"].as_str().map(str::to_owned));
    for mut v in pages.items {
        if provider == "google" {
            if let Some(zone) = calendar_zone.as_ref() {
                for field in ["start", "end", "originalStartTime"] {
                    if v[field]["date"].is_string() && v[field]["timeZone"].is_null() {
                        v[field]["timeZone"] = json!(zone);
                    }
                }
            }
        }
        match parse_event(provider, account, calendar, &v) {
            Ok(v) => events.push(v),
            Err(_) => malformed = true,
        }
    }
    let complete = pages.complete && !malformed;
    let _store = STORE_LOCK.lock().await;
    store.account(account).map_err(|_| anyhow::anyhow!("calendarAccountRemoved"))?;
    store.reconcile(account, calendar, start, end, &events, complete)?;
    let coverage = json!({"accountId":account,"calendarId":calendar,"startMs":start,"endMs":end,"status":if complete{"ready"}else{"partial"},"eventSchema":EVENT_SCHEMA,"refreshedAtMs":now(),"code":if malformed{Some("calendarMalformedEvent".into())}else{pages.code}});
    store.save_coverage(&coverage)?;
    Ok((store.cached(account, calendar, start, end)?, coverage))
}
/// Syncs the macOS Calendar account with what EventKit allows and returns the access state the helper reported
/// (`fullAccess`, `denied`, `notDetermined`, ...; empty when the person disconnected macOS calendars in the app).
async fn apple_accounts(app: &tauri::AppHandle, store: &CalendarStore) -> anyhow::Result<String> {
    if !store.apple_enabled()? {
        return Ok(String::new());
    }
    let result = crate::calendar::request(
        app,
        json!({"kind":"calendarCapabilities","requestPermission":false}),
        false,
    )
    .await?;
    let _store = STORE_LOCK.lock().await;
    // The person may have turned macOS calendars off while the helper was running.
    if !store.apple_enabled()? {
        return Ok(String::new());
    }
    let authorization = result["authorization"]
        .as_str()
        .unwrap_or(if result["permission"] == "granted" { "fullAccess" } else { "unknown" })
        .to_owned();
    if result["permission"] != "granted" {
        if store.accounts()?.iter().any(|a| a["id"] == "apple-local") {
            store.forget_account("apple-local")?;
        }
        return Ok(authorization);
    }
    let old = store.account("apple-local").ok();
    let account=old.unwrap_or_else(||json!({"id":"apple-local","provider":"apple","name":"macOS Calendar","status":"connected","selectedCalendarIds":[]}));
    store.save_account(&account)?;
    store.save_sources("apple-local", &apple_sources(&result["capabilities"])?)?;
    Ok(authorization)
}
/// The row the accounts list adds for macOS Calendar when it has no connected account: `disconnected` when the person
/// turned it off in the app, `accessOff` when macOS refuses access (denied, restricted or add-only) so only System
/// Settings can change it. None when it is connected or has simply never been asked for (nothing to report).
pub fn apple_placeholder(enabled: bool, connected: bool, authorization: &str) -> Option<Value> {
    if connected {
        return None;
    }
    if !enabled {
        return Some(json!({"id":"apple-local","provider":"apple","name":"macOS Calendar","status":"disconnected","selectedCalendarIds":[]}));
    }
    matches!(authorization, "denied" | "restricted" | "writeOnly").then(|| json!({"id":"apple-local","provider":"apple","name":"macOS Calendar","status":"accessOff","code":"calendarPermissionDenied","selectedCalendarIds":[]}))
}
/// Calendars on this Mac as connector sources. `edit` follows what the calendar helper reports, so a read-only or
/// subscribed calendar is never offered as a place to save a meeting.
///
/// `name` is the calendar's own title and `group` the macOS account it belongs to (EventKit source title, e.g. iCloud),
/// so Settings can group them; `color` is the calendar colour when the helper reports one.
pub fn apple_sources(capabilities: &Value) -> anyhow::Result<Vec<Value>> {
    Ok(capabilities.as_array().ok_or_else(||anyhow::anyhow!("calendarMalformedResponse"))?.iter().filter(|c|c["read"]==true).map(|c|{
        let mut source = json!({"id":c["id"],"accountId":"apple-local","name":c["name"].as_str().unwrap_or("Calendar"),"group":c["account"].as_str().unwrap_or("Calendar"),"read":true,"edit":c["add"]==true&&c["edit"]==true,"selected":false});
        set_calendar_color(&mut source, &c["color"]);
        source
    }).collect())
}
/// A calendar colour as lowercase `#rrggbb`, or None. Anything else (empty, named colours, other formats) is dropped
/// rather than guessed.
pub fn calendar_color(value: &Value) -> Option<String> {
    let s = value.as_str()?;
    (s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit())).then(|| s.to_ascii_lowercase())
}
fn set_calendar_color(source: &mut Value, value: &Value) {
    if let Some(color) = calendar_color(value) {
        source["color"] = json!(color);
    }
}
/// After a reviewed save to a calendar on this Mac: make sure that calendar is shown in the app and return the
/// event under the same id the calendar list uses, so the meeting plan can link to it.
pub async fn link_saved_apple_event(
    app: &tauri::AppHandle,
    calendar_id: &str,
    event: &Value,
) -> anyhow::Result<Value> {
    let store = store()?;
    apple_accounts(app, &store).await?;
    let _store = STORE_LOCK.lock().await;
    if store.accounts()?.iter().any(|a| a["id"] == "apple-local") {
        store.include_selected("apple-local", calendar_id)?;
    }
    parse_event("apple", "apple-local", calendar_id, event)
}
fn store() -> anyhow::Result<CalendarStore> {
    anyhow::ensure!(crate::edition::is_public(), "publicEditionRequired");
    CalendarStore::open(&crate::commands::data_root())
}
fn code(e: anyhow::Error) -> String {
    let code = e.to_string();
    if code.starts_with("calendar") && code.len() <= 80 {
        code
    } else {
        "calendarUnavailable".into()
    }
}
#[tauri::command]
pub async fn public_calendar_accounts(app: tauri::AppHandle) -> Result<Vec<Value>, String> {
    let store = store().map_err(code)?;
    let authorization = apple_accounts(&app, &store).await.unwrap_or_default();
    let mut accounts = store.accounts().map_err(code)?;
    let connected = accounts.iter().any(|a| a["id"] == "apple-local");
    if let Some(row) = apple_placeholder(store.apple_enabled().map_err(code)?, connected, &authorization) {
        accounts.push(row);
    }
    Ok(accounts)
}
#[tauri::command]
pub async fn public_connect_calendar(
    app: tauri::AppHandle,
    provider: String,
) -> Result<Value, String> {
    let publisher = client_id(&provider).map_err(code)?;
    let store = store().map_err(code)?;
    let client = http().map_err(code)?;
    // Microsoft's redirect host is `localhost`, so the listener must answer on whichever loopback
    // family the browser resolves it to; Google's is the literal 127.0.0.1.
    let listener = bind_loopback(provider == "microsoft")
        .await
        .map_err(|_| "calendarLoopbackUnavailable")?;
    let redirect = loopback_redirect(&provider, listener.port);
    let attempt = OAuthAttempt::new(&provider, &publisher, &redirect, now()).map_err(code)?;
    app.opener()
        .open_url(attempt.authorization_url().map_err(code)?, None::<&str>)
        .map_err(|_| "calendarBrowserUnavailable")?;
    let authorization=tokio::time::timeout(Duration::from_secs(300),async {
  loop{let(mut stream,peer)=listener.accept().await.map_err(|_|anyhow::anyhow!("calendarLoopbackUnavailable"))?;if !peer.ip().is_loopback(){continue;}let mut bytes=vec![0u8;16_384];let read=tokio::time::timeout(Duration::from_secs(5),stream.read(&mut bytes)).await;let n=match read{Ok(Ok(n))=>n,_=>continue};let request=std::str::from_utf8(&bytes[..n]).unwrap_or("");let first=request.lines().next().unwrap_or("");let target=first.strip_prefix("GET ").and_then(|v|v.strip_suffix(" HTTP/1.1"));
   let valid=target.ok_or_else(||anyhow::anyhow!("invalidCallback")).and_then(|target|attempt.validate_callback(target,now()));let body=if valid.is_ok(){"Calendar authorization received. Return to Live Interview."}else{"Invalid calendar callback. Return to the authorization window."};let _=stream.write_all(format!("HTTP/1.1 {}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",if valid.is_ok(){"200 OK"}else{"400 Bad Request"},body.len(),body).as_bytes()).await;
   match valid{Ok(code)=>return Ok(code),Err(e) if e.to_string()=="calendarAuthorizationDenied"=>return Err(e),_=>continue}
  }
 }).await.map_err(|_|"calendarAuthorizationExpired")?.map_err(code)?;
    let value = response_json(
        client
            .post(token_endpoint(&provider))
            .form(&[
                ("grant_type", "authorization_code"),
                ("code", authorization.as_str()),
                ("redirect_uri", redirect.as_str()),
                ("client_id", publisher.as_str()),
                ("code_verifier", attempt.verifier.as_str()),
            ])
            .send()
            .await
            .map_err(|_| "calendarNetworkUnavailable")?,
    )
    .await
    .map_err(code)?;
    // Google lets the user untick one of the two calendar permissions. Refuse a partial grant
    // now with a specific code rather than connect an account whose list or events would later
    // fail with a generic access error; nothing has been stored yet.
    if value["scope"]
        .as_str()
        .is_some_and(|granted| !scope_covers(&provider, granted))
    {
        if provider == "google" {
            if let Some(token) = value["refresh_token"]
                .as_str()
                .or_else(|| value["access_token"].as_str())
            {
                revoke_in_background(token.to_owned());
            }
        }
        return Err("calendarScopeIncomplete".into());
    }
    let identity = attempt
        .verify_identity(
            &client,
            value["id_token"]
                .as_str()
                .ok_or("calendarInvalidIdentity")?,
        )
        .await
        .map_err(code)?;
    let account_id = format!(
        "{}-{}",
        provider,
        hash(&format!("{}:{}", identity["iss"], identity["sub"]))
    );
    let tokens = tokens_from(&value, &provider, &publisher, None).map_err(code)?;
    let mut account = {
        let _tokens = TOKEN_LOCK.lock().await;
        let _store = STORE_LOCK.lock().await;
        let old = store.account(&account_id).ok();
        let account = json!({"id":account_id,"provider":provider,"name":identity["name"].as_str().or_else(||identity["email"].as_str()).unwrap_or("Calendar account"),"email":identity["email"].as_str().or_else(||identity["preferred_username"].as_str()),"status":"connected","selectedCalendarIds":old.as_ref().map(|a|a["selectedCalendarIds"].clone()).unwrap_or_else(||json!([])),"selectionSaved":old.as_ref().is_some_and(CalendarStore::selection_saved)});
        save_tokens(&account_id, &tokens).map_err(code)?;
        store.save_account(&account).map_err(code)?;
        account
    };
    if let Err(e) = refresh_sources(
        &store,
        &client,
        &account_id,
        &provider,
        &tokens.access_token,
    )
    .await
    {
        let _store = STORE_LOCK.lock().await;
        account["status"] = json!("partial");
        account["code"] = json!(code(e));
        if store.account(&account_id).is_ok() {
            store.save_account(&account).map_err(code)?;
        }
    } else {
        account = store.account(&account_id).map_err(code)?;
    }
    Ok(account)
}
#[tauri::command]
pub async fn public_calendar_sources(
    app: tauri::AppHandle,
    account_id: String,
) -> Result<Vec<Value>, String> {
    let store = store().map_err(code)?;
    if account_id == "apple-local" && !store.apple_enabled().map_err(code)? {
        return Ok(vec![]);
    }
    let account = store.account(&account_id).map_err(code)?;
    let provider = account["provider"]
        .as_str()
        .ok_or("calendarInvalidAccount")?;
    if provider == "apple" {
        apple_accounts(&app, &store).await.map_err(code)?;
    } else {
        let client = http().map_err(code)?;
        let token = access_token(&client, &account_id).await.map_err(code)?;
        refresh_sources(&store, &client, &account_id, provider, &token)
            .await
            .map_err(code)?;
    }
    store.sources(&account_id).map_err(code)
}
#[tauri::command]
pub async fn public_select_calendars(
    account_id: String,
    calendar_ids: Vec<String>,
) -> Result<(), String> {
    let _store = STORE_LOCK.lock().await;
    store()
        .map_err(code)?
        .select(&account_id, &calendar_ids)
        .map_err(code)
}
#[tauri::command]
pub async fn public_disconnect_calendar(account_id: String) -> Result<(), String> {
    let _tokens = TOKEN_LOCK.lock().await;
    let _store = STORE_LOCK.lock().await;
    let store = store().map_err(code)?;
    let account = store.account(&account_id).map_err(code)?;
    // Read the token first so it can be revoked after the local copy is gone.
    let revocable = if account["provider"] == "apple" {
        None
    } else {
        let revocable = load_tokens(&account_id).ok().as_ref().and_then(revocation_token);
        delete_tokens(&account_id).map_err(code)?;
        revocable
    };
    let local = store.disconnect(&account_id).map_err(code);
    // The Keychain copy is already gone, so revoke even if clearing the local rows failed;
    // otherwise the grant would outlive the only token that could revoke it.
    if let Some(token) = revocable {
        revoke_in_background(token);
    }
    local
}
#[tauri::command]
pub async fn public_calendar_events(
    app: tauri::AppHandle,
    start_ms: i64,
    end_ms: i64,
) -> Result<Value, String> {
    let span = end_ms.checked_sub(start_ms).ok_or("calendarInvalidRange")?;
    if span <= 0 || span > 366 * 86_400_000 {
        return Err("calendarInvalidRange".into());
    }
    let store = store().map_err(code)?;
    {
        let _store = STORE_LOCK.lock().await;
        if prune_due(&LAST_PRUNE_MS, now() as i64) {
            let _ = store.prune_outside_window(now() as i64);
        }
    }
    let client = http().map_err(code)?;
    let _ = apple_accounts(&app, &store).await;
    let mut events = vec![];
    let mut coverage = vec![];
    for mut account in store.accounts().map_err(code)? {
        let account_id = account["id"]
            .as_str()
            .ok_or("calendarInvalidAccount")?
            .to_owned();
        let provider = account["provider"]
            .as_str()
            .ok_or("calendarInvalidAccount")?
            .to_owned();
        let token = if provider == "apple" {
            Ok(String::new())
        } else {
            access_token(&client, &account_id).await
        };
        let selected = store
            .sources(&account_id)
            .map_err(code)?
            .into_iter()
            .filter(|s| s["selected"] == true)
            .collect::<Vec<_>>();
        for source in selected {
            let calendar = source["id"].as_str().ok_or("calendarInvalidSource")?;
            let result = if provider == "apple" {
                sync_apple(&app, &store, &account_id, calendar, start_ms, end_ms).await
            } else {
                match &token {
                    Ok(token) => {
                        sync_range(
                            &store,
                            &client,
                            &account_id,
                            calendar,
                            &provider,
                            token,
                            start_ms,
                            end_ms,
                        )
                        .await
                    }
                    Err(e) => Err(anyhow::anyhow!(token_failure_code(e))),
                }
            };
            match result {
                Ok((found, c)) => {
                    events.extend(found);
                    coverage.push(c);
                }
                Err(e) => {
                    let old = store
                        .cached(&account_id, calendar, start_ms, end_ms)
                        .map_err(code)?;
                    let prior = store
                        .last_ready(&account_id, calendar, start_ms, end_ms)
                        .map_err(code)?;
                    let error = code(e);
                    account["status"] = json!("error");
                    account["code"] = json!(error);
                    let c = json!({"accountId":account_id,"calendarId":calendar,"startMs":start_ms,"endMs":end_ms,"status":if prior.is_some()||!old.is_empty(){"stale"}else{"error"},"refreshedAtMs":prior,"code":error});
                    coverage.push(c);
                    events.extend(old);
                }
            }
        }
        let synced = coverage
            .iter()
            .any(|c| c["accountId"] == account_id && c["status"] == "ready");
        let healthy = synced
            && !coverage
                .iter()
                .any(|c| c["accountId"] == account_id && c["status"] != "ready");
        // Apply this sync's outcome to the account as stored now: the person may have changed the
        // selection or disconnected while the calendars were being read.
        let _store = STORE_LOCK.lock().await;
        let Ok(mut current) = store.account(&account_id) else {
            continue;
        };
        if account["status"] == "error" {
            current["status"] = account["status"].clone();
            current["code"] = account["code"].clone();
        }
        if synced {
            current["lastSyncMs"] = json!(now());
        }
        if healthy {
            current["status"] = json!("connected");
            if let Some(body) = current.as_object_mut() {
                body.remove("code");
            }
        }
        store.save_account(&current).map_err(code)?;
    }
    events.sort_by_key(|e| e["startMs"].as_i64().unwrap_or(0));
    events.dedup_by(|a, b| a["id"] == b["id"]);
    Ok(json!({"events":events,"coverage":coverage}))
}
async fn sync_apple(
    app: &tauri::AppHandle,
    store: &CalendarStore,
    account: &str,
    calendar: &str,
    start: i64,
    end: i64,
) -> anyhow::Result<(Vec<Value>, Value)> {
    let mut cursor = start;
    let mut events = vec![];
    let mut malformed = false;
    while cursor < end {
        let until = (cursor + 31 * 86_400_000).min(end);
        let result=crate::calendar::request(app,json!({"kind":"calendarRead","startMs":cursor,"endMs":until,"calendarId":calendar,"requestPermission":false}),false).await?;
        anyhow::ensure!(result["code"].is_null(), "calendarPermissionRequired");
        let rows = result["events"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("calendarMalformedResponse"))?;
        for row in rows {
            match parse_event("apple", account, calendar, row) {
                Ok(e) => events.push(e),
                Err(_) => malformed = true,
            }
        }
        cursor = until;
    }
    events.sort_by_key(|e| e["id"].as_str().unwrap_or("").to_owned());
    events.dedup_by(|a, b| a["id"] == b["id"]);
    let _store = STORE_LOCK.lock().await;
    store.account(account).map_err(|_| anyhow::anyhow!("calendarAccountRemoved"))?;
    store.reconcile(account, calendar, start, end, &events, !malformed)?;
    let coverage = json!({"accountId":account,"calendarId":calendar,"startMs":start,"endMs":end,"status":if malformed{"partial"}else{"ready"},"eventSchema":EVENT_SCHEMA,"refreshedAtMs":now(),"code":if malformed{Some("calendarMalformedEvent")}else{None}});
    store.save_coverage(&coverage)?;
    Ok((store.cached(account, calendar, start, end)?, coverage))
}

#[cfg(test)]
mod tests {
    use super::*;
    // Coverage that is only partly inside the window would read 'ready' for a range whose events outside
    // it were pruned. It must read as not loaded so the range is fetched again.
    #[test]
    fn pruning_never_leaves_coverage_for_events_it_dropped() {
        let root = std::env::temp_dir().join(format!("public-cal-coverage-{}", uuid::Uuid::new_v4()));
        let store = CalendarStore::open(&root).unwrap();
        let now = 1_800_000_000_000_i64;
        let h = 3_600_000;
        let edge = now - CACHE_PAST_MS;
        let ready = |start: i64, end: i64| {
            json!({"accountId":"a","calendarId":"c","startMs":start,"endMs":end,"status":"ready","eventSchema":EVENT_SCHEMA,"refreshedAtMs":1})
        };
        let events = [json!({"id":"before","startMs":edge - 5 * h,"endMs":edge - 4 * h}), json!({"id":"inside","startMs":edge + 4 * h,"endMs":edge + 5 * h})];
        store.reconcile("a", "c", edge - 10 * h, edge + 10 * h, &events, true).unwrap();
        store.save_coverage(&ready(edge - 10 * h, edge + 10 * h)).unwrap();
        store.save_coverage(&ready(edge + h, edge + 10 * h)).unwrap();
        store.prune_outside_window(now).unwrap();
        assert!(store.last_ready("a", "c", edge - 10 * h, edge + 10 * h).unwrap().is_none(), "a range crossing the edge reads as not loaded");
        assert!(store.last_ready("a", "c", edge + h, edge + 10 * h).unwrap().is_some(), "coverage inside the window stays");
        let _ = std::fs::remove_dir_all(root);
    }
    #[test]
    fn pruning_runs_at_most_once_a_day() {
        let last = std::sync::atomic::AtomicI64::new(i64::MIN);
        let day = 86_400_000;
        assert!(prune_due(&last, 10 * day));
        assert!(!prune_due(&last, 10 * day + day - 1), "an old month just fetched is not pruned on the next load");
        assert!(prune_due(&last, 11 * day));
    }
    #[test]
    fn a_token_failure_keeps_its_own_code_so_offline_is_not_sign_in_again() {
        for c in ["calendarNetworkUnavailable", "calendarRateLimited", "calendarProviderUnavailable", "calendarReauthenticationRequired"] {
            assert_eq!(token_failure_code(&anyhow::anyhow!(c)), c);
        }
        assert_eq!(token_failure_code(&anyhow::anyhow!("keychain detail")), "calendarUnavailable");
    }
    #[test]
    fn pkce_uses_the_rfc7636_sha256_challenge_and_validates_oidc_claims() {
        let mut attempt =
            OAuthAttempt::new("google", "fixture-client", "http://127.0.0.1:40000/", 1000).unwrap();
        attempt.verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk".into();
        let auth = Url::parse(&attempt.authorization_url().unwrap()).unwrap();
        assert_eq!(
            auth.query_pairs()
                .find(|(k, _)| k == "code_challenge")
                .unwrap()
                .1,
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        let good = json!({"nonce":attempt.nonce,"sub":"fixture-subject","aud":"fixture-client","iss":"https://accounts.google.com","iat":1,"exp":301});
        attempt.validate_claims(&good, 1001).unwrap();
        for (field, value) in [
            ("nonce", json!("wrong")),
            ("aud", json!("another-client")),
            ("iss", json!("https://attacker.invalid")),
            ("exp", json!(1)),
        ] {
            let mut claims = good.clone();
            claims[field] = value;
            assert!(
                attempt.validate_claims(&claims, 1001).is_err(),
                "accepted invalid {field}"
            );
        }
        assert!(attempt.validate_claims(&good, 301_000).is_err());
    }
    #[test]
    fn only_google_grants_are_revoked_and_the_refresh_token_is_preferred() {
        let tokens = |provider: &str, refresh: Option<&str>| Tokens {
            access_token: "access".into(),
            refresh_token: refresh.map(str::to_owned),
            expires_ms: 0,
            client_id: "c".into(),
            provider: provider.into(),
        };
        assert_eq!(
            revocation_token(&tokens("google", Some("refresh"))).as_deref(),
            Some("refresh")
        );
        assert_eq!(
            revocation_token(&tokens("google", None)).as_deref(),
            Some("access")
        );
        // Microsoft documents no per-app revoke endpoint for a public client: no request is made.
        assert_eq!(revocation_token(&tokens("microsoft", Some("refresh"))), None);
    }
    #[test]
    fn a_token_blob_stored_before_the_scope_change_still_loads() {
        // The Keychain blob has no scope field, so connections made under calendar.readonly
        // deserialize and refresh exactly as before.
        let old = r#"{"access_token":"a","refresh_token":"r","expires_ms":1,"client_id":"c","provider":"google"}"#;
        let tokens: Tokens = serde_json::from_str(old).unwrap();
        assert_eq!(tokens.provider, "google");
        assert_eq!(tokens.refresh_token.as_deref(), Some("r"));
    }
    #[test]
    fn signed_identity_requires_a_trusted_rsa_key_and_valid_claims() {
        use std::{
            io::Write,
            process::{Command, Stdio},
        };
        // Generate a disposable synthetic key in memory. No user key or credential is accessed.
        let generated = Command::new("/usr/bin/openssl")
            .args(["genrsa", "2048"])
            .output()
            .unwrap();
        assert!(generated.status.success());
        let pem = generated.stdout;
        let mut modulus = Command::new("/usr/bin/openssl")
            .args(["rsa", "-modulus", "-noout"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        modulus.stdin.take().unwrap().write_all(&pem).unwrap();
        let output = modulus.wait_with_output().unwrap();
        assert!(output.status.success());
        let output = String::from_utf8(output.stdout).unwrap();
        let hex = output.trim().strip_prefix("Modulus=").unwrap();
        let bytes = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect::<Vec<_>>();
        let keys:jsonwebtoken::jwk::JwkSet=serde_json::from_value(json!({"keys":[{"kty":"RSA","kid":"fixture","alg":"RS256","use":"sig","n":URL_SAFE_NO_PAD.encode(bytes),"e":"AQAB"}]})).unwrap();
        let now = now();
        let attempt =
            OAuthAttempt::new("google", "fixture-client", "http://127.0.0.1:40000/", now).unwrap();
        let claims = json!({"nonce":attempt.nonce,"sub":"fixture-subject","aud":"fixture-client","iss":"https://accounts.google.com","iat":now/1000,"exp":now/1000+240});
        let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256);
        header.kid = Some("fixture".into());
        let signing = jsonwebtoken::EncodingKey::from_rsa_pem(&pem).unwrap();
        let token = jsonwebtoken::encode(&header, &claims, &signing).unwrap();
        assert_eq!(
            attempt.verify_signed_identity(&token, &keys, now).unwrap()["sub"],
            "fixture-subject"
        );
        let mut bad = claims.clone();
        bad["nonce"] = json!("wrong");
        let token = jsonwebtoken::encode(&header, &bad, &signing).unwrap();
        assert!(attempt.verify_signed_identity(&token, &keys, now).is_err());
        let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256);
        header.kid = Some("fixture".into());
        let token = jsonwebtoken::encode(
            &header,
            &claims,
            &jsonwebtoken::EncodingKey::from_secret(b"synthetic-fixture-only"),
        )
        .unwrap();
        assert!(attempt.verify_signed_identity(&token, &keys, now).is_err());
    }
}
