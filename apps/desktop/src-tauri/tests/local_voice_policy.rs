use live_interview_lib::transcription::validate_local_voice_provider;
#[test]
fn refuses_every_hosted_and_unknown_provider_before_dispatch() {
    for id in [
        "soniox",
        "deepgram",
        "openai",
        "assemblyai",
        "gemini",
        "parley",
        "unknown",
        "https://example.test",
    ] {
        assert!(validate_local_voice_provider(id).is_err(), "accepted {id}");
    }
}
#[test]
fn local_voice_needs_no_key() {
    assert!(validate_local_voice_provider("local-whisper").is_ok());
}
