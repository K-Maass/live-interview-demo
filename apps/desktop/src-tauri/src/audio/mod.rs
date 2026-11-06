pub mod device_catalog;
pub mod microphone;
pub mod resample;
pub mod silence;
#[cfg(target_os = "macos")]
pub mod system_macos;
pub mod watchdog;
use std::{
    sync::{atomic::AtomicBool, Arc},
    thread::JoinHandle,
};
use tokio::sync::mpsc::UnboundedSender;
pub const TARGET_SAMPLE_RATE: u32 = 16000;
pub struct CapturedFrames {
    pub pcm: Vec<i16>,
    pub captured_at: std::time::Instant,
}
impl CapturedFrames {
    pub fn now(pcm: Vec<i16>) -> Self {
        Self {
            pcm,
            captured_at: std::time::Instant::now(),
        }
    }
}
pub trait AudioSource {
    fn start(
        &self,
        tx: UnboundedSender<CapturedFrames>,
        running: Arc<AtomicBool>,
    ) -> anyhow::Result<JoinHandle<()>>;
}
