use live_interview_lib::public_connectors::{
    all_day_span, apple_placeholder, bind_loopback, calendar_list_url, collect_pages, event_url, loopback_redirect, parse_event,
    refresh_form, revoke_google_grant, scope_covers, scope_string, CalendarStore, OAuthAttempt,
    GOOGLE_CALENDAR_LIST_FIELDS, GOOGLE_EVENT_FIELDS, MICROSOFT_CALENDAR_SELECT,
    MICROSOFT_EVENT_SELECT, midnight_ms_in,
};
use serde_json::{json, Value};
use url::Url;
#[test]
fn pkce_callback_rejects_wrong_state_duplicate_code_expired_and_wrong_path() {
    let attempt = OAuthAttempt::new(
        "google",
        "client-id",
        "http://127.0.0.1:34567/oauth/callback",
        1000,
    )
    .unwrap();
    let url = attempt.authorization_url().unwrap();
    assert!(url.contains("code_challenge_method=S256"));
    assert!(url.contains("nonce="));
    assert!(attempt
        .validate_callback("/oauth/callback?state=wrong&code=abc", 1001)
        .is_err());
    assert!(attempt
        .validate_callback(
            &format!("/oauth/callback?state={}&code=abc&code=def", attempt.state),
            1001
        )
        .is_err());
    assert!(attempt
        .validate_callback(&format!("/wrong?state={}&code=abc", attempt.state), 1001)
        .is_err());
    assert!(attempt
        .validate_callback(
            &format!("/oauth/callback?state={}&code=abc", attempt.state),
            400_000
        )
        .is_err());
    assert_eq!(
        attempt
            .validate_callback(
                &format!("/oauth/callback?state={}&code=abc", attempt.state),
                1001
            )
            .unwrap(),
        "abc"
    );
    assert!(attempt.validate_claims(&json!({"nonce":"wrong","sub":"s","aud":"client-id","iss":"https://accounts.google.com","exp":500}),1001).is_err());
}
#[test]
fn selected_sources_are_account_isolated_and_disconnect_removes_active_evidence() {
    let root = std::env::temp_dir().join(format!("public-cal-{}", uuid::Uuid::new_v4()));
    let store = CalendarStore::open(&root).unwrap();
    for id in ["a", "b"] {
        store.save_account(&json!({"id":id,"provider":"google","name":id,"status":"connected","selectedCalendarIds":[]})).unwrap();
        store.save_sources(id,&[json!({"id":"primary","accountId":id,"name":"Primary","read":true,"edit":false,"selected":false})]).unwrap();
    }
    store.select("a", &["primary".into()]).unwrap();
    assert!(store.select("a", &["unknown".into()]).is_err());
    assert_eq!(store.sources("b").unwrap()[0]["selected"], false);
    store
        .reconcile(
            "a",
            "primary",
            100,
            200,
            &[json!({"id":"a-event","startMs":110,"endMs":120})],
            true,
        )
        .unwrap();
    store
        .reconcile("a", "primary", 100, 200, &[], false)
        .unwrap();
    assert_eq!(store.cached("a", "primary", 100, 200).unwrap().len(), 1);
    store
        .reconcile("a", "primary", 100, 200, &[], true)
        .unwrap();
    assert!(store.cached("a", "primary", 100, 200).unwrap().is_empty());
    store.disconnect("a").unwrap();
    assert_eq!(store.accounts().unwrap().len(), 1);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn event_occurrence_ids_are_account_qualified_and_malformed_dates_are_rejected() {
    let value = json!({"id":"same","summary":"Fixture","start":{"dateTime":"2026-10-10T12:00:00+02:00"},"end":{"dateTime":"2026-10-10T13:00:00+02:00"},"recurringEventId":"series","originalStartTime":{"dateTime":"2026-10-10T12:00:00+02:00"}});
    let a = parse_event("google", "a", "primary", &value).unwrap();
    let b = parse_event("google", "b", "primary", &value).unwrap();
    assert_ne!(a["id"], b["id"]);
    assert_eq!(a["startMs"], 1791626400000i64);
    assert!(parse_event(
        "google",
        "a",
        "primary",
        &json!({"id":"bad","start":{"dateTime":"tomorrow"},"end":{"dateTime":"yesterday"}})
    )
    .is_err());
    let mut moved = value.clone();
    moved["start"] = json!({"dateTime":"2026-10-11T12:00:00+02:00"});
    moved["end"] = json!({"dateTime":"2026-10-11T13:00:00+02:00"});
    // A moved occurrence retains originalStartTime as its identity basis.
    assert_eq!(
        a["id"],
        parse_event("google", "a", "primary", &moved).unwrap()["id"]
    );
}
#[tokio::test]
async fn paginated_http_result_merges_pages_and_marks_cycles_partial() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let second = format!("{origin}/second");
    let server = tokio::spawn(async move {
        for n in 0..2 {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buf = [0; 4096];
            stream.read(&mut buf).await.unwrap();
            let body = if n == 0 {
                json!({"value":[{"id":"one"}],"@odata.nextLink":second})
            } else {
                json!({"value":[{"id":"two"}]})
            }
            .to_string();
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).as_bytes()).await.unwrap();
        }
    });
    let result = collect_pages(
        &reqwest::Client::new(),
        "microsoft",
        &format!("{origin}/first"),
        "fixture-token",
        4,
        true,
    )
    .await
    .unwrap();
    assert!(result.complete);
    assert_eq!(result.items.len(), 2);
    server.await.unwrap();
}
#[tokio::test]
async fn pagination_cycles_and_off_origin_links_do_not_authorize_full_reconciliation() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for foreign in [false, true] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/events", listener.local_addr().unwrap());
        let link = if foreign {
            "https://untrusted.example/events".to_owned()
        } else {
            endpoint.clone()
        };
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buf = [0; 4096];
            stream.read(&mut buf).await.unwrap();
            let body = json!({"value":[{"id":"one"}],"@odata.nextLink":link}).to_string();
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).as_bytes()).await.unwrap();
        });
        let result = collect_pages(
            &reqwest::Client::new(),
            "microsoft",
            &endpoint,
            "fixture-token",
            4,
            true,
        )
        .await;
        if foreign {
            assert!(result.is_err());
        } else {
            let result = result.unwrap();
            assert!(!result.complete);
            assert_eq!(result.items.len(), 1);
            assert_eq!(result.code.as_deref(), Some("calendarPaginationCycle"));
        }
        server.await.unwrap();
    }
}
#[test]
fn microsoft_utc_dates_and_google_all_day_dates_are_checked_without_guessing_bad_ranges() {
    let event = json!({"id":"m","subject":"Fixture","start":{"dateTime":"2026-10-10T10:00:00.0000000","timeZone":"UTC"},"end":{"dateTime":"2026-10-10T11:00:00.0000000","timeZone":"UTC"},"seriesMasterId":"series","originalStart":"2026-10-10T10:00:00Z"});
    let parsed = parse_event("microsoft", "a", "c", &event).unwrap();
    assert_eq!(parsed["startMs"], 1791626400000i64);
    let event = json!({"id":"g","summary":"All day","start":{"date":"2026-10-10"},"end":{"date":"2026-10-11"}});
    let parsed = parse_event("google", "a", "c", &event).unwrap();
    assert_eq!(
        parsed["endMs"].as_i64().unwrap() - parsed["startMs"].as_i64().unwrap(),
        86_400_000
    );
    let event = json!({"id":"g","start":{"dateTime":"2026-10-10T10:00:00Z"},"end":{"dateTime":"2026-10-10T09:00:00Z"}});
    assert!(parse_event("google", "a", "c", &event).is_err());
}
#[test]
fn disconnecting_the_native_calendar_disables_automatic_rediscovery_until_user_reconnects() {
    let root = std::env::temp_dir().join(format!("public-cal-native-{}", uuid::Uuid::new_v4()));
    let store = CalendarStore::open(&root).unwrap();
    store.save_account(&json!({"id":"apple-local","provider":"apple","name":"Calendar","status":"connected","selectedCalendarIds":[]})).unwrap();
    assert!(store.apple_enabled().unwrap());
    store.disconnect("apple-local").unwrap();
    assert!(!CalendarStore::open(&root).unwrap().apple_enabled().unwrap());
    store.set_apple_enabled(true).unwrap();
    assert!(store.apple_enabled().unwrap());
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn withdrawn_macos_access_forgets_the_calendars_but_is_not_a_disconnect() {
    let root = std::env::temp_dir().join(format!("public-cal-native-{}", uuid::Uuid::new_v4()));
    let store = CalendarStore::open(&root).unwrap();
    store.save_account(&json!({"id":"apple-local","provider":"apple","name":"Calendar","status":"connected","selectedCalendarIds":[]})).unwrap();
    store.forget_account("apple-local").unwrap();
    assert!(store.accounts().unwrap().is_empty());
    assert!(store.apple_enabled().unwrap(), "macOS refusing access must not read as the person disconnecting");
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn the_macos_placeholder_tells_access_off_apart_from_disconnected_and_never_asked() {
    assert!(apple_placeholder(true, true, "denied").is_none());
    assert_eq!(apple_placeholder(false, false, "fullAccess").unwrap()["status"], "disconnected");
    for refused in ["denied", "restricted", "writeOnly"] {
        let row = apple_placeholder(true, false, refused).unwrap();
        assert_eq!(row["status"], "accessOff");
        assert_eq!(row["code"], "calendarPermissionDenied");
        assert_eq!(row["selectedCalendarIds"], json!([]));
    }
    // Never asked (or the helper could not say): nothing to report, Settings offers "Allow macOS calendars…".
    assert!(apple_placeholder(true, false, "notDetermined").is_none());
    assert!(apple_placeholder(true, false, "").is_none());
}
#[test]
fn named_timezones_are_resolved_and_ambiguous_naive_dates_are_rejected() {
    let event = json!({"id":"local-time","start":{"dateTime":"2026-10-10T12:00:00","timeZone":"Europe/Zurich"},"end":{"dateTime":"2026-10-10T13:00:00","timeZone":"Europe/Zurich"}});
    assert_eq!(
        parse_event("google", "a", "c", &event).unwrap()["startMs"],
        1791626400000i64
    );
    let ambiguous = json!({"id":"ambiguous","start":{"dateTime":"2026-10-25T02:15:00","timeZone":"Europe/Zurich"},"end":{"dateTime":"2026-10-25T02:45:00","timeZone":"Europe/Zurich"}});
    assert!(parse_event("google", "a", "c", &ambiguous).is_err());
}

fn local_midnight(day: &str) -> i64 {
    use chrono::TimeZone;
    let d = chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").unwrap();
    chrono::Local
        .from_local_datetime(&d.and_hms_opt(0, 0, 0).unwrap())
        .earliest()
        .unwrap()
        .timestamp_millis()
}
#[test]
fn google_all_day_events_carry_their_own_days_and_local_midnight_times() {
    let event = json!({"id":"holiday","summary":"Holiday","start":{"date":"2026-10-20","timeZone":"Europe/Zurich"},"end":{"date":"2026-10-21","timeZone":"Europe/Zurich"}});
    let parsed = parse_event("google", "a", "c", &event).unwrap();
    assert_eq!(parsed["isAllDay"], true);
    assert_eq!(parsed["startDay"], "2026-10-20");
    assert_eq!(parsed["endDay"], "2026-10-21");
    let (start, end) = (
        parsed["startMs"].as_i64().unwrap(),
        parsed["endMs"].as_i64().unwrap(),
    );
    assert_eq!(start, local_midnight("2026-10-20"));
    assert_eq!(end, local_midnight("2026-10-21"));
    let hours = (end - start) / 3_600_000;
    assert!((23..=25).contains(&hours), "one local day, got {hours}h");
    // A multi-day event ends on the exclusive day.
    let multi = json!({"id":"trip","start":{"date":"2026-10-20"},"end":{"date":"2026-10-23"}});
    let multi = parse_event("google", "a", "c", &multi).unwrap();
    assert_eq!(multi["startDay"], "2026-10-20");
    assert_eq!(multi["endDay"], "2026-10-23");
    // Timed events carry neither day field.
    let timed = json!({"id":"t","start":{"dateTime":"2026-10-10T10:00:00Z"},"end":{"dateTime":"2026-10-10T11:00:00Z"}});
    let timed = parse_event("google", "a", "c", &timed).unwrap();
    assert_eq!(timed["isAllDay"], false);
    assert_eq!(timed["recurring"], false);
    assert!(timed.get("startDay").is_none() && timed.get("endDay").is_none());
    assert_eq!(timed["startMs"], 1791626400000i64);
}
#[test]
fn microsoft_all_day_events_keep_their_date_whatever_the_reported_zone() {
    let event = json!({"id":"m1","subject":"Off","isAllDay":true,"start":{"dateTime":"2026-10-20T00:00:00.0000000","timeZone":"UTC"},"end":{"dateTime":"2026-10-21T00:00:00.0000000","timeZone":"UTC"}});
    let parsed = parse_event("microsoft", "a", "c", &event).unwrap();
    assert_eq!(parsed["isAllDay"], true);
    assert_eq!(parsed["startDay"], "2026-10-20");
    assert_eq!(parsed["endDay"], "2026-10-21");
    assert_eq!(parsed["startMs"], local_midnight("2026-10-20"));
    assert_eq!(parsed["endMs"], local_midnight("2026-10-21"));
    // The same values on a timed event (isAllDay false) stay instants.
    let timed = json!({"id":"m2","isAllDay":false,"start":{"dateTime":"2026-10-20T00:00:00.0000000","timeZone":"UTC"},"end":{"dateTime":"2026-10-21T00:00:00.0000000","timeZone":"UTC"}});
    let timed = parse_event("microsoft", "a", "c", &timed).unwrap();
    assert_eq!(timed["isAllDay"], false);
    assert!(timed.get("startDay").is_none());
    assert_eq!(timed["startMs"], 1792454400000i64);
}
#[test]
fn apple_all_day_events_use_the_days_the_helper_reports() {
    let event = json!({"id":"e1","stableId":"item-1","title":"Away","startMs":1792447200000i64,"endMs":1792533599000i64,"isAllDay":true,"startDay":"2026-10-20","endDay":"2026-10-21","recurring":false});
    let parsed = parse_event("apple", "apple-local", "c", &event).unwrap();
    assert_eq!(parsed["isAllDay"], true);
    assert_eq!(parsed["startDay"], "2026-10-20");
    assert_eq!(parsed["endDay"], "2026-10-21");
    assert_eq!(parsed["startMs"], local_midnight("2026-10-20"));
    assert_eq!(parsed["endMs"], local_midnight("2026-10-21"));
    assert!(parsed.get("seriesId").is_none());
    // Without the helper's day strings an all-day claim is not trusted.
    let bare = json!({"id":"e2","stableId":"item-2","startMs":1792447200000i64,"endMs":1792533599000i64,"isAllDay":true});
    let bare = parse_event("apple", "apple-local", "c", &bare).unwrap();
    assert_eq!(bare["isAllDay"], false);
    assert_eq!(bare["startMs"], 1792447200000i64);
}
#[test]
fn all_day_span_rejects_empty_and_reversed_ranges() {
    let same = json!({"start":{"date":"2026-10-20"},"end":{"date":"2026-10-20"}});
    assert!(all_day_span("google", &same).is_none());
    let reversed = json!({"isAllDay":true,"start":{"dateTime":"2026-10-21T00:00:00"},"end":{"dateTime":"2026-10-20T00:00:00"}});
    assert!(all_day_span("microsoft", &reversed).is_none());
    assert!(all_day_span("microsoft", &json!({"start":{"dateTime":"2026-10-20T00:00:00"},"end":{"dateTime":"2026-10-21T00:00:00"}})).is_none());
}
#[test]
fn local_midnight_survives_zones_where_midnight_does_not_exist() {
    // Sao Paulo moved its clocks from 00:00 to 01:00 on 2018-11-04: there was no midnight.
    let sao_paulo: chrono_tz::Tz = "America/Sao_Paulo".parse().unwrap();
    let day = chrono::NaiveDate::from_ymd_opt(2018, 11, 4).unwrap();
    assert_eq!(midnight_ms_in(&sao_paulo, day), 1541300400000i64); // 01:00 -02:00 = 03:00Z
    let zurich: chrono_tz::Tz = "Europe/Zurich".parse().unwrap();
    let day = chrono::NaiveDate::from_ymd_opt(2026, 10, 20).unwrap();
    assert_eq!(midnight_ms_in(&zurich, day), 1792447200000i64);
}
#[test]
fn recurring_events_get_an_opaque_series_id_and_others_do_not() {
    let google = json!({"id":"inst","recurringEventId":"series-g","start":{"dateTime":"2026-10-20T09:00:00Z"},"end":{"dateTime":"2026-10-20T10:00:00Z"},"originalStartTime":{"dateTime":"2026-10-20T09:00:00Z"}});
    let google = parse_event("google", "a", "c", &google).unwrap();
    assert_eq!(google["recurring"], true);
    let sibling = json!({"id":"inst2","recurringEventId":"series-g","start":{"dateTime":"2026-10-27T09:00:00Z"},"end":{"dateTime":"2026-10-27T10:00:00Z"},"originalStartTime":{"dateTime":"2026-10-27T09:00:00Z"}});
    let sibling = parse_event("google", "a", "c", &sibling).unwrap();
    assert_eq!(google["seriesId"], sibling["seriesId"]);
    let series_id = google["seriesId"].as_str().unwrap();
    assert!(series_id.starts_with("google:") && !series_id.contains("series-g"));
    let ms = json!({"id":"m-occ","type":"occurrence","seriesMasterId":"series-m","start":{"dateTime":"2026-10-20T09:00:00.0000000","timeZone":"UTC"},"end":{"dateTime":"2026-10-20T10:00:00.0000000","timeZone":"UTC"}});
    let ms = parse_event("microsoft", "a", "c", &ms).unwrap();
    assert_eq!(ms["recurring"], true);
    assert!(ms["seriesId"].as_str().unwrap().starts_with("microsoft:"));
    // An exception without a series id is still recurring, but has nothing to group by.
    let exception = json!({"id":"m-exc","type":"exception","start":{"dateTime":"2026-10-20T09:00:00.0000000","timeZone":"UTC"},"end":{"dateTime":"2026-10-20T10:00:00.0000000","timeZone":"UTC"}});
    let exception = parse_event("microsoft", "a", "c", &exception).unwrap();
    assert_eq!(exception["recurring"], true);
    assert!(exception.get("seriesId").is_none());
    let apple = json!({"id":"e","stableId":"item-9","startMs":1792486800000i64,"endMs":1792490400000i64,"recurring":true,"occurrenceStartMs":1792486800000i64});
    let apple = parse_event("apple", "apple-local", "c", &apple).unwrap();
    assert_eq!(apple["recurring"], true);
    let apple_series = apple["seriesId"].as_str().unwrap();
    assert!(apple_series.starts_with("apple:") && !apple_series.contains("item-9"));
    for plain in [
        parse_event("google", "a", "c", &json!({"id":"p","start":{"dateTime":"2026-10-20T09:00:00Z"},"end":{"dateTime":"2026-10-20T10:00:00Z"}})).unwrap(),
        parse_event("microsoft", "a", "c", &json!({"id":"p","type":"singleInstance","start":{"dateTime":"2026-10-20T09:00:00.0000000","timeZone":"UTC"},"end":{"dateTime":"2026-10-20T10:00:00.0000000","timeZone":"UTC"}})).unwrap(),
        parse_event("apple", "apple-local", "c", &json!({"id":"p","stableId":"s","startMs":1792486800000i64,"endMs":1792490400000i64,"recurring":false})).unwrap(),
    ] {
        assert_eq!(plain["recurring"], false);
        assert!(plain.get("seriesId").is_none());
    }
}
#[test]
fn event_ids_do_not_change_when_all_day_times_move_to_local_midnight() {
    // Golden value computed with the identity code from before the all-day change:
    // sha256("a\0c\0series:series1:1792447200000") where the number is the raw provider start of
    // the instance (midnight in the calendar's own zone).
    let event = json!({"id":"inst","summary":"Standup day","recurringEventId":"series1","start":{"date":"2026-10-20","timeZone":"Europe/Zurich"},"end":{"date":"2026-10-21","timeZone":"Europe/Zurich"},"originalStartTime":{"date":"2026-10-20","timeZone":"Europe/Zurich"}});
    let parsed = parse_event("google", "a", "c", &event).unwrap();
    assert_eq!(
        parsed["id"],
        "google:94a4c3e59c528c483626a897185a56dcfe0859d6366d36714699b0a43ee7c845"
    );
    assert_eq!(parsed["isAllDay"], true);
    assert_eq!(parsed["recurring"], true);
    // Without originalStartTime the identity falls back to the raw start; same for Microsoft.
    let no_original = json!({"id":"inst","recurringEventId":"series1","start":{"date":"2026-10-20","timeZone":"Europe/Zurich"},"end":{"date":"2026-10-21","timeZone":"Europe/Zurich"}});
    assert_eq!(parse_event("google", "a", "c", &no_original).unwrap()["id"], parsed["id"]);
}
#[test]
fn microsoft_event_select_asks_for_the_all_day_and_type_fields() {
    let fields: Vec<&str> = MICROSOFT_EVENT_SELECT.split(',').collect();
    assert!(fields.contains(&"isAllDay") && fields.contains(&"type"));
    assert!(fields.contains(&"seriesMasterId"));
}
#[test]
fn provider_cancellation_tombstones_remove_cached_events_without_invented_dates() {
    let root = std::env::temp_dir().join(format!("public-cal-cancel-{}", uuid::Uuid::new_v4()));
    let store = CalendarStore::open(&root).unwrap();
    let event=parse_event("google","a","c",&json!({"id":"event","start":{"dateTime":"2026-10-10T10:00:00Z"},"end":{"dateTime":"2026-10-10T11:00:00Z"}})).unwrap();
    store
        .reconcile("a", "c", 1791620000000, 1791640000000, &[event], true)
        .unwrap();
    let cancelled = parse_event(
        "google",
        "a",
        "c",
        &json!({"id":"event","status":"cancelled"}),
    )
    .unwrap();
    store
        .reconcile("a", "c", 1791620000000, 1791640000000, &[cancelled], false)
        .unwrap();
    assert!(store
        .cached("a", "c", 1791620000000, 1791640000000)
        .unwrap()
        .is_empty());
    std::fs::remove_dir_all(root).unwrap();
}

fn query(url: &str, key: &str) -> Option<String> {
    Url::parse(url)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
}
#[test]
fn requested_scopes_are_pinned_to_the_least_privilege_lists() {
    // Changing these re-triggers Google verification (100-user cap) and Microsoft consent.
    assert_eq!(
        scope_string("google"),
        "openid profile email https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.readonly"
    );
    assert_eq!(
        scope_string("microsoft"),
        "openid profile email offline_access https://graph.microsoft.com/Calendars.Read"
    );
    for (provider, redirect) in [
        ("google", "http://127.0.0.1:40000/"),
        ("microsoft", "http://localhost:40000/"),
    ] {
        let attempt = OAuthAttempt::new(provider, "client", redirect, 1000).unwrap();
        let sent = query(&attempt.authorization_url().unwrap(), "scope").unwrap();
        assert_eq!(sent, scope_string(provider));
        assert!(!sent.split(' ').any(|s| s.ends_with("/calendar.readonly")));
        assert!(!sent.contains("ReadWrite"));
    }
}
#[test]
fn partial_google_grants_are_refused_but_the_former_broad_scope_still_works() {
    let list = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
    let events = "https://www.googleapis.com/auth/calendar.events.readonly";
    let legacy = "https://www.googleapis.com/auth/calendar.readonly";
    assert!(scope_covers(
        "google",
        &format!("openid email profile {list} {events}")
    ));
    // A user who unticks one box on the consent screen.
    assert!(!scope_covers(
        "google",
        &format!("openid email profile {events}")
    ));
    assert!(!scope_covers(
        "google",
        &format!("openid email profile {list}")
    ));
    assert!(!scope_covers("google", "openid email profile"));
    // Connections made before the scope was narrowed keep both endpoints available.
    assert!(scope_covers(
        "google",
        &format!("openid email profile {legacy}")
    ));
    assert!(scope_covers(
        "microsoft",
        "openid profile email Calendars.Read"
    ));
    assert!(scope_covers(
        "microsoft",
        "https%3A%2F%2Fgraph.microsoft.com%2FCalendars.Read openid"
    ));
    assert!(!scope_covers("microsoft", "openid profile email User.Read"));
    // Exact match only: a downgraded or different calendar permission does not count.
    for other in ["Calendars.ReadBasic", "Calendars.ReadWrite", "Calendars.Read.Shared"] {
        assert!(!scope_covers("microsoft", &format!("openid profile {other}")));
    }
}
#[test]
fn refresh_requests_never_name_a_scope_so_older_grants_keep_refreshing() {
    let form = refresh_form("refresh", "client");
    assert!(form.iter().all(|(k, _)| *k != "scope"));
    assert_eq!(form[0], ("grant_type", "refresh_token"));
}
#[test]
fn calendar_and_event_requests_select_exactly_the_pinned_fields() {
    let g = calendar_list_url("google");
    assert!(g.starts_with("https://www.googleapis.com/calendar/v3/users/me/calendarList?"));
    assert_eq!(query(&g, "fields").unwrap(), GOOGLE_CALENDAR_LIST_FIELDS);
    assert_eq!(
        GOOGLE_CALENDAR_LIST_FIELDS,
        "nextPageToken,items(id,summary,summaryOverride,accessRole,timeZone,backgroundColor)"
    );
    let m = calendar_list_url("microsoft");
    assert!(m.starts_with("https://graph.microsoft.com/v1.0/me/calendars?"));
    assert_eq!(query(&m, "$select").unwrap(), MICROSOFT_CALENDAR_SELECT);
    assert_eq!(MICROSOFT_CALENDAR_SELECT, "id,name,hexColor");
    assert_eq!(query(&m, "$top").unwrap(), "100");
    let g = event_url("google", "primary", 1_791_620_000_000, 1_791_640_000_000).unwrap();
    assert_eq!(query(&g, "fields").unwrap(), GOOGLE_EVENT_FIELDS);
    assert_eq!(query(&g, "singleEvents").unwrap(), "true");
    assert_eq!(query(&g, "showDeleted").unwrap(), "true");
    assert_eq!(
        GOOGLE_EVENT_FIELDS,
        "nextPageToken,items(id,status,summary,start,end,originalStartTime,recurringEventId,organizer(email),attendees(displayName,email),hangoutLink,etag)"
    );
    let m = event_url("microsoft", "cal", 1_791_620_000_000, 1_791_640_000_000).unwrap();
    assert_eq!(query(&m, "$select").unwrap(), MICROSOFT_EVENT_SELECT);
    assert_eq!(query(&m, "$top").unwrap(), "1000");
    assert_eq!(
        MICROSOFT_EVENT_SELECT,
        "id,subject,start,end,isAllDay,type,originalStart,seriesMasterId,isCancelled,organizer,attendees,onlineMeeting,changeKey"
    );
    // Properties Graph documents as excluded from Calendars.ReadBasic are never requested.
    for banned in ["body", "bodyPreview", "attachments", "extensions", "location"] {
        assert!(!MICROSOFT_EVENT_SELECT.split(',').any(|f| f == banned));
    }
}
// A minimal reader for Google's `fields` syntax: a,b(c,d),e(f). Used to prove that the requested
// fields are enough for the parser: the parsed event must be identical with only those fields.
struct Node {
    name: String,
    children: Vec<Node>,
}
fn parse_fields(s: &str) -> Vec<Node> {
    fn level(chars: &[char], i: &mut usize) -> Vec<Node> {
        let mut nodes = vec![];
        let mut name = String::new();
        while *i < chars.len() {
            match chars[*i] {
                '(' => {
                    *i += 1;
                    let children = level(chars, i);
                    nodes.push(Node {
                        name: std::mem::take(&mut name),
                        children,
                    });
                }
                ')' => {
                    *i += 1;
                    if !name.is_empty() {
                        nodes.push(Node {
                            name,
                            children: vec![],
                        });
                    }
                    return nodes;
                }
                ',' => {
                    *i += 1;
                    if !name.is_empty() {
                        nodes.push(Node {
                            name: std::mem::take(&mut name),
                            children: vec![],
                        });
                    }
                }
                c => {
                    name.push(c);
                    *i += 1;
                }
            }
        }
        if !name.is_empty() {
            nodes.push(Node {
                name,
                children: vec![],
            });
        }
        nodes
    }
    level(&s.chars().collect::<Vec<_>>(), &mut 0)
}
fn project(value: &Value, nodes: &[Node]) -> Value {
    match value {
        Value::Array(rows) => Value::Array(rows.iter().map(|r| project(r, nodes)).collect()),
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for node in nodes {
                if let Some(v) = map.get(&node.name) {
                    out.insert(
                        node.name.clone(),
                        if node.children.is_empty() {
                            v.clone()
                        } else {
                            project(v, &node.children)
                        },
                    );
                }
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}
#[test]
fn selected_google_fields_are_enough_for_the_parser_and_drop_everything_else() {
    let full = json!({"nextPageToken":"t","items":[{
        "id":"ev1","status":"confirmed","summary":"Quarterly review","description":"private notes",
        "location":"Room 4","htmlLink":"https://calendar.google.com/x","creator":{"email":"c@example.test"},
        "organizer":{"email":"boss@example.test","displayName":"Boss","self":false},
        "attendees":[{"email":"a@example.test","displayName":"Ana","responseStatus":"accepted","comment":"secret"},{"email":"b@example.test","optional":true}],
        "hangoutLink":"https://meet.google.com/aaa-bbbb-ccc","conferenceData":{"entryPoints":[{"uri":"tel:+1"}]},
        "recurringEventId":"series","originalStartTime":{"dateTime":"2026-10-10T10:00:00Z"},
        "start":{"dateTime":"2026-10-10T10:00:00Z","timeZone":"UTC"},"end":{"dateTime":"2026-10-10T11:00:00Z","timeZone":"UTC"},
        "etag":"\"v1\"","attachments":[{"fileUrl":"https://drive.example.test/f"}],"reminders":{"useDefault":true}}]});
    let trimmed = project(&full, &parse_fields(GOOGLE_EVENT_FIELDS));
    assert_eq!(trimmed["nextPageToken"], "t");
    let sent = trimmed["items"][0].to_string();
    for dropped in [
        "private notes",
        "Room 4",
        "secret",
        "conferenceData",
        "attachments",
        "creator",
        "responseStatus",
        "htmlLink",
    ] {
        assert!(!sent.contains(dropped), "{dropped} should not be requested");
    }
    let before = parse_event("google", "acct", "primary", &full["items"][0]).unwrap();
    let after = parse_event("google", "acct", "primary", &trimmed["items"][0]).unwrap();
    assert_eq!(before, after);
    // Not vacuous: the parser really produced the fields the app shows.
    assert_eq!(after["title"], "Quarterly review");
    assert_eq!(after["attendees"].as_array().unwrap().len(), 2);
    assert_eq!(after["organiser"], "boss@example.test");
    assert_eq!(after["joinUrl"], "https://meet.google.com/aaa-bbbb-ccc");
    assert_eq!(after["version"], "\"v1\"");
    assert_eq!(after["timeZone"], "UTC");
    // Cancelled single occurrences keep their series identity from the same fields.
    let gone = json!({"id":"ev1_20261010","status":"cancelled","recurringEventId":"series","originalStartTime":{"dateTime":"2026-10-10T10:00:00Z"},"description":"x"});
    let gone_trimmed = project(&gone, &parse_fields(GOOGLE_EVENT_FIELDS)[1].children);
    assert!(gone_trimmed.get("description").is_none());
    assert_eq!(
        parse_event("google", "acct", "primary", &gone).unwrap(),
        parse_event("google", "acct", "primary", &gone_trimmed).unwrap()
    );
}
#[test]
fn selected_microsoft_fields_are_enough_for_the_parser_and_drop_everything_else() {
    let select: Vec<&str> = MICROSOFT_EVENT_SELECT.split(',').collect();
    let full = json!({"@odata.etag":"W/x","id":"ev1","subject":"Quarterly review","body":{"content":"private notes"},
        "bodyPreview":"private notes","hasAttachments":true,"location":{"displayName":"Room 4"},
        "organizer":{"emailAddress":{"name":"Boss","address":"boss@example.test"}},
        "attendees":[{"emailAddress":{"name":"Ana","address":"a@example.test"},"status":{"response":"accepted"}},{"emailAddress":{"address":"b@example.test"}}],
        "onlineMeeting":{"joinUrl":"https://teams.microsoft.com/l/meetup-join/abc"},"webLink":"https://outlook.office.com/x",
        "seriesMasterId":"series","originalStart":"2026-10-10T10:00:00Z","isCancelled":false,"changeKey":"ck1",
        "start":{"dateTime":"2026-10-10T10:00:00.0000000","timeZone":"UTC"},"end":{"dateTime":"2026-10-10T11:00:00.0000000","timeZone":"UTC"},
        "categories":["red"],"sensitivity":"private"});
    let trimmed: Value = Value::Object(
        full.as_object()
            .unwrap()
            .iter()
            .filter(|(k, _)| select.contains(&k.as_str()))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
    );
    let sent = trimmed.to_string();
    for dropped in ["private notes", "Room 4", "webLink", "categories", "sensitivity"] {
        assert!(!sent.contains(dropped), "{dropped} should not be requested");
    }
    let before = parse_event("microsoft", "acct", "cal", &full).unwrap();
    let after = parse_event("microsoft", "acct", "cal", &trimmed).unwrap();
    assert_eq!(before, after);
    assert_eq!(after["attendees"].as_array().unwrap().len(), 2);
    assert_eq!(after["organiser"], "boss@example.test");
    assert_eq!(
        after["joinUrl"],
        "https://teams.microsoft.com/l/meetup-join/abc"
    );
    assert_eq!(after["version"], "ck1");
}
async fn one_shot_server(status: &'static str) -> (String, tokio::task::JoinHandle<String>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/revoke", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        // Read until the whole body has arrived: headers and body may come in separate segments.
        let mut buf = vec![0u8; 8192];
        let mut n = 0;
        loop {
            n += stream.read(&mut buf[n..]).await.unwrap();
            let text = String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase();
            if let Some((head, body)) = text.split_once("\r\n\r\n") {
                let length = head
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:"))
                    .and_then(|v| v.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                if body.len() >= length {
                    break;
                }
            }
        }
        stream
            .write_all(
                format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .as_bytes(),
            )
            .await
            .unwrap();
        String::from_utf8_lossy(&buf[..n]).into_owned()
    });
    (url, task)
}
#[tokio::test]
async fn revoking_a_google_grant_posts_the_token_in_the_body_and_reports_only_success() {
    let (url, request) = one_shot_server("200 OK").await;
    assert!(revoke_google_grant(&reqwest::Client::new(), &url, "refresh-token-123").await);
    let request = request.await.unwrap();
    assert!(request.starts_with("POST /revoke HTTP/1.1"), "{request}");
    assert!(request
        .to_ascii_lowercase()
        .contains("application/x-www-form-urlencoded"));
    assert!(request.ends_with("token=refresh-token-123"), "{request}");
    // The token is never placed in the URL.
    assert!(!request.lines().next().unwrap().contains("refresh-token-123"));
}
#[tokio::test]
async fn a_failed_or_unreachable_revocation_is_only_false_and_never_an_error() {
    let (url, request) = one_shot_server("400 Bad Request").await;
    assert!(!revoke_google_grant(&reqwest::Client::new(), &url, "t").await);
    request.await.unwrap();
    // Offline: nothing is listening.
    let closed = {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        format!("http://{}/revoke", l.local_addr().unwrap())
    };
    assert!(!revoke_google_grant(&reqwest::Client::new(), &closed, "t").await);
}
#[test]
fn the_microsoft_redirect_matches_the_documented_localhost_registration() {
    assert_eq!(
        loopback_redirect("microsoft", 51234),
        "http://localhost:51234/"
    );
    assert_eq!(loopback_redirect("google", 51234), "http://127.0.0.1:51234/");
    OAuthAttempt::new("microsoft", "c", &loopback_redirect("microsoft", 51234), 1).unwrap();
}
#[tokio::test]
async fn the_microsoft_listener_answers_on_every_loopback_address_localhost_can_resolve_to() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = bind_loopback(true).await.unwrap();
    let mut addresses = vec![format!("127.0.0.1:{}", listener.port)];
    if listener.has_ipv6() {
        addresses.push(format!("[::1]:{}", listener.port));
    }
    for address in addresses {
        let client = tokio::spawn(async move {
            let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
            stream.write_all(b"x").await.unwrap();
        });
        let (mut stream, peer) = listener.accept().await.unwrap();
        assert!(peer.ip().is_loopback());
        let mut byte = [0u8; 1];
        stream.read_exact(&mut byte).await.unwrap();
        client.await.unwrap();
    }
    // The Google listener stays on 127.0.0.1 only.
    assert!(!bind_loopback(false).await.unwrap().has_ipv6());
}
#[test]
fn mac_calendars_are_editable_only_when_eventkit_allows_changes() {
    let sources = live_interview_lib::public_connectors::apple_sources(&json!([
        {"id":"work","name":"Work","account":"iCloud","read":true,"add":true,"edit":true,"color":"#63DA38"},
        {"id":"holidays","name":"Holidays","account":"Subscribed","read":true,"add":false,"edit":false},
    ]))
    .unwrap();
    assert_eq!(sources[0]["edit"], true);
    assert_eq!(sources[1]["edit"], false);
}
#[test]
fn mac_calendars_carry_their_title_account_and_colour_separately() {
    let sources = live_interview_lib::public_connectors::apple_sources(&json!([
        {"id":"work","name":"Work","account":"iCloud","read":true,"add":true,"edit":true,"color":"#63DA38"},
        {"id":"holidays","name":"Holidays","account":"Subscribed","read":true,"add":false,"edit":false,"color":"red"},
    ]))
    .unwrap();
    assert_eq!(sources[0]["name"], "Work");
    assert_eq!(sources[0]["group"], "iCloud");
    assert_eq!(sources[0]["color"], "#63da38");
    assert_eq!(sources[1]["group"], "Subscribed");
    // A colour that is not #rrggbb is left out, never guessed.
    assert!(sources[1].get("color").is_none());
}
#[test]
fn calendar_colours_are_only_ever_hex_rgb() {
    use live_interview_lib::public_connectors::calendar_color;
    assert_eq!(calendar_color(&json!("#039BE5")).as_deref(), Some("#039be5"));
    for bad in [json!(""), json!("auto"), json!("#fff"), json!("#12345g"), json!("rgb(1,2,3)"), json!(null), json!(7)] {
        assert_eq!(calendar_color(&bad), None, "{bad}");
    }
}
#[test]
fn including_a_calendar_keeps_the_existing_selection() {
    let root = std::env::temp_dir().join(format!("public-cal-{}", uuid::Uuid::new_v4()));
    let store = CalendarStore::open(&root).unwrap();
    store.save_account(&json!({"id":"apple-local","provider":"apple","name":"macOS Calendar","status":"connected","selectedCalendarIds":[]})).unwrap();
    store.save_sources("apple-local", &[
        json!({"id":"home","accountId":"apple-local","name":"Home","read":true,"edit":true,"selected":false}),
        json!({"id":"work","accountId":"apple-local","name":"Work","read":true,"edit":true,"selected":false}),
    ]).unwrap();
    store.select("apple-local", &["home".into()]).unwrap();
    store.include_selected("apple-local", "work").unwrap();
    store.include_selected("apple-local", "work").unwrap();
    let selected = store.account("apple-local").unwrap()["selectedCalendarIds"].clone();
    assert_eq!(selected, json!(["home", "work"]));
}
#[test]
fn a_saved_mac_event_gets_the_same_id_as_the_calendar_list() {
    let saved = json!({"id":"EK-1","stableId":"stable-1","calendarId":"work","title":"Client sync","startMs":1_760_000_000_000_i64,"endMs":1_760_001_800_000_i64,"occurrenceStartMs":1_760_000_000_000_i64,"version":"v1"});
    let linked = parse_event("apple", "apple-local", "work", &saved).unwrap();
    // A later read of the same event, renamed in Calendar.app, keeps its id.
    let mut later = saved.clone();
    later["title"] = json!("Client sync (moved room)");
    later["version"] = json!("v2");
    later["id"] = json!("EK-1-new-session");
    let listed = parse_event("apple", "apple-local", "work", &later).unwrap();
    assert_eq!(linked["id"], listed["id"]);
    assert_eq!(linked["title"], "Client sync");
    assert_eq!(linked["sourceEventId"], "stable-1");
}
fn mac_store() -> CalendarStore {
    let root = std::env::temp_dir().join(format!("public-cal-{}", uuid::Uuid::new_v4()));
    CalendarStore::open(&root).unwrap()
}
fn mac_discovery(ids: &[&str]) -> Vec<Value> {
    live_interview_lib::public_connectors::apple_sources(&Value::Array(
        ids.iter()
            .map(|id| json!({"id":id,"name":id,"account":"iCloud","read":true,"add":*id != "holidays","edit":*id != "holidays"}))
            .collect(),
    ))
    .unwrap()
}
fn mac_selected(store: &CalendarStore) -> Value {
    store.account("apple-local").unwrap()["selectedCalendarIds"].clone()
}
const NEW_MAC_ACCOUNT: &str = r#"{"id":"apple-local","provider":"apple","name":"macOS Calendar","status":"connected","selectedCalendarIds":[]}"#;
#[test]
fn fresh_mac_discovery_ticks_every_calendar_including_read_only_ones() {
    let store = mac_store();
    store.save_account(&serde_json::from_str(NEW_MAC_ACCOUNT).unwrap()).unwrap();
    store.save_sources("apple-local", &mac_discovery(&["home", "holidays", "work"])).unwrap();
    assert_eq!(mac_selected(&store), json!(["holidays", "home", "work"]));
    assert!(store.sources("apple-local").unwrap().iter().all(|s| s["selected"] == true));
    let account = store.account("apple-local").unwrap();
    assert_eq!(account["selectionSaved"], false);
    // Read-only calendars are read, but still never offered as a place to save.
    let holidays = store.sources("apple-local").unwrap().into_iter().find(|s| s["id"] == "holidays").unwrap();
    assert_eq!(holidays["edit"], false);
    // Until the person chooses, a calendar that appears later (a new account in Calendar.app) is ticked too.
    store.save_sources("apple-local", &mac_discovery(&["home", "holidays", "work", "new"])).unwrap();
    assert_eq!(mac_selected(&store), json!(["holidays", "home", "new", "work"]));
}
#[test]
fn a_saved_mac_selection_is_never_overridden_and_later_calendars_arrive_unticked() {
    let store = mac_store();
    store.save_account(&serde_json::from_str(NEW_MAC_ACCOUNT).unwrap()).unwrap();
    store.save_sources("apple-local", &mac_discovery(&["home", "work"])).unwrap();
    store.select("apple-local", &["work".into()]).unwrap();
    assert_eq!(store.account("apple-local").unwrap()["selectionSaved"], true);
    store.save_sources("apple-local", &mac_discovery(&["home", "work", "new"])).unwrap();
    assert_eq!(mac_selected(&store), json!(["work"]));
    // Unticking everything is a choice too: discovery leaves it empty, so the Calendar says "No calendars chosen".
    store.select("apple-local", &[]).unwrap();
    store.save_sources("apple-local", &mac_discovery(&["home", "work", "new"])).unwrap();
    assert_eq!(mac_selected(&store), json!([]));
    assert_eq!(store.account("apple-local").unwrap()["selectionSaved"], true);
}
#[test]
fn adding_a_reviewed_save_calendar_is_not_a_choice_by_the_person() {
    let store = mac_store();
    store.save_account(&serde_json::from_str(NEW_MAC_ACCOUNT).unwrap()).unwrap();
    store.save_sources("apple-local", &mac_discovery(&["home"])).unwrap();
    store.include_selected("apple-local", "home").unwrap();
    assert_eq!(store.account("apple-local").unwrap()["selectionSaved"], false);
    store.save_sources("apple-local", &mac_discovery(&["home", "work"])).unwrap();
    assert_eq!(mac_selected(&store), json!(["home", "work"]));
}
#[test]
fn a_legacy_mac_account_that_never_chose_gets_every_calendar_on_the_next_discovery() {
    let store = mac_store();
    // Written by an earlier version: no marker, nothing selected, every calendar stored unticked.
    store.save_account(&serde_json::from_str(NEW_MAC_ACCOUNT).unwrap()).unwrap();
    let mut unticked = mac_discovery(&["home", "work"]);
    for s in &mut unticked { s["selected"] = json!(false); }
    let legacy = store.account("apple-local").unwrap();
    assert!(legacy.get("selectionSaved").is_none());
    assert!(!CalendarStore::selection_saved(&legacy));
    store.save_sources("apple-local", &unticked).unwrap();
    assert_eq!(mac_selected(&store), json!(["home", "work"]));
    assert_eq!(store.account("apple-local").unwrap()["selectionSaved"], false);
}
#[test]
fn a_legacy_account_with_a_selection_is_migrated_as_saved_and_kept() {
    let store = mac_store();
    store.save_account(&json!({"id":"apple-local","provider":"apple","name":"macOS Calendar","status":"connected","selectedCalendarIds":[]})).unwrap();
    store.save_sources("apple-local", &mac_discovery(&["home", "work"])).unwrap();
    store.select("apple-local", &["home".into()]).unwrap();
    // Drop the marker to get the body an earlier version would have written after the person saved "home".
    let mut legacy = store.account("apple-local").unwrap();
    legacy.as_object_mut().unwrap().remove("selectionSaved");
    store.save_account(&legacy).unwrap();
    assert!(CalendarStore::selection_saved(&legacy));
    store.save_sources("apple-local", &mac_discovery(&["home", "work", "new"])).unwrap();
    assert_eq!(mac_selected(&store), json!(["home"]));
    assert_eq!(store.account("apple-local").unwrap()["selectionSaved"], true);
}
#[test]
fn online_accounts_keep_an_explicit_choice() {
    let store = mac_store();
    store.save_account(&json!({"id":"g","provider":"google","name":"g","status":"connected","selectedCalendarIds":[]})).unwrap();
    store.save_sources("g", &[json!({"id":"primary","accountId":"g","name":"Primary","read":true,"edit":false,"selected":false})]).unwrap();
    assert_eq!(store.account("g").unwrap()["selectedCalendarIds"], json!([]));
    assert_eq!(store.account("g").unwrap()["selectionSaved"], false);
}
#[test]
fn apple_events_carry_writability_and_invitation_flags() {
    let invite = json!({"id":"e","stableId":"item-inv","title":"Partner briefing","startMs":1792486800000i64,"endMs":1792490400000i64,"recurring":false,"calendarWritable":true,"invitation":true,"organiserIsCurrentUser":false});
    let invite = parse_event("apple", "apple-local", "c", &invite).unwrap();
    assert_eq!(invite["readOnly"], false);
    assert_eq!(invite["invitation"], true);
    assert_eq!(invite["organiserIsCurrentUser"], false);
    assert_eq!(invite["calendarWritable"], true);
    // A subscribed calendar, or a row from before the helper reported writability, stays read-only.
    let locked = parse_event("apple", "apple-local", "c", &json!({"id":"e2","stableId":"item-2","startMs":1792486800000i64,"endMs":1792490400000i64,"calendarWritable":false})).unwrap();
    assert_eq!(locked["readOnly"], true);
    let old = parse_event("apple", "apple-local", "c", &json!({"id":"e3","stableId":"item-3","startMs":1792486800000i64,"endMs":1792490400000i64})).unwrap();
    assert_eq!(old["readOnly"], true);
    assert!(old.get("invitation").is_none());
    // Other providers stay read-only and never gain the macOS flags.
    let google = parse_event("google", "a", "c", &json!({"id":"g","calendarWritable":true,"invitation":true,"start":{"dateTime":"2026-10-20T09:00:00Z"},"end":{"dateTime":"2026-10-20T10:00:00Z"}})).unwrap();
    assert_eq!(google["readOnly"], true);
    assert!(google.get("invitation").is_none());
}
#[test]
fn cached_events_outside_the_retention_window_are_dropped() {
    use live_interview_lib::public_connectors::{CACHE_FUTURE_MS, CACHE_PAST_MS};
    let root = std::env::temp_dir().join(format!("public-cal-retention-{}", uuid::Uuid::new_v4()));
    let store = CalendarStore::open(&root).unwrap();
    let now = 1_800_000_000_000_i64;
    let h = 3_600_000;
    let rows = [
        ("old", now - CACHE_PAST_MS - 2 * h),
        ("recent", now - CACHE_PAST_MS + 2 * h),
        ("planned", now + CACHE_FUTURE_MS - 2 * h),
        ("far", now + CACHE_FUTURE_MS + 2 * h),
    ];
    let events: Vec<Value> = rows
        .iter()
        .map(|(id, start)| json!({"id":id,"startMs":start,"endMs":start + h}))
        .collect();
    let (from, until) = (now - CACHE_PAST_MS - 10 * h, now + CACHE_FUTURE_MS + 10 * h);
    store.reconcile("a", "primary", from, until, &events, true).unwrap();
    store.prune_outside_window(now).unwrap();
    let ids: Vec<String> = store
        .cached("a", "primary", from, until)
        .unwrap()
        .iter()
        .map(|e| e["id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(ids, ["recent", "planned"]);
    // Reopening an up-to-date store changes nothing.
    CalendarStore::open(&root).unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
