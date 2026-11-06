use std::{sync::Arc, time::Duration};
use tokio::sync::Semaphore;

/// Device drivers can stall while probing input support. Waiting for their
/// names must neither block an async/UI thread nor create unlimited probes.
pub struct InputDeviceCatalog {
    slot: Arc<Semaphore>,
    wait: Duration,
}
impl Default for InputDeviceCatalog {
    fn default() -> Self {
        Self::new(Duration::from_millis(800))
    }
}
impl InputDeviceCatalog {
    pub fn new(wait: Duration) -> Self {
        Self {
            slot: Arc::new(Semaphore::new(1)),
            wait,
        }
    }

    pub async fn list_with<F>(&self, enumerate: F) -> Result<Vec<String>, String>
    where
        F: FnOnce() -> Result<Vec<String>, String> + Send + 'static,
    {
        let permit = self
            .slot
            .clone()
            .try_acquire_owned()
            .map_err(|_| "inputDeviceListPending".to_string())?;
        let probe = tokio::task::spawn_blocking(move || {
            // A timeout only detaches the wait: the OS operation cannot safely
            // be killed. Keep this permit INSIDE the blocking closure until
            // it returns or unwinds, including after the caller disappears.
            let result = enumerate();
            drop(permit);
            result
        });
        match tokio::time::timeout(self.wait, probe).await {
            Ok(Ok(Ok(names))) => Ok(names),
            Ok(_) => Err("inputDeviceListUnavailable".into()),
            Err(_) => Err("inputDeviceListPending".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    const PENDING: &str = "inputDeviceListPending";
    const UNAVAILABLE: &str = "inputDeviceListUnavailable";

    #[tokio::test(flavor = "current_thread")]
    async fn stalled_enumerator_times_out_without_blocking_the_async_runtime() {
        let catalog = Arc::new(InputDeviceCatalog::new(Duration::from_millis(20)));
        let (release, wait) = std::sync::mpsc::channel();
        // Keep the red phase bounded even if enumeration still runs inline.
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            let _ = release.send(());
        });
        let (started, ready) = tokio::sync::oneshot::channel();
        let task_catalog = catalog.clone();
        let listing = tokio::spawn(async move {
            task_catalog
                .list_with(move || {
                    let _ = started.send(());
                    let _ = wait.recv();
                    Ok(vec!["Delayed microphone".into()])
                })
                .await
        });
        ready.await.unwrap();
        let heartbeat = tokio::spawn(async {
            tokio::time::sleep(Duration::from_millis(5)).await;
            "responsive"
        });
        assert_eq!(listing.await.unwrap(), Err(PENDING.into()));
        assert_eq!(heartbeat.await.unwrap(), "responsive");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn timeout_keeps_the_probe_slot_owned_until_the_blocking_enumerator_finishes() {
        let catalog = Arc::new(InputDeviceCatalog::new(Duration::from_millis(20)));
        let calls = Arc::new(AtomicUsize::new(0));
        let (release, wait) = std::sync::mpsc::channel();
        let fallback_release = release.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            let _ = fallback_release.send(());
        });
        let count = calls.clone();
        let result = catalog
            .list_with(move || {
                count.fetch_add(1, Ordering::SeqCst);
                let _ = wait.recv();
                Ok(vec![])
            })
            .await;
        assert_eq!(result, Err(PENDING.into()));
        for _ in 0..20 {
            let count = calls.clone();
            assert_eq!(
                catalog
                    .list_with(move || {
                        count.fetch_add(1, Ordering::SeqCst);
                        Ok(vec![])
                    })
                    .await,
                Err(PENDING.into())
            );
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let _ = release.send(());
        let result = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                match catalog
                    .list_with(|| Ok(vec!["Recovered microphone".into()]))
                    .await
                {
                    Err(code) if code == PENDING => {
                        tokio::time::sleep(Duration::from_millis(5)).await
                    }
                    result => break result,
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(result, Ok(vec!["Recovered microphone".into()]));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn normal_enumeration_preserves_the_device_names_success_shape() {
        let catalog = InputDeviceCatalog::new(Duration::from_millis(100));
        assert_eq!(
            catalog
                .list_with(|| Ok(vec!["Built-in microphone".into(), "USB microphone".into()]))
                .await,
            Ok(vec!["Built-in microphone".into(), "USB microphone".into()])
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn enumerator_failure_is_safe_and_releases_the_next_probe_slot() {
        let catalog = InputDeviceCatalog::new(Duration::from_millis(100));
        assert_eq!(
            catalog
                .list_with(|| Err("driver details must not cross IPC".into()))
                .await,
            Err(UNAVAILABLE.into())
        );
        assert_eq!(
            catalog.list_with(|| Ok(vec!["Microphone".into()])).await,
            Ok(vec!["Microphone".into()])
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn enumerator_panic_is_safe_and_releases_the_next_probe_slot() {
        let catalog = InputDeviceCatalog::new(Duration::from_millis(100));
        assert_eq!(
            catalog
                .list_with(|| panic!("injected device driver panic"))
                .await,
            Err(UNAVAILABLE.into())
        );
        assert_eq!(
            catalog.list_with(|| Ok(vec!["Microphone".into()])).await,
            Ok(vec!["Microphone".into()])
        );
    }
}
