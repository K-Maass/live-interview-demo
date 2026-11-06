use live_interview_lib::local_speech::chunker::Chunker;
use live_interview_lib::local_speech::worker::DecodeQueue;
#[test]
fn a_failed_utterance_does_not_block_new_live_speech_and_remains_retryable() {
    let mut queue = DecodeQueue::default();
    let pending = vec![
        serde_json::json!({"segmentId":"bad"}),
        serde_json::json!({"segmentId":"later"}),
    ];
    queue.defer("bad");
    assert_eq!(queue.select(&pending)[0]["segmentId"], "later");
    assert_eq!(pending.len(), 2);
    assert_eq!(
        DecodeQueue::default().select(&pending)[0]["segmentId"],
        "bad"
    );
}
#[test]
fn bounded_chunks_keep_lane_and_flush_tail_without_ai() {
    let mut chunker = Chunker::new("remote").unwrap();
    let mut output = Vec::new();
    for _ in 0..100 {
        output.extend(chunker.push(&vec![4000; 1600]));
    }
    output.extend(chunker.flush());
    assert!(output.len() >= 2);
    assert!(output
        .iter()
        .all(|c| c.lane == "remote" && c.pcm.len() <= 128_000));
    assert_eq!(output.iter().map(|c| c.pcm.len()).sum::<usize>(), 160_000);
    assert!(Chunker::new("Lisa").is_err());
}
#[test]
fn background_noise_and_isolated_peaks_do_not_become_speech_chunks() {
    let mut chunker = Chunker::new("me").unwrap();
    let noise: Vec<i16> = (0..128_000)
        .map(|i| {
            if i % 1600 == 0 {
                1800
            } else if i % 2 == 0 {
                212
            } else {
                -212
            }
        })
        .collect();
    assert!(chunker.push(&noise).is_empty());
    assert!(chunker.flush().is_none());
    assert_eq!(chunker.timeline_frames(), noise.len());
}
#[test]
fn sustained_speech_ends_at_a_quiet_pause_despite_background_peaks() {
    let mut chunker = Chunker::new("remote").unwrap();
    let speech: Vec<i16> = (0..8000)
        .map(|i| if i % 2 == 0 { 4000 } else { -4000 })
        .collect();
    assert!(chunker.push(&speech).is_empty());
    let noise: Vec<i16> = (0..16000)
        .map(|i| if i % 1000 == 0 { 1500 } else { 200 })
        .collect();
    let chunks = chunker.push(&noise);
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].lane, "remote");
    assert!(chunks[0].pcm.len() < 20000);
}
