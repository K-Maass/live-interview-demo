//! Product voice boundary: no hosted adapter is compiled or reachable.
#[derive(Debug, PartialEq)]
pub enum VoiceError {
    HostedOrUnknownProvider,
}
#[derive(Debug, PartialEq)]
pub struct LocalVoiceProfile {
    pub recognition: &'static str,
    pub translation: &'static str,
}
pub fn validate_local_voice_provider(id: &str) -> Result<LocalVoiceProfile, VoiceError> {
    if id != "local-whisper" {
        return Err(VoiceError::HostedOrUnknownProvider);
    }
    Ok(LocalVoiceProfile {
        recognition: "large-v3-turbo",
        translation: "medium",
    })
}
