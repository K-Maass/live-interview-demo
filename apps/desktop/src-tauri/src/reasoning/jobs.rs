use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

const CANCELLATION_TTL: Duration = Duration::from_secs(120);
const MAX_CANCELLATIONS: usize = 1024;

#[derive(Default)]
pub(super) struct JobRegistry {
    active: HashMap<String, Arc<AtomicBool>>,
    cancelled: HashMap<String, Instant>,
}

impl JobRegistry {
    pub(super) fn register(
        &mut self,
        id: &str,
        now: Instant,
    ) -> Result<Arc<AtomicBool>, &'static str> {
        self.prune(now);
        if self.active.contains_key(id) {
            return Err("duplicateJob");
        }
        let token = Arc::new(AtomicBool::new(self.cancelled.contains_key(id)));
        self.active.insert(id.to_string(), token.clone());
        Ok(token)
    }
    pub(super) fn cancel(&mut self, id: &str, now: Instant) {
        self.prune(now);
        if let Some(token) = self.active.get(id) {
            token.store(true, Ordering::SeqCst);
        }
        // IPC cancellation can arrive before reasoning_run registers. Remember it
        // longer than the maximum job deadline, without an unbounded ID history.
        if !self.cancelled.contains_key(id) && self.cancelled.len() >= MAX_CANCELLATIONS {
            if let Some(oldest) = self
                .cancelled
                .iter()
                .min_by_key(|(_, at)| *at)
                .map(|(id, _)| id.clone())
            {
                self.cancelled.remove(&oldest);
            }
        }
        self.cancelled.insert(id.to_string(), now);
    }
    pub(super) fn finish(&mut self, id: &str) {
        self.active.remove(id);
    }
    fn prune(&mut self, now: Instant) {
        self.cancelled
            .retain(|_, at| now.saturating_duration_since(*at) < CANCELLATION_TTL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_before_registration_prevents_execution() {
        let mut jobs = JobRegistry::default();
        let now = Instant::now();
        jobs.cancel("queued", now);
        let token = jobs.register("queued", now).unwrap();
        assert!(token.load(Ordering::SeqCst));
    }

    #[test]
    fn cancellation_after_registration_reaches_the_active_job() {
        let mut jobs = JobRegistry::default();
        let now = Instant::now();
        let token = jobs.register("running", now).unwrap();
        jobs.cancel("running", now);
        assert!(token.load(Ordering::SeqCst));
        jobs.finish("running");
        assert!(jobs.active.is_empty());
    }

    #[test]
    fn duplicate_registration_cannot_replace_a_running_token() {
        let mut jobs = JobRegistry::default();
        let now = Instant::now();
        let token = jobs.register("same", now).unwrap();
        assert!(jobs.register("same", now).is_err());
        jobs.cancel("same", now);
        assert!(token.load(Ordering::SeqCst));
    }

    #[test]
    fn cancellation_memory_is_bounded_and_expires() {
        let mut jobs = JobRegistry::default();
        let now = Instant::now();
        for index in 0..MAX_CANCELLATIONS + 10 {
            jobs.cancel(&format!("queued-{index}"), now);
        }
        assert!(jobs.cancelled.len() <= MAX_CANCELLATIONS);
        jobs.cancel("last", now);
        assert!(jobs.register("last", now).unwrap().load(Ordering::SeqCst));
        jobs.finish("last");
        let after_expiry = now + CANCELLATION_TTL + Duration::from_secs(1);
        assert!(!jobs
            .register("last", after_expiry)
            .unwrap()
            .load(Ordering::SeqCst));
        assert!(jobs.cancelled.is_empty());
    }
}
