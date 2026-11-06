use reqwest::Url;
use serde_json::{json, Value};
use std::net::IpAddr;
fn public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            !v.is_private()
                && !v.is_loopback()
                && !v.is_link_local()
                && !v.is_unspecified()
                && !v.is_broadcast()
        }
        IpAddr::V6(v) => {
            !v.is_loopback()
                && !v.is_unspecified()
                && !v.is_unique_local()
                && !v.is_unicast_link_local()
                && v.to_ipv4_mapped()
                    .map(|v| public(IpAddr::V4(v)))
                    .unwrap_or(true)
        }
    }
}
/// Longest source ID a reasoning job may carry: the managed service rejects a longer one
/// (apps/service/src/validation.mjs) and the evidence-ID pattern could not cite it
/// (`evidenceIdPattern` in packages/core/src/guidance/engine.ts).
pub(crate) const MAX_SOURCE_ID_LEN: usize = 2048;
/// The source ID of a public-research hit, or `None` when it would exceed the cap. The ID stays the
/// readable `web:<workspace>:<url>` the renderer checks; an over-long URL (a tracking-laden redirect
/// target, in practice) is skipped rather than shortened.
pub(crate) fn web_source_id(workspace_id: &str, target: &Url) -> Option<String> {
    let id = format!("web:{workspace_id}:{target}");
    (id.len() <= MAX_SOURCE_ID_LEN).then_some(id)
}
async fn fetch(url: &Url) -> anyhow::Result<String> {
    anyhow::ensure!(
        url.scheme() == "https" && url.username().is_empty() && url.password().is_none(),
        "publicHttpsOnly"
    );
    let host = url
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("invalidUrl"))?;
    anyhow::ensure!(
        host != "localhost" && !host.ends_with(".local") && !host.ends_with(".internal"),
        "privateHostDenied"
    );
    let addresses = tokio::net::lookup_host((host, url.port_or_known_default().unwrap_or(443)))
        .await?
        .collect::<Vec<_>>();
    anyhow::ensure!(
        !addresses.is_empty() && addresses.iter().all(|a| public(a.ip())),
        "privateHostDenied"
    );
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(12))
        .resolve_to_addrs(host, &addresses)
        .user_agent("LiveInterview/0.1 source retrieval")
        .build()?;
    let response = client.get(url.clone()).send().await?;
    anyhow::ensure!(response.status().is_success(), "researchUnavailable");
    anyhow::ensure!(
        response.content_length().unwrap_or(0) < 2_000_000,
        "pageTooLarge"
    );
    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;
    let mut data = Vec::new();
    while let Some(chunk) = stream.next().await {
        data.extend_from_slice(&chunk?);
        anyhow::ensure!(data.len() < 2_000_000, "pageTooLarge")
    }
    Ok(String::from_utf8_lossy(&data).into_owned())
}
#[tauri::command]
pub async fn search_public_text(query: String, workspace_id: String) -> Result<Vec<Value>, String> {
    if query.len() > 200 || query.trim().is_empty() {
        return Err("invalidPublicQuery".into());
    }
    let mut url = Url::parse("https://html.duckduckgo.com/html/").unwrap();
    url.query_pairs_mut().append_pair("q", &query);
    let html = fetch(&url).await.map_err(|_| "publicResearchUnavailable")?;
    let links = {
        let document = scraper::Html::parse_document(&html);
        let selector = scraper::Selector::parse(".result__a").unwrap();
        document
            .select(&selector)
            .take(3)
            .filter_map(|r| {
                Some((
                    r.text().collect::<Vec<_>>().join(" "),
                    r.value().attr("href")?.to_string(),
                ))
            })
            .collect::<Vec<_>>()
    };
    let mut hits = Vec::new();
    for (title, link) in links {
        let mut target = Url::parse(&link)
            .or_else(|_| url.join(&link))
            .map_err(|_| "researchUnavailable")?;
        let redirect = target
            .query_pairs()
            .find_map(|(k, v)| (k == "uddg").then_some(v.into_owned()));
        if let Some(redirect) = redirect {
            if let Ok(u) = Url::parse(&redirect) {
                target = u
            }
        }
        if target.scheme() != "https" {
            continue;
        }
        let Some(source_id) = web_source_id(&workspace_id, &target) else {
            continue;
        };
        let page = match fetch(&target).await {
            Ok(p) => p,
            Err(_) => continue,
        };
        let text = {
            let page = scraper::Html::parse_document(&page);
            let blocks = scraper::Selector::parse("p,h1,h2,h3,li").unwrap();
            page.select(&blocks)
                .flat_map(|p| p.text())
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(10000)
                .collect::<String>()
        };
        if !text.is_empty() {
            hits.push(json!({"sourceId":source_id,"workspaceId":workspace_id,"kind":"web","title":title,"text":text,"locator":target.as_str(),"revision":1,"derived":false}));
        }
    }
    if hits.is_empty() {
        return Err("publicResearchUnavailable".into());
    }
    crate::context_sources::SourceIndex::open(&crate::commands::data_root())
        .and_then(|s| s.cache_public_sources(&mut hits))
        .map_err(|_| "researchCacheUnavailable")?;
    Ok(hits)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn denies_loopback_linklocal_and_private_addresses() {
        for ip in ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fd00::1"] {
            assert!(!public(ip.parse().unwrap()))
        }
        assert!(public("8.8.8.8".parse().unwrap()))
    }
    #[test]
    fn web_source_ids_never_exceed_the_cap() {
        let ok = Url::parse("https://example.com/r%C3%BCckblick?q=a%20b").unwrap();
        assert_eq!(
            web_source_id("workspace-1", &ok).as_deref(),
            Some("web:workspace-1:https://example.com/r%C3%BCckblick?q=a%20b")
        );
        let workspace = "w".repeat(100);
        let prefix = format!("web:{workspace}:https://example.com/").len();
        let at_cap = Url::parse(&format!("https://example.com/{}", "a".repeat(MAX_SOURCE_ID_LEN - prefix))).unwrap();
        assert_eq!(web_source_id(&workspace, &at_cap).unwrap().len(), MAX_SOURCE_ID_LEN);
        let over = Url::parse(&format!("https://example.com/?u={}", "x".repeat(MAX_SOURCE_ID_LEN))).unwrap();
        assert_eq!(web_source_id(&workspace, &over), None);
    }
}
