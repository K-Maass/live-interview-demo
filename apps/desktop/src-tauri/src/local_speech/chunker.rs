/// Per-lane bounded energy VAD. No speaker identity or provider controls enter here.
pub struct Chunk {
    pub lane: String,
    pub start_ms: u64,
    pub pcm: Vec<i16>,
}
pub struct Chunker {
    lane: String,
    pcm: Vec<i16>,
    total: usize,
    start: usize,
    silent: usize,
    voiced: bool,
    energy: u64,
    window_frames: usize,
    voiced_run: usize,
}
impl Chunker {
    pub fn new(lane: &str) -> Result<Self, String> {
        if lane != "me" && lane != "remote" {
            return Err("invalidCaptureLane".into());
        }
        Ok(Self {
            lane: lane.into(),
            pcm: Vec::new(),
            total: 0,
            start: 0,
            silent: 0,
            voiced: false,
            energy: 0,
            window_frames: 0,
            voiced_run: 0,
        })
    }
    pub fn push(&mut self, frames: &[i16]) -> Vec<Chunk> {
        let mut out = Vec::new();
        for frame in frames {
            if self.pcm.is_empty() {
                self.start = self.total
            }
            self.total += 1;
            self.pcm.push(*frame);
            self.energy += (*frame as i64 * *frame as i64) as u64;
            self.window_frames += 1;
            // Decide from a 20 ms RMS window, not a single background-noise peak.
            if self.window_frames == 320 {
                if self.energy > 500 * 500 * self.window_frames as u64 {
                    self.silent = 0;
                    self.voiced_run += self.window_frames;
                    if self.voiced_run >= 1280 {
                        self.voiced = true;
                    }
                } else {
                    self.silent += self.window_frames;
                    self.voiced_run = 0;
                }
                self.energy = 0;
                self.window_frames = 0;
            }
            if self.pcm.len() >= 128_000 || (self.voiced && self.silent >= 9600) {
                if let Some(chunk) = self.take() {
                    out.push(chunk)
                }
            } else if !self.voiced && self.pcm.len() >= 16000 {
                self.pcm.clear();
                self.silent = 0
            }
        }
        out
    }
    fn take(&mut self) -> Option<Chunk> {
        let pcm = std::mem::take(&mut self.pcm);
        let voiced = self.voiced;
        self.voiced = false;
        self.voiced_run = 0;
        self.energy = 0;
        self.window_frames = 0;
        self.silent = 0;
        if !voiced {
            return None;
        }
        Some(Chunk {
            lane: self.lane.clone(),
            start_ms: (self.start as u64) * 1000 / 16000,
            pcm,
        })
    }
    pub fn pending_frames(&self) -> usize {
        self.pcm.len()
    }
    pub fn timeline_frames(&self) -> usize {
        self.total
    }
    pub fn skip(&mut self, frames: usize) {
        self.total += frames;
    }
    pub fn flush(&mut self) -> Option<Chunk> {
        self.take()
    }
}
