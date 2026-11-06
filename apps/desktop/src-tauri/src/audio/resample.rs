/// Streaming linear resampler from an arbitrary input rate to a target rate,
/// operating on mono `f32` samples and emitting `i16` PCM.
///
/// It keeps `prev`/`frac` state across calls so repeated `process` invocations
/// on successive audio callback buffers stay phase-continuous (no pitch drift or
/// clicks at buffer boundaries). Linear interpolation is more than adequate for
/// speech sent to an STT engine; a higher-quality polyphase resampler (rubato)
/// can replace this later without changing the interface.
pub struct LinearResampler {
    /// Input samples consumed per output sample (= in_rate / out_rate).
    step: f64,
    /// Fractional position in [0, 1) between `prev` and the current sample.
    frac: f64,
    prev: f32,
    has_prev: bool,
}

impl LinearResampler {
    pub fn new(in_rate: u32, out_rate: u32) -> Self {
        Self {
            step: in_rate as f64 / out_rate as f64,
            frac: 0.0,
            prev: 0.0,
            has_prev: false,
        }
    }

    /// Input samples consumed per output sample.
    #[cfg(test)]
    pub fn ratio(&self) -> f64 {
        self.step
    }

    /// Resample a mono `f32` buffer, appending `i16` PCM to `out`.
    pub fn process(&mut self, input: &[f32], out: &mut Vec<i16>) {
        for &cur in input {
            if !self.has_prev {
                self.prev = cur;
                self.has_prev = true;
                continue;
            }
            // Emit every output sample whose position falls between prev and cur.
            while self.frac < 1.0 {
                let v = self.prev + (cur - self.prev) * self.frac as f32;
                out.push((v.clamp(-1.0, 1.0) * 32767.0) as i16);
                self.frac += self.step;
            }
            self.frac -= 1.0;
            self.prev = cur;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn output_len(in_rate: u32, seconds: u32) -> usize {
        let mut resampler = LinearResampler::new(in_rate, 16_000);
        let mut out = Vec::new();
        // Feed in callback-sized chunks to exercise the cross-buffer state.
        let input = vec![0.1f32; (in_rate * seconds) as usize];
        for chunk in input.chunks(512) {
            resampler.process(chunk, &mut out);
        }
        out.len()
    }
    #[test]
    fn a_resampler_rebuilt_for_the_new_rate_keeps_the_timeline_at_real_time() {
        // Before the switch: 48 kHz in, 16 kHz out.
        assert_eq!(LinearResampler::new(48_000, 16_000).ratio(), 3.0);
        // After a hands-free switch the rebuilt resampler uses the new nominal rate.
        assert_eq!(LinearResampler::new(16_000, 16_000).ratio(), 1.0);
        assert_eq!(LinearResampler::new(24_000, 16_000).ratio(), 1.5);
        for rate in [48_000, 24_000, 16_000] {
            let len = output_len(rate, 2) as i64;
            assert!((len - 32_000).abs() <= 2, "{rate} Hz produced {len} samples for 2 s");
        }
        // The bug being fixed: 16 kHz audio pushed through the 48 kHz ratio yields a third of real time.
        let mut stale = LinearResampler::new(48_000, 16_000);
        let mut out = Vec::new();
        stale.process(&vec![0.1f32; 32_000], &mut out);
        assert!(out.len() < 11_000);
    }
}
