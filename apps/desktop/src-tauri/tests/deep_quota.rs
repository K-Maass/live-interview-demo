#[test]
fn single_window_model_bucket_does_not_hide_complete_account_windows() {
    let limits = serde_json::json!({"rateLimitsByLimitId":{"model":{"primary":{"usedPercent":0,"windowDurationMins":10080},"secondary":null},"codex":{"primary":{"usedPercent":14,"windowDurationMins":300},"secondary":{"usedPercent":18,"windowDurationMins":10080}}}});
    let value = live_interview_lib::reasoning::protocol::personal_eligible(&limits).unwrap();
    assert_eq!(value["fiveHourRemaining"], 86.0);
    assert_eq!(value["weeklyRemaining"], 82.0);
}
