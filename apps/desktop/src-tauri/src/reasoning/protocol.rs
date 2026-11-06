use serde_json::{json, Value};
pub fn validate_text_job(input: &Value) -> anyhow::Result<()> {
    fn visit(v: &Value) -> bool {
        match v {
            Value::Object(m) => m.iter().all(|(k, v)| {
                !matches!(
                    k.as_str(),
                    "audio" | "audioPath" | "audioBytes" | "apiKey" | "credential" | "input_audio"
                ) && !(k == "type" && v == "input_audio")
                    && visit(v)
            }),
            Value::Array(a) => a.iter().all(visit),
            _ => true,
        }
    }
    anyhow::ensure!(visit(input), "textOnlyBoundary");
    anyhow::ensure!(input.to_string().len() < 500_000, "jobTooLarge");
    Ok(())
}
pub fn parse_response(response: &Value) -> anyhow::Result<Value> {
    anyhow::ensure!(response["status"] == "completed", "incompleteResponse");
    let mut text = String::new();
    for message in response["output"].as_array().into_iter().flatten() {
        for content in message["content"].as_array().into_iter().flatten() {
            if content["type"] == "output_text" {
                text.push_str(content["text"].as_str().unwrap_or(""))
            }
        }
    }
    let stripped = text
        .trim()
        .strip_prefix("```json")
        .unwrap_or(text.trim())
        .trim()
        .strip_suffix("```")
        .unwrap_or(text.trim())
        .trim();
    Ok(serde_json::from_str(stripped)?)
}
pub fn personal_eligible(limits: &Value) -> Option<Value> {
    let buckets = limits["rateLimitsByLimitId"]
        .as_object()
        .map(|m| m.values().collect::<Vec<_>>())
        .unwrap_or_else(|| vec![&limits["rateLimits"]]);
    let (mut five, mut week) = (None, None);
    for bucket in buckets {
        for key in ["primary", "secondary"] {
            let w = &bucket[key];
            let duration = w["windowDurationMins"].as_u64();
            if !matches!(duration, Some(300 | 10080)) {
                continue;
            }
            let used = w["usedPercent"].as_f64()?;
            if !used.is_finite() || !(0.0..=100.0).contains(&used) {
                return None;
            }
            match duration {
                Some(300) => five = Some(five.map_or(100. - used, |old: f64| old.min(100. - used))),
                Some(10080) => {
                    week = Some(week.map_or(100. - used, |old: f64| old.min(100. - used)))
                }
                _ => {}
            }
        }
    }
    let (five, week) = (five?, week?);
    if five <= 5. || week <= 10. {
        return None;
    }
    Some(json!({"fiveHourRemaining":five,"weeklyRemaining":week}))
}

pub fn parse_usage(response: &Value) -> Option<Value> {
    let input = response["usage"]["input_tokens"].as_u64()?;
    let output = response["usage"]["output_tokens"].as_u64()?;
    Some(json!({"input":input,"output":output}))
}
