use super::chunker::{Chunk, Chunker};
use crate::meeting_records::RecordStore;
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
pub struct RecordingJournal {
    root: PathBuf,
    meeting: String,
    lane: String,
    raw: File,
    chunker: Chunker,
    frames: u64,
    since_sync: usize,
    checkpoint_frames: u64,
    was_paused: bool,
    aligned: bool,
    /// Chunks cut but not yet registered because a write failed. They are retried with backoff, and the
    /// checkpoint stays behind them so a crash still recovers their audio from the raw journal.
    unsaved: std::collections::VecDeque<UnsavedChunk>,
    retry_at: Option<std::time::Instant>,
    failures: u32,
    retry_delay: fn(u32) -> std::time::Duration,
    #[cfg(test)]
    block_saves: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
struct UnsavedChunk {
    id: String,
    chunk: Chunk,
}
/// A packet that starts this much later than the lane's timeline marks a capture gap.
pub const GAP_FRAMES: u64 = 8000;
/// Frames to skip so a packet captured at `start_ms` lands at its real time, when the lane's timeline
/// has fallen behind by at least [`GAP_FRAMES`]. A timeline ahead of wall time is never moved back.
pub fn timeline_gap(timeline_frames: u64, start_ms: u64) -> Option<u64> {
    let expected = start_ms * 16;
    (expected >= timeline_frames + GAP_FRAMES).then(|| expected - timeline_frames)
}
/// Wait before retrying a failed chunk write: 0.5 s doubling to 30 s.
pub fn journal_backoff(failures: u32) -> std::time::Duration {
    std::time::Duration::from_millis(500u64.saturating_mul(1 << failures.min(6)).min(30_000))
}
impl RecordingJournal {
    pub fn new(root: &Path, meeting: &str, lane: &str) -> anyhow::Result<Self> {
        anyhow::ensure!(
            crate::meeting_records::valid_id(meeting),
            "invalidMeetingId"
        );
        let chunker = Chunker::new(lane).map_err(anyhow::Error::msg)?;
        let cache = root.join("cache");
        fs::create_dir_all(&cache)?;
        anyhow::ensure!(
            !fs::symlink_metadata(&cache)?.file_type().is_symlink(),
            "unownedCacheDirectory"
        );
        let dir = cache.join(meeting);
        fs::create_dir_all(&dir)?;
        anyhow::ensure!(
            !fs::symlink_metadata(&dir)?.file_type().is_symlink(),
            "unownedMeetingCache"
        );
        let raw = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(dir.join(format!("{lane}.pcm")))?;
        Ok(Self {
            root: root.into(),
            meeting: meeting.into(),
            lane: lane.into(),
            raw,
            chunker,
            frames: 0,
            since_sync: 0,
            checkpoint_frames: 0,
            was_paused: false,
            aligned: false,
            unsaved: Default::default(),
            retry_at: None,
            failures: 0,
            retry_delay: journal_backoff,
            #[cfg(test)]
            block_saves: Default::default(),
        })
    }
    /// Whether every cut chunk is registered.
    pub fn is_caught_up(&self) -> bool {
        self.unsaved.is_empty()
    }
    pub fn frames(&self) -> u64 {
        self.frames
    }
    pub fn ingest_captured(
        &mut self,
        pcm: &[i16],
        start_ms: u64,
        paused: bool,
    ) -> anyhow::Result<()> {
        if !self.aligned {
            self.chunker.skip((start_ms * 16) as usize);
            self.aligned = true;
            self.checkpoint(true)?;
        } else if let Some(gap) = timeline_gap(self.chunker.timeline_frames() as u64, start_ms) {
            // The source delivered nothing for a while (a stream rebuild, sleep/wake). Close the chunk
            // before the gap and move the timeline to the packet's real time, like a pause, so this lane
            // stays aligned with the other one.
            if !self.was_paused {
                self.flush()?;
            }
            self.chunker.skip(gap as usize);
            self.checkpoint(true)?;
        }
        self.ingest(pcm, paused)
    }
    pub fn ingest(&mut self, pcm: &[i16], paused: bool) -> anyhow::Result<()> {
        if paused {
            if !self.was_paused {
                self.flush()?;
            }
            self.was_paused = true;
            self.chunker.skip(pcm.len());
            return Ok(());
        }
        if self.was_paused {
            self.was_paused = false;
            self.checkpoint(true)?;
        }
        let bytes: Vec<u8> = pcm.iter().flat_map(|v| v.to_le_bytes()).collect();
        if let Err(error) = self.raw.write_all(&bytes) {
            // A short write (disk full) would misalign every later sample. Cut the journal back to the last
            // whole write and keep the timeline moving, so later audio stays at its true time.
            use std::io::{Seek, SeekFrom};
            let _ = self.raw.set_len(self.frames * 2);
            let _ = self.raw.seek(SeekFrom::End(0));
            self.chunker.skip(pcm.len());
            return Err(error.into());
        }
        self.frames += pcm.len() as u64;
        self.since_sync += pcm.len();
        if self.since_sync >= 16000 {
            self.raw.sync_data()?;
            self.since_sync = 0
        }
        let chunks = self.chunker.push(pcm);
        self.unsaved.extend(chunks.into_iter().map(|chunk| UnsavedChunk {
            id: uuid::Uuid::new_v4().to_string(),
            chunk,
        }));
        self.save_unsaved(false)?;
        self.checkpoint(false)?;
        Ok(())
    }
    /// Registers cut chunks in order. After a failure it waits out the backoff unless `force` is set.
    fn save_unsaved(&mut self, force: bool) -> anyhow::Result<()> {
        if self.unsaved.is_empty()
            || (!force && self.retry_at.is_some_and(|at| std::time::Instant::now() < at))
        {
            return Ok(());
        }
        while let Some(next) = self.unsaved.front() {
            #[cfg(test)]
            let result = if self.block_saves.load(std::sync::atomic::Ordering::SeqCst) {
                Err(anyhow::anyhow!("injected journal failure"))
            } else {
                save_chunk(&self.root, &self.meeting, &self.lane, &next.id, &next.chunk)
            };
            #[cfg(not(test))]
            let result = save_chunk(&self.root, &self.meeting, &self.lane, &next.id, &next.chunk);
            if let Err(error) = result {
                self.failures = self.failures.saturating_add(1);
                self.retry_at = Some(std::time::Instant::now() + (self.retry_delay)(self.failures));
                return Err(error);
            }
            self.unsaved.pop_front();
        }
        self.failures = 0;
        self.retry_at = None;
        Ok(())
    }
    fn checkpoint(&mut self, force: bool) -> anyhow::Result<()> {
        // Never move the checkpoint past audio whose chunk is not registered yet: recovery replays from it.
        if !self.unsaved.is_empty() {
            return Ok(());
        }
        let consumed = self
            .frames
            .saturating_sub(self.chunker.pending_frames() as u64);
        if force || consumed > self.checkpoint_frames {
            self.raw.sync_data()?;
            let path = self
                .root
                .join("cache")
                .join(&self.meeting)
                .join(format!("{}.checkpoint.json", self.lane));
            let value = serde_json::json!({"bytes":consumed * 2,"timelineFrame":self.chunker.timeline_frames().saturating_sub(self.chunker.pending_frames())});
            crate::meeting_records::atomic_write(&path, &serde_json::to_vec(&value)?)?;
            self.checkpoint_frames = consumed;
        }
        Ok(())
    }
    pub fn flush(&mut self) -> anyhow::Result<()> {
        self.raw.sync_data()?;
        if let Some(chunk) = self.chunker.flush() {
            self.unsaved.push_back(UnsavedChunk {
                id: uuid::Uuid::new_v4().to_string(),
                chunk,
            });
        }
        self.save_unsaved(true)?;
        self.checkpoint(true)?;
        Ok(())
    }
}

/// Writes the chunk's WAV under its fixed id and registers it. Rewriting the same id on a retry replaces a
/// partial file instead of leaving one orphan WAV per attempt.
fn save_chunk(root: &Path, meeting: &str, lane: &str, id: &str, chunk: &Chunk) -> anyhow::Result<bool> {
    let store = RecordStore::open(root)?;
    crate::owned_paths::directory(root, &["cache", meeting], false)?;
    if store.has_chunk_at(meeting, lane, chunk.start_ms)? {
        return Ok(false);
    }
    let path = root.join("cache").join(meeting).join(format!("{id}.wav"));
    let mut writer = hound::WavWriter::create(
        &path,
        hound::WavSpec {
            channels: 1,
            sample_rate: 16000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        },
    )?;
    for sample in &chunk.pcm {
        writer.write_sample(*sample)?;
    }
    writer.finalize()?;
    File::open(&path)?.sync_all()?;
    store.add_chunk(id, meeting, lane, &path, chunk.start_ms)?;
    Ok(true)
}
/// Recover only durable uncheckpointed samples. Existing registered chunks are never duplicated.
pub fn recover_raw_tail(root: &Path, meeting: &str) -> anyhow::Result<usize> {
    use std::io::{Read, Seek, SeekFrom};
    anyhow::ensure!(
        crate::meeting_records::valid_id(meeting),
        "invalidMeetingId"
    );
    let raw_dir = root.join("cache").join(meeting);
    if !raw_dir.exists() && std::fs::symlink_metadata(&raw_dir).is_err() {
        return Ok(0);
    }
    let dir = crate::owned_paths::directory(root, &["cache", meeting], false)?;
    let mut recovered = 0;
    for lane in ["me", "remote"] {
        let path = dir.join(format!("{lane}.pcm"));
        if !path.is_file() {
            continue;
        }
        anyhow::ensure!(
            !fs::symlink_metadata(&path)?.file_type().is_symlink(),
            "unsafeRawPath"
        );
        let checkpoint = crate::owned_paths::file(
            root,
            &["cache", meeting, &format!("{lane}.checkpoint.json")],
            false,
        )?;
        let meta: serde_json::Value = fs::read(&checkpoint)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or(serde_json::json!({"bytes":0,"timelineFrame":0}));
        let mut file = File::open(&path)?;
        let size = file.metadata()?.len() / 2 * 2;
        let offset = meta["bytes"].as_u64().unwrap_or(0).min(size);
        if offset == size {
            continue;
        }
        file.seek(SeekFrom::Start(offset))?;
        let mut chunker = Chunker::new(lane).map_err(anyhow::Error::msg)?;
        chunker.skip(meta["timelineFrame"].as_u64().unwrap_or(offset / 2) as usize);
        let mut remaining = size - offset;
        let mut bytes = vec![0u8; 32000];
        while remaining > 0 {
            let len = (remaining as usize).min(bytes.len());
            file.read_exact(&mut bytes[..len])?;
            let pcm: Vec<i16> = bytes[..len]
                .chunks_exact(2)
                .map(|b| i16::from_le_bytes([b[0], b[1]]))
                .collect();
            for chunk in chunker.push(&pcm) {
                if save_chunk(root, meeting, lane, &uuid::Uuid::new_v4().to_string(), &chunk)? {
                    recovered += 1;
                }
            }
            remaining -= len as u64;
        }
        if let Some(chunk) = chunker.flush() {
            if save_chunk(root, meeting, lane, &uuid::Uuid::new_v4().to_string(), &chunk)? {
                recovered += 1;
            }
        }
        crate::meeting_records::atomic_write(
            &checkpoint,
            &serde_json::to_vec(
                &serde_json::json!({"bytes":size,"timelineFrame":chunker.timeline_frames()}),
            )?,
        )?;
    }
    Ok(recovered)
}

pub fn has_raw_tail(root: &Path, meeting: &str) -> anyhow::Result<bool> {
    let candidate = root.join("cache").join(meeting);
    if fs::symlink_metadata(&candidate).is_err() {
        return Ok(false);
    }
    let dir = crate::owned_paths::directory(root, &["cache", meeting], false)?;
    for lane in ["me", "remote"] {
        let raw =
            crate::owned_paths::file(root, &["cache", meeting, &format!("{lane}.pcm")], false)?;
        if !raw.exists() {
            continue;
        }
        let checkpoint = crate::owned_paths::file(
            root,
            &["cache", meeting, &format!("{lane}.checkpoint.json")],
            false,
        )?;
        let completed = fs::read(checkpoint)
            .ok()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
            .and_then(|v| v["bytes"].as_u64())
            .unwrap_or(0);
        if fs::metadata(raw)?.len() > completed {
            return Ok(true);
        }
    }
    let _ = dir;
    Ok(false)
}

pub use crate::audio::CapturedFrames;
/// What the drain reports about the journal while capture continues.
#[derive(Debug, Clone, PartialEq)]
pub enum JournalHealth {
    /// A write failed. Capture keeps running and the write is retried with backoff.
    Retrying(String),
    /// Every cut chunk is registered again after earlier failures.
    Recovered,
}
/// How long the drain keeps accepting packets after the lane was stopped. A source that stops normally
/// drops its sender within milliseconds; one wedged in a driver call must not keep the journal open.
pub const STOP_DRAIN_GRACE: std::time::Duration = std::time::Duration::from_secs(2);
/// Drain every packet already captured, including when the source gate has been stopped. A journal or
/// database error never ends the drain: the source keeps capturing, the failed write is retried, and
/// `report` hears about the failure and the recovery once each. Once `stopped` holds for
/// [`STOP_DRAIN_GRACE`], the channel is closed, the buffered packets are drained and the journal is
/// flushed even if the source never drops its sender. `inspect` sees each packet and whether it was paused.
pub async fn drain_capture(
    journal: &mut RecordingJournal,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<CapturedFrames>,
    started_at: std::time::Instant,
    paused_at: impl Fn(std::time::Instant) -> bool,
    stopped: impl Fn() -> bool,
    mut inspect: impl FnMut(&[i16], bool),
    mut observe: impl FnMut(u64),
    mut report: impl FnMut(JournalHealth),
) -> anyhow::Result<()> {
    let mut failing = false;
    let mut stopped_since: Option<std::time::Instant> = None;
    loop {
        let frames = match tokio::time::timeout(std::time::Duration::from_millis(250), rx.recv()).await {
            Ok(Some(frames)) => frames,
            Ok(None) => break,
            Err(_) => {
                if stopped() {
                    let since = *stopped_since.get_or_insert_with(std::time::Instant::now);
                    if since.elapsed() >= STOP_DRAIN_GRACE {
                        log::warn!("[journal] source did not release its channel after stop; closing it");
                        rx.close();
                    }
                }
                continue;
            }
        };
        let end_ms = frames
            .captured_at
            .saturating_duration_since(started_at)
            .as_millis() as u64;
        let start_ms = end_ms.saturating_sub(frames.pcm.len() as u64 * 1000 / 16000);
        let paused = paused_at(frames.captured_at);
        inspect(&frames.pcm, paused);
        match journal.ingest_captured(&frames.pcm, start_ms, paused) {
            Err(error) if !failing => {
                failing = true;
                log::warn!("[journal] write failed, capture continues and retries: {error}");
                report(JournalHealth::Retrying(error.to_string()));
            }
            Ok(()) if failing && journal.is_caught_up() => {
                failing = false;
                report(JournalHealth::Recovered);
            }
            _ => {}
        }
        observe(journal.frames());
    }
    journal.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn speech(frames: usize) -> Vec<i16> {
        (0..frames).map(|i| if i % 2 == 0 { 3000 } else { -3000 }).collect()
    }
    fn fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!("li-journal-{}", uuid::Uuid::new_v4()));
        let store = RecordStore::open(&root).unwrap();
        store.create("m", &serde_json::json!({"id":"m"})).unwrap();
        root
    }
    // A source wedged in a driver call keeps its sender forever. After stop, the drain must still end,
    // keep the packets it already received and flush the journal.
    #[tokio::test]
    async fn a_stopped_source_that_never_releases_its_channel_still_flushes() {
        let root = fixture();
        let mut journal = RecordingJournal::new(&root, "m", "me").unwrap();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let started = std::time::Instant::now();
        tx.send(CapturedFrames { pcm: speech(16000), captured_at: started + std::time::Duration::from_secs(1) })
            .unwrap();
        let outcome = drain_capture(&mut journal, rx, started, |_| false, || true, |_, _| {}, |_| {}, |_| {}).await;
        outcome.unwrap();
        assert_eq!(journal.frames(), 16000);
        assert!(!has_raw_tail(&root, "m").unwrap(), "the journal was flushed");
        drop(tx);
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn a_capture_gap_moves_the_timeline_forward_only() {
        assert_eq!(timeline_gap(16000, 1000), None);
        assert_eq!(timeline_gap(16000, 1400), None, "jitter below half a second is ignored");
        assert_eq!(timeline_gap(16000, 4000), Some(48000));
        assert_eq!(timeline_gap(64000, 1000), None, "never moved back");
    }
    // After a rebuild the next packet arrives seconds later. Its chunk must start at its real time, not
    // directly after the audio before the gap.
    #[tokio::test]
    async fn speech_after_a_capture_gap_keeps_its_real_start_time() {
        let root = fixture();
        let mut journal = RecordingJournal::new(&root, "m", "me").unwrap();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let started = std::time::Instant::now();
        let at = |ms: u64| started + std::time::Duration::from_millis(ms);
        tx.send(CapturedFrames { pcm: speech(16000), captured_at: at(1000) }).unwrap();
        // Five seconds without frames, then one more second of speech ending at 7 s.
        tx.send(CapturedFrames { pcm: speech(16000), captured_at: at(7000) }).unwrap();
        drop(tx);
        drain_capture(&mut journal, rx, started, |_| false, || false, |_, _| {}, |_| {}, |_| {}).await.unwrap();
        let mut starts: Vec<i64> = RecordStore::open(&root)
            .unwrap()
            .pending_chunks("m")
            .unwrap()
            .iter()
            .map(|c| c["startMs"].as_i64().unwrap())
            .collect();
        starts.sort();
        assert_eq!(starts, vec![0, 6000]);
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn backoff_doubles_and_is_capped() {
        assert_eq!(journal_backoff(1).as_millis(), 1000);
        assert_eq!(journal_backoff(2).as_millis(), 2000);
        assert_eq!(journal_backoff(40).as_millis(), 30_000);
    }
    // A failing database must not end the lane: capture keeps draining, the cut chunk waits with the
    // checkpoint held behind it, and it is registered once writes work again.
    #[tokio::test]
    async fn a_failing_journal_keeps_draining_and_registers_the_chunk_after_recovery() {
        let root = fixture();
        let mut journal = RecordingJournal::new(&root, "m", "remote").unwrap();
        journal.block_saves.store(true, std::sync::atomic::Ordering::SeqCst);
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let started = std::time::Instant::now();
        // 9 s of continuous speech forces a cut at 8 s while saves are blocked.
        for second in 0..9 {
            tx.send(CapturedFrames {
                pcm: speech(16000),
                captured_at: started + std::time::Duration::from_secs(second + 1),
            })
            .unwrap();
        }
        drop(tx);
        let mut reports = Vec::new();
        let mut observed = 0;
        let outcome = drain_capture(
            &mut journal,
            rx,
            started,
            |_| false,
            || false,
            |_, _| {},
            |f| observed = f,
            |h| reports.push(h),
        )
        .await;
        // Every packet was drained even though the journal failed.
        assert_eq!(observed, 9 * 16000);
        assert!(matches!(reports.first(), Some(JournalHealth::Retrying(_))));
        assert_eq!(reports.len(), 1, "a failure is reported once, not per packet");
        assert!(outcome.is_err(), "the final flush still cannot register the chunk");
        assert!(!journal.is_caught_up());
        // The checkpoint never advanced past the unregistered chunk, so recovery can replay it.
        assert!(has_raw_tail(&root, "m").unwrap());
        journal.block_saves.store(false, std::sync::atomic::Ordering::SeqCst);
        journal.flush().unwrap();
        assert!(journal.is_caught_up());
        let pending = RecordStore::open(&root).unwrap().pending_chunks("m").unwrap();
        assert_eq!(pending.len(), 2);
        assert!(!has_raw_tail(&root, "m").unwrap());
        let _ = fs::remove_dir_all(root);
    }
    #[tokio::test]
    async fn a_recovered_journal_reports_recovery_once() {
        let root = fixture();
        let mut journal = RecordingJournal::new(&root, "m", "remote").unwrap();
        journal.retry_delay = |_| std::time::Duration::ZERO;
        let blocked = journal.block_saves.clone();
        blocked.store(true, std::sync::atomic::Ordering::SeqCst);
        let started = std::time::Instant::now();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        for second in 0..9 {
            tx.send(CapturedFrames {
                pcm: speech(16000),
                captured_at: started + std::time::Duration::from_secs(second + 1),
            })
            .unwrap();
        }
        drop(tx);
        let mut reports = Vec::new();
        // Writes work again right after the 8 s chunk failed to register.
        drain_capture(
            &mut journal,
            rx,
            started,
            |_| false,
            || false,
            |_, _| {},
            |frames| {
                if frames >= 8 * 16000 {
                    blocked.store(false, std::sync::atomic::Ordering::SeqCst);
                }
            },
            |h| reports.push(h),
        )
        .await
        .unwrap();
        assert!(matches!(
            reports.as_slice(),
            [JournalHealth::Retrying(_), JournalHealth::Recovered]
        ));
        assert!(journal.is_caught_up());
        let _ = fs::remove_dir_all(root);
    }
}
