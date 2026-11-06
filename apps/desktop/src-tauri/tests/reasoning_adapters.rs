use live_interview_lib::reasoning::protocol::{parse_response, personal_eligible, validate_text_job};
use serde_json::json;
#[test]
fn completed_responses_only_and_text_boundary() {
    let complete = json!({"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"{\"say\":\"Useful\"}"}]}]});
    assert_eq!(parse_response(&complete).unwrap()["say"], "Useful");
    assert!(parse_response(&json!({"status":"incomplete","output":complete["output"]})).is_err());
    assert!(validate_text_job(&json!({"audioPath":"/tmp/private.wav"})).is_err());
    assert!(
        validate_text_job(&json!({"source":{"type":"input_audio","data":"sentinel"}})).is_err()
    );
    assert!(personal_eligible(&json!({"rateLimits":{"primary":{"windowDurationMins":300,"usedPercent":95},"secondary":{"windowDurationMins":10080,"usedPercent":10}}})).is_none());
    assert!(personal_eligible(&json!({"rateLimits":{"primary":{"windowDurationMins":300,"usedPercent":10},"secondary":{"windowDurationMins":10080,"usedPercent":10}}})).is_some());
    assert!(personal_eligible(&json!({})).is_none());
}
