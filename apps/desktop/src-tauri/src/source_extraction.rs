use quick_xml::{events::Event, Reader};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Cursor, Read},
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc::RecvTimeoutError,
    },
    time::Duration,
};
/// Appends the character data of a text, CDATA or entity-reference event. quick-xml reports
/// `&amp;` or `&#228;` as separate reference events; predefined and numeric references are
/// resolved here, anything else (a DTD entity is never expanded) is dropped.
fn push_text(event: &Event, out: &mut String) -> anyhow::Result<()> {
    match event {
        Event::Text(e) => out.push_str(&e.decode()?),
        Event::CData(e) => out.push_str(&e.decode()?),
        Event::GeneralRef(e) => {
            if let Some(c) = e.resolve_char_ref().ok().flatten() {
                out.push(c)
            } else if let Some(s) = quick_xml::escape::resolve_predefined_entity(&e.decode()?) {
                out.push_str(s)
            }
        }
        _ => {}
    }
    Ok(())
}
fn end_line(text: &mut String) {
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n')
    }
}
/// Text of a WordprocessingML or DrawingML part. Only `t` elements carry text; the runs of one
/// paragraph join exactly as written (Word may split a word across runs), tabs become spaces,
/// and line breaks and paragraph ends become newlines.
fn xml_text(bytes: &[u8]) -> anyhow::Result<String> {
    let mut reader = Reader::from_reader(bytes);
    let mut text = String::new();
    let mut in_text = 0usize;
    loop {
        let event = reader.read_event()?;
        match &event {
            Event::Start(e) if e.local_name().as_ref() == b"t" => in_text += 1,
            Event::End(e) if e.local_name().as_ref() == b"t" => in_text = in_text.saturating_sub(1),
            Event::End(e) if e.local_name().as_ref() == b"p" => end_line(&mut text),
            Event::Start(e) | Event::Empty(e) => match e.local_name().as_ref() {
                b"tab" => text.push(' '),
                b"br" | b"cr" => end_line(&mut text),
                _ => {}
            },
            Event::Eof => break,
            _ if in_text > 0 => push_text(&event, &mut text)?,
            _ => {}
        }
    }
    Ok(text.trim().to_string())
}

/// Decodes a plain-text file: UTF-8 (a byte-order mark is dropped), UTF-16 marked by a
/// byte-order mark, and otherwise Windows-1252, the usual encoding of older Windows tools and
/// German spreadsheet exports. It never fails, so an unusual encoding still keeps its evidence.
fn decode_text(bytes: &[u8]) -> String {
    fn utf16(bytes: &[u8], unit: fn([u8; 2]) -> u16) -> String {
        char::decode_utf16(bytes.chunks_exact(2).map(|p| unit([p[0], p[1]])))
            .map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER))
            .collect()
    }
    if let Some(rest) = bytes.strip_prefix(b"\xEF\xBB\xBF") {
        return String::from_utf8_lossy(rest).into_owned();
    }
    if let Some(rest) = bytes.strip_prefix(b"\xFF\xFE") {
        return utf16(rest, u16::from_le_bytes);
    }
    if let Some(rest) = bytes.strip_prefix(b"\xFE\xFF") {
        return utf16(rest, u16::from_be_bytes);
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_owned();
    }
    // Windows-1252 is Latin-1 except for 0x80..=0x9F; the five unassigned bytes map to the
    // C1 controls of the same value, as browsers do.
    const HIGH: [char; 32] = [
        '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8D}', 'Ž',
        '\u{8F}', '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9D}',
        'ž', 'Ÿ',
    ];
    bytes
        .iter()
        .map(|&b| match b {
            0x80..=0x9F => HIGH[usize::from(b - 0x80)],
            _ => char::from(b),
        })
        .collect()
}

/// Most decompressed bytes one archive entry may produce. The size an entry declares is chosen by
/// whoever made the file, so reads are bounded by what actually leaves the decompressor.
pub const MAX_ENTRY_BYTES: u64 = 24_000_000;
/// Most decompressed bytes all entries read from one archive may produce together, so many
/// entries just under the per-entry limit cannot add up without bound.
pub const MAX_ARCHIVE_BYTES: u64 = 64_000_000;

/// Most characters (locators included) one file contributes to the index. Small inputs can
/// expand a lot (thousands of spreadsheet cells may all point at one long shared string), so
/// extraction stops here and the file is marked truncated instead of exhausting memory.
pub const MAX_EXTRACTED_CHARS: usize = 5_000_000;

#[derive(Clone, Copy)]
struct Limits {
    entry_bytes: u64,
    archive_bytes: u64,
    chars: usize,
}
const LIMITS: Limits = Limits {
    entry_bytes: MAX_ENTRY_BYTES,
    archive_bytes: MAX_ARCHIVE_BYTES,
    chars: MAX_EXTRACTED_CHARS,
};

/// The text sections of one file. `truncated` is true when extraction stopped at
/// `MAX_EXTRACTED_CHARS` and later content of the file is missing.
#[derive(Debug, Default)]
pub struct Extraction {
    pub sections: Vec<(String, String)>,
    pub truncated: bool,
}

/// Collects sections until the character budget is spent.
struct Collector {
    out: Extraction,
    remaining: usize,
}
impl Collector {
    fn new(chars: usize) -> Self {
        Self {
            out: Extraction::default(),
            remaining: chars,
        }
    }
    /// Adds a section, cut at the remaining budget. Returns false once the budget is spent, after
    /// which every further section is dropped.
    fn push(&mut self, locator: String, text: &str) -> bool {
        if self.out.truncated {
            return false;
        }
        let cost = locator.chars().count();
        if cost >= self.remaining {
            self.out.truncated = true;
            return false;
        }
        self.remaining -= cost;
        match text.char_indices().nth(self.remaining) {
            None => {
                self.remaining -= text.chars().count();
                self.out.sections.push((locator, text.to_owned()));
                true
            }
            Some((cut, _)) => {
                self.out.sections.push((locator, text[..cut].to_owned()));
                self.remaining = 0;
                self.out.truncated = true;
                false
            }
        }
    }
}

/// Reads at most `limit` decompressed bytes from `reader` and debits them from `budget`. Fails
/// with `error` once the entry would exceed `limit` or the remaining `budget`, after reading at
/// most one byte past the smaller of the two.
pub(crate) fn read_limited(
    reader: impl Read,
    limit: u64,
    budget: &mut u64,
    error: &'static str,
) -> anyhow::Result<Vec<u8>> {
    let cap = limit.min(*budget);
    let mut out = Vec::new();
    reader.take(cap.saturating_add(1)).read_to_end(&mut out)?;
    anyhow::ensure!(out.len() as u64 <= cap, error);
    *budget -= out.len() as u64;
    Ok(out)
}

/// Largest source file that is read at all.
pub const MAX_SOURCE_BYTES: u64 = 24_000_000;
/// Most pages a PDF may declare. Larger page trees are refused before any page content is
/// decoded, since one page's compressed streams can expand without a bound pdf-extract enforces.
pub const MAX_PDF_PAGES: usize = 2_000;

fn supported(ext: &str) -> bool {
    matches!(ext, "md" | "txt" | "csv" | "pdf" | "docx" | "pptx" | "xlsx")
}

pub fn extract(path: &Path) -> anyhow::Result<Extraction> {
    extract_with(path, LIMITS)
}
fn extract_with(path: &Path, limits: Limits) -> anyhow::Result<Extraction> {
    let ext = path
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_lowercase();
    anyhow::ensure!(supported(&ext), "unsupportedSource");
    anyhow::ensure!(fs::metadata(path)?.len() <= MAX_SOURCE_BYTES, "sourceTooLarge");
    extract_bytes_with(&ext, &fs::read(path)?, limits)
}

/// Extracts the sections of a file already in memory, `ext` being its lower-case extension.
/// Callers that also digest the file pass the same bytes here, so the stored digest always
/// describes the text that was indexed.
pub fn extract_bytes(ext: &str, bytes: &[u8]) -> anyhow::Result<Extraction> {
    extract_bytes_with(ext, bytes, LIMITS)
}
fn extract_bytes_with(ext: &str, bytes: &[u8], limits: Limits) -> anyhow::Result<Extraction> {
    anyhow::ensure!(supported(ext), "unsupportedSource");
    anyhow::ensure!(bytes.len() as u64 <= MAX_SOURCE_BYTES, "sourceTooLarge");
    let mut out = Collector::new(limits.chars);
    match ext {
        "md" | "txt" | "csv" => {
            out.push("text".into(), &decode_text(bytes));
        }
        "pdf" => {
            // Loading parses the object structure (object streams included) but leaves page
            // content streams compressed; the page count comes from the page tree alone.
            let mut doc = pdf_extract::Document::load_mem(bytes)?;
            if doc.is_encrypted() {
                doc.decrypt("")?;
            }
            anyhow::ensure!(doc.get_pages().len() <= MAX_PDF_PAGES, "sourceTooLarge");
            // One pass over the page tree; pages are decoded in order and only until the
            // character budget is spent. As in pdf-extract's own page loop, a failing page ends
            // extraction and the pages before it are kept, so the error is not propagated.
            let mut pages = PdfPages::new(&mut out);
            let _ = pdf_extract::output_doc(&doc, &mut pages);
        }
        "docx" | "pptx" | "xlsx" => {
            let mut archive = zip::ZipArchive::new(Cursor::new(bytes))?;
            let mut shared = Vec::new();
            let mut budget = limits.archive_bytes;
            if ext == "xlsx" {
                if let Ok(mut entry) = archive.by_name("xl/sharedStrings.xml") {
                    let xml = read_limited(
                        &mut entry,
                        limits.entry_bytes,
                        &mut budget,
                        "sourceTooLarge",
                    )?;
                    // An item is the `t` text of `<si>`, its rich-text runs joined as written;
                    // phonetic guides (`rPh`) are left out.
                    let mut reader = Reader::from_reader(xml.as_slice());
                    let mut item = String::new();
                    let (mut in_text, mut in_phonetic) = (0usize, 0usize);
                    loop {
                        let event = reader.read_event()?;
                        match &event {
                            Event::Start(e) if e.local_name().as_ref() == b"t" => in_text += 1,
                            Event::End(e) if e.local_name().as_ref() == b"t" => {
                                in_text = in_text.saturating_sub(1)
                            }
                            Event::Start(e) if e.local_name().as_ref() == b"rPh" => {
                                in_phonetic += 1
                            }
                            Event::End(e) if e.local_name().as_ref() == b"rPh" => {
                                in_phonetic = in_phonetic.saturating_sub(1)
                            }
                            Event::End(e) if e.local_name().as_ref() == b"si" => {
                                shared.push(std::mem::take(&mut item));
                            }
                            Event::Eof => break,
                            _ if in_text > 0 && in_phonetic == 0 => push_text(&event, &mut item)?,
                            _ => {}
                        }
                    }
                }
            }
            'entries: for n in 0..archive.len() {
                let mut entry = archive.by_index(n)?;
                let name = entry.name().to_string();
                let selected = match ext {
                    "docx" => name == "word/document.xml",
                    "pptx" => name.starts_with("ppt/slides/slide") && name.ends_with(".xml"),
                    "xlsx" => name.starts_with("xl/worksheets/sheet") && name.ends_with(".xml"),
                    _ => false,
                };
                if !selected {
                    continue;
                }
                let xml = read_limited(
                    &mut entry,
                    limits.entry_bytes,
                    &mut budget,
                    "sourceTooLarge",
                )?;
                if ext == "xlsx" {
                    let mut reader = Reader::from_reader(xml.as_slice());
                    let mut cell = String::new();
                    let mut shared_cell = false;
                    let mut value = String::new();
                    let (mut in_value, mut in_inline, mut in_inline_text) = (0usize, 0usize, 0usize);
                    loop {
                        let event = reader.read_event()?;
                        match &event {
                            Event::Start(e) if e.name().as_ref() == b"c" => {
                                cell.clear();
                                value.clear();
                                shared_cell = false;
                                for a in e.attributes().flatten() {
                                    if a.key.as_ref() == b"r" {
                                        cell = String::from_utf8_lossy(&a.value).into_owned()
                                    }
                                    if a.key.as_ref() == b"t" && a.value.as_ref() == b"s" {
                                        shared_cell = true
                                    }
                                }
                            }
                            // A cell's text is its cached value `<v>` or an inline string
                            // `<is><t>`; the formula `<f>` is not content.
                            Event::Start(e) if e.local_name().as_ref() == b"v" => in_value += 1,
                            Event::End(e) if e.local_name().as_ref() == b"v" => {
                                in_value = in_value.saturating_sub(1)
                            }
                            Event::Start(e) if e.local_name().as_ref() == b"is" => in_inline += 1,
                            Event::End(e) if e.local_name().as_ref() == b"is" => {
                                in_inline = in_inline.saturating_sub(1)
                            }
                            Event::Start(e)
                                if in_inline > 0 && e.local_name().as_ref() == b"t" =>
                            {
                                in_inline_text += 1
                            }
                            Event::End(e) if in_inline > 0 && e.local_name().as_ref() == b"t" => {
                                in_inline_text = in_inline_text.saturating_sub(1)
                            }
                            Event::Text(_) | Event::CData(_) | Event::GeneralRef(_)
                                if in_value > 0 || in_inline_text > 0 =>
                            {
                                push_text(&event, &mut value)?
                            }
                            Event::End(e) if e.name().as_ref() == b"c" => {
                                (in_value, in_inline, in_inline_text) = (0, 0, 0);
                                // A shared cell borrows its text; it is copied only up to the budget.
                                let text: &str = if shared_cell {
                                    value
                                        .trim()
                                        .parse::<usize>()
                                        .ok()
                                        .and_then(|i| shared.get(i))
                                        .map(String::as_str)
                                        .unwrap_or("[unresolved shared cell]")
                                } else {
                                    &value
                                };
                                if !text.is_empty() && !out.push(format!("{name}:{cell}"), text)
                                {
                                    break 'entries;
                                }
                                value.clear();
                            }
                            Event::Eof => break,
                            _ => {}
                        }
                    }
                } else if !out.push(name, &xml_text(&xml)?) {
                    break;
                }
            }
        }
        _ => anyhow::bail!("unsupportedSource"),
    }
    Ok(out.out)
}
/// Text written by pdf-extract's plain-text output, shared with the page splitter that reads it.
#[derive(Clone, Default)]
struct PageText(std::rc::Rc<std::cell::RefCell<String>>);
impl std::fmt::Write for PageText {
    fn write_str(&mut self, s: &str) -> std::fmt::Result {
        self.0.borrow_mut().push_str(s);
        Ok(())
    }
}
impl pdf_extract::ConvertToFmt for PageText {
    type Writer = PageText;
    fn convert(self) -> PageText {
        self
    }
}

/// Splits pdf-extract's plain-text output into one section per page, with a fresh layout state
/// per page, and stops the parser once the collector's budget is spent.
struct PdfPages<'a> {
    out: &'a mut Collector,
    text: PageText,
    page: pdf_extract::PlainTextOutput<PageText>,
    number: u32,
}
impl<'a> PdfPages<'a> {
    fn new(out: &'a mut Collector) -> Self {
        let text = PageText::default();
        let page = pdf_extract::PlainTextOutput::new(text.clone());
        Self { out, text, page, number: 0 }
    }
}
impl pdf_extract::OutputDev for PdfPages<'_> {
    fn begin_page(
        &mut self,
        number: u32,
        media_box: &pdf_extract::MediaBox,
        art_box: Option<(f64, f64, f64, f64)>,
    ) -> Result<(), pdf_extract::OutputError> {
        self.number = number;
        self.text.0.borrow_mut().clear();
        self.page = pdf_extract::PlainTextOutput::new(self.text.clone());
        self.page.begin_page(number, media_box, art_box)
    }
    fn end_page(&mut self) -> Result<(), pdf_extract::OutputError> {
        self.page.end_page()?;
        let text = std::mem::take(&mut *self.text.0.borrow_mut());
        if self.out.push(format!("page:{}", self.number), &text) {
            Ok(())
        } else {
            // Budget spent: an error is the only way to stop pdf-extract's page loop.
            Err(pdf_extract::OutputError::FormatError(std::fmt::Error))
        }
    }
    fn output_character(
        &mut self,
        trm: &pdf_extract::Transform,
        width: f64,
        spacing: f64,
        font_size: f64,
        char: &str,
    ) -> Result<(), pdf_extract::OutputError> {
        self.page.output_character(trm, width, spacing, font_size, char)
    }
    fn begin_word(&mut self) -> Result<(), pdf_extract::OutputError> {
        self.page.begin_word()
    }
    fn end_word(&mut self) -> Result<(), pdf_extract::OutputError> {
        self.page.end_word()
    }
    fn end_line(&mut self) -> Result<(), pdf_extract::OutputError> {
        self.page.end_line()
    }
}

/// How long a refresh waits for one file's extraction before giving up on it.
pub const EXTRACTION_TIMEOUT: Duration = Duration::from_secs(60);
/// Most extraction threads working at once. A thread that has run past its budget plus
/// `ABANDON_GRACE` is abandoned: it stops counting here so new files are not starved by a parser
/// that will never return.
const MAX_EXTRACTION_THREADS: usize = 3;
static EXTRACTION_THREADS: AtomicUsize = AtomicUsize::new(0);
/// How long past its time budget a thread may still finish before it is abandoned.
const ABANDON_GRACE: Duration = Duration::from_secs(30);
/// Most abandoned threads kept alive. A stuck parser thread cannot be killed, so once this many are
/// parked every new extraction is refused with `Stalled` until one of them returns. New threads
/// start only while fewer than this many are abandoned, so at most
/// `MAX_EXTRACTION_THREADS + MAX_ABANDONED_THREADS - 1` threads are ever alive.
const MAX_ABANDONED_THREADS: usize = 2;
static ABANDONED_THREADS: AtomicUsize = AtomicUsize::new(0);
const RUNNING: u8 = 0;
const ABANDONED: u8 = 1;
const DONE: u8 = 2;
/// Every extraction thread not yet known to be done, with the moment it is abandoned if still running.
static EXTRACTION_SLOTS: std::sync::Mutex<Vec<(std::time::Instant, std::sync::Arc<std::sync::atomic::AtomicU8>)>> =
    std::sync::Mutex::new(Vec::new());

/// Moves threads past their abandon moment out of the working count, and forgets finished ones.
fn sweep_abandoned(now: std::time::Instant) {
    let Ok(mut slots) = EXTRACTION_SLOTS.lock() else { return };
    slots.retain(|(abandon_at, state)| {
        if now >= *abandon_at
            && state
                .compare_exchange(RUNNING, ABANDONED, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
        {
            ABANDONED_THREADS.fetch_add(1, Ordering::SeqCst);
            EXTRACTION_THREADS.fetch_sub(1, Ordering::SeqCst);
        }
        state.load(Ordering::SeqCst) != DONE
    });
}
/// Called by an extraction thread when its work returns, whichever count it is in.
fn finish_slot(state: &std::sync::atomic::AtomicU8) {
    match state.swap(DONE, Ordering::SeqCst) {
        ABANDONED => ABANDONED_THREADS.fetch_sub(1, Ordering::SeqCst),
        _ => EXTRACTION_THREADS.fetch_sub(1, Ordering::SeqCst),
    };
}

/// Why a guarded extraction produced no sections.
#[derive(Debug, PartialEq, Eq)]
pub enum GuardFailure {
    /// The content is unsupported or malformed: the parser returned an error or panicked.
    Unreadable,
    /// Extraction outlived its time budget; its thread is left to finish on its own.
    TimedOut,
    /// Too many earlier extractions are still running; try again on a later refresh.
    Busy,
    /// Too many earlier extractions never returned; nothing new is parsed until one does. Try
    /// again on a later refresh.
    Stalled,
}

/// Extracts on a separate thread under `catch_expected` and waits at most `timeout`. A parser
/// panic (pdf-extract has many) becomes `Unreadable` without a crash report, and a parser that
/// never returns costs one parked thread instead of the whole refresh.
pub fn extract_guarded(
    ext: &str,
    bytes: Vec<u8>,
    timeout: Duration,
) -> Result<Extraction, GuardFailure> {
    let ext = ext.to_owned();
    run_guarded(move || extract_bytes(&ext, &bytes), timeout)
}
fn run_guarded(
    work: impl FnOnce() -> anyhow::Result<Extraction> + Send + 'static,
    timeout: Duration,
) -> Result<Extraction, GuardFailure> {
    run_guarded_with_grace(work, timeout, ABANDON_GRACE)
}
fn run_guarded_with_grace(
    work: impl FnOnce() -> anyhow::Result<Extraction> + Send + 'static,
    timeout: Duration,
    grace: Duration,
) -> Result<Extraction, GuardFailure> {
    let now = std::time::Instant::now();
    sweep_abandoned(now);
    if ABANDONED_THREADS.load(Ordering::SeqCst) >= MAX_ABANDONED_THREADS {
        return Err(GuardFailure::Stalled);
    }
    if EXTRACTION_THREADS.fetch_add(1, Ordering::SeqCst) >= MAX_EXTRACTION_THREADS {
        EXTRACTION_THREADS.fetch_sub(1, Ordering::SeqCst);
        return Err(GuardFailure::Busy);
    }
    let state = std::sync::Arc::new(std::sync::atomic::AtomicU8::new(RUNNING));
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    let thread_state = state.clone();
    let spawned = std::thread::Builder::new()
        .name("source-extraction".into())
        .spawn(move || {
            // Best effort: on failure the thread keeps its default priority.
            let _ = lower_thread_priority();
            let outcome = crate::crash_report::catch_expected(work);
            finish_slot(&thread_state);
            let _ = send.send(outcome);
        });
    if spawned.is_err() {
        EXTRACTION_THREADS.fetch_sub(1, Ordering::SeqCst);
        return Err(GuardFailure::Busy);
    }
    if let Ok(mut slots) = EXTRACTION_SLOTS.lock() {
        slots.push((now + timeout + grace, state));
    }
    match receive.recv_timeout(timeout) {
        Ok(Ok(Ok(extraction))) => Ok(extraction),
        Ok(_) | Err(RecvTimeoutError::Disconnected) => Err(GuardFailure::Unreadable),
        Err(RecvTimeoutError::Timeout) => Err(GuardFailure::TimedOut),
    }
}

/// Puts the calling thread in the utility quality-of-service class, so document parsing yields
/// CPU to live capture, recognition and translation without being starved by them (the background
/// class can stall it for minutes under recognition load). Extraction threads receive the file
/// bytes already read, so their disk IO priority is not changed.
#[cfg(target_os = "macos")]
fn lower_thread_priority() -> std::io::Result<()> {
    // SAFETY: the call only changes the scheduling class of the current thread.
    let rc = unsafe {
        libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_UTILITY, 0)
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::from_raw_os_error(rc))
    }
}
#[cfg(not(target_os = "macos"))]
fn lower_thread_priority() -> std::io::Result<()> {
    Ok(())
}

pub fn extraction_report(path: &Path) -> Value {
    match extract(path) {
        Ok(e) => json!({"status":"extracted","sections":e.sections,"truncated":e.truncated}),
        Err(_) => json!({"status":"unsupportedOrUnreadable","path":path.to_string_lossy()}),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Write;

    /// Builds an in-memory zip with the given (name, content) entries, deflated.
    pub(crate) fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, content) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(content).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    /// Rewrites the declared uncompressed size of every entry (local and central headers).
    pub(crate) fn forge_declared_sizes(bytes: &mut [u8], declared: u32) {
        let mut i = 0;
        while i + 30 <= bytes.len() {
            match bytes[i..i + 4] {
                [0x50, 0x4b, 0x03, 0x04] => {
                    bytes[i + 22..i + 26].copy_from_slice(&declared.to_le_bytes())
                }
                [0x50, 0x4b, 0x01, 0x02] => {
                    bytes[i + 24..i + 28].copy_from_slice(&declared.to_le_bytes())
                }
                _ => {}
            }
            i += 1;
        }
    }

    fn scratch(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("extract-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    const SMALL: Limits = Limits {
        entry_bytes: 4_000,
        archive_bytes: 10_000,
        chars: 1_000_000,
    };

    fn sheet_with_shared_cells(cells: usize, shared: &str) -> Vec<u8> {
        let strings = format!("<sst><si><t>{shared}</t></si></sst>");
        let row: String = (0..cells)
            .map(|n| format!("<c r=\"A{n}\" t=\"s\"><v>0</v></c>"))
            .collect();
        let sheet = format!("<worksheet><sheetData><row>{row}</row></sheetData></worksheet>");
        zip_bytes(&[
            ("xl/sharedStrings.xml", strings.as_bytes()),
            ("xl/worksheets/sheet1.xml", sheet.as_bytes()),
        ])
    }

    #[test]
    fn cells_sharing_one_long_string_stop_at_the_character_budget() {
        // 2,000 cells x 1 MB would be 2 GB of text without the budget.
        let path = scratch("amplify.xlsx", &sheet_with_shared_cells(2_000, &"x".repeat(1_000_000)));
        let out = extract(&path).unwrap();
        assert!(out.truncated);
        let total: usize = out
            .sections
            .iter()
            .map(|(l, t)| l.chars().count() + t.chars().count())
            .sum();
        assert!(total <= MAX_EXTRACTED_CHARS, "{total}");
        assert!(out.sections.len() <= 6, "{}", out.sections.len());
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_file_within_the_budget_is_not_marked_truncated() {
        let path = scratch("small.xlsx", &sheet_with_shared_cells(3, "Decision owner"));
        let out = extract(&path).unwrap();
        assert!(!out.truncated);
        assert_eq!(out.sections.len(), 3);
        assert_eq!(out.sections[2].1, "Decision owner");
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_long_text_file_is_cut_at_the_budget() {
        let path = scratch("long.txt", "ab".repeat(600_000).as_bytes());
        let out = extract_with(&path, SMALL).unwrap();
        assert!(out.truncated);
        assert_eq!(out.sections[0].1.chars().count(), 1_000_000 - "text".len());
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn an_entry_that_lies_about_its_size_stops_at_the_limit() {
        let body = format!("<w:document><w:t>{}</w:t></w:document>", "a".repeat(200_000));
        let mut bytes = zip_bytes(&[("word/document.xml", body.as_bytes())]);
        assert!(bytes.len() < 4_000, "the bomb is small on disk");
        forge_declared_sizes(&mut bytes, 10);
        let path = scratch("bomb.docx", &bytes);
        let error = extract_with(&path, SMALL).unwrap_err();
        assert_eq!(error.to_string(), "sourceTooLarge");
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn slides_just_under_the_entry_limit_cannot_exceed_the_archive_total() {
        let slide = format!("<p:sld><a:t>{}</a:t></p:sld>", "b".repeat(3_900));
        let names: Vec<String> = (1..=4).map(|n| format!("ppt/slides/slide{n}.xml")).collect();
        let entries: Vec<(&str, &[u8])> =
            names.iter().map(|n| (n.as_str(), slide.as_bytes())).collect();
        let two = scratch("two.pptx", &zip_bytes(&entries[..2]));
        assert_eq!(extract_with(&two, SMALL).unwrap().sections.len(), 2, "two slides fit");
        let four = scratch("four.pptx", &zip_bytes(&entries));
        let error = extract_with(&four, SMALL).unwrap_err();
        assert_eq!(error.to_string(), "sourceTooLarge");
        fs::remove_dir_all(two.parent().unwrap()).unwrap();
        fs::remove_dir_all(four.parent().unwrap()).unwrap();
    }

    #[test]
    fn word_runs_join_as_written_and_entities_are_resolved() {
        let body = concat!(
            r#"<w:document xmlns:w="urn:w"><w:body>"#,
            r#"<w:p><w:r><w:t>Hel</w:t></w:r><w:r><w:t>lo</w:t></w:r>"#,
            r#"<w:r><w:t xml:space="preserve"> world</w:t></w:r></w:p>"#,
            r#"<w:p><w:r><w:t>AT&amp;T &lt;b&gt; M&#252;ller&#x21;</w:t><w:tab/><w:t>&quot;x&apos;</w:t></w:r></w:p>"#,
            r#"<w:p><w:r><w:t>&custom;kept</w:t></w:r></w:p>"#,
            r#"</w:body></w:document>"#
        );
        let path = scratch("runs.docx", &zip_bytes(&[("word/document.xml", body.as_bytes())]));
        let out = extract(&path).unwrap();
        assert_eq!(
            out.sections[0].1,
            "Hello world\nAT&T <b> Müller! \"x'\nkept"
        );
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn slide_paragraphs_and_shared_strings_resolve_entities() {
        let slide = r#"<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>R&amp;D</a:t></a:r><a:br/><a:r><a:t>plan</a:t></a:r></a:p></p:sld>"#;
        let path = scratch("deck.pptx", &zip_bytes(&[("ppt/slides/slide1.xml", slide.as_bytes())]));
        assert_eq!(extract(&path).unwrap().sections[0].1, "R&D\nplan");
        let strings = r#"<sst><si><r><t>Smith </t></r><r><t>&amp; Co</t></r><rPh><t>sumisu</t></rPh></si></sst>"#;
        let sheet = r#"<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>"#;
        let book = scratch(
            "book.xlsx",
            &zip_bytes(&[
                ("xl/sharedStrings.xml", strings.as_bytes()),
                ("xl/worksheets/sheet1.xml", sheet.as_bytes()),
            ]),
        );
        assert_eq!(extract(&book).unwrap().sections[0].1, "Smith & Co");
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
        fs::remove_dir_all(book.parent().unwrap()).unwrap();
    }

    #[test]
    fn spreadsheet_cells_keep_values_and_inline_strings_but_not_formulas() {
        let sheet = concat!(
            r#"<worksheet><sheetData><row>"#,
            r#"<c r="A1"><f>SUM(B1:B2)</f><v>3</v></c>"#,
            r#"<c r="A2" t="str"><f>CONCAT("a";"b")</f><v>ab</v></c>"#,
            r#"<c r="A3" t="inlineStr"><is><t>Q&amp;A</t></is></c>"#,
            r#"<c r="A4"><f>NOW()</f></c>"#,
            r#"</row></sheetData></worksheet>"#
        );
        let book = scratch("formulas.xlsx", &zip_bytes(&[("xl/worksheets/sheet1.xml", sheet.as_bytes())]));
        let cells: Vec<(String, String)> = extract(&book)
            .unwrap()
            .sections
            .into_iter()
            .map(|(l, t)| (l.rsplit(':').next().unwrap().to_owned(), t))
            .collect();
        assert_eq!(
            cells,
            [("A1", "3"), ("A2", "ab"), ("A3", "Q&A")]
                .map(|(l, t)| (l.to_owned(), t.to_owned()))
        );
        fs::remove_dir_all(book.parent().unwrap()).unwrap();
    }

    #[test]
    fn text_files_decode_utf8_utf16_and_windows_1252() {
        let expected = "Größe;Müller;€5 „Zitat“";
        let utf16le: Vec<u8> = [0xFF, 0xFE]
            .into_iter()
            .chain(expected.encode_utf16().flat_map(u16::to_le_bytes))
            .collect();
        let utf16be: Vec<u8> = [0xFE, 0xFF]
            .into_iter()
            .chain(expected.encode_utf16().flat_map(u16::to_be_bytes))
            .collect();
        let bom: Vec<u8> = b"\xEF\xBB\xBF".iter().chain(expected.as_bytes()).copied().collect();
        // "Größe;Müller;€5 „Zitat“" as Windows-1252.
        let cp1252 = b"Gr\xF6\xDFe;M\xFCller;\x805 \x84Zitat\x93".to_vec();
        for (name, bytes) in [
            ("utf8.csv", expected.as_bytes().to_vec()),
            ("bom.csv", bom),
            ("le.txt", utf16le),
            ("be.txt", utf16be),
            ("export.csv", cp1252),
        ] {
            let path = scratch(name, &bytes);
            assert_eq!(extract(&path).unwrap().sections[0].1, expected, "{name}");
            fs::remove_dir_all(path.parent().unwrap()).unwrap();
        }
    }

    #[test]
    fn bytes_already_read_are_extracted_without_touching_the_disk() {
        let out = extract_bytes("csv", b"owner;decision").unwrap();
        assert_eq!(out.sections, [("text".to_owned(), "owner;decision".to_owned())]);
        assert_eq!(extract_bytes("wav", b"RIFF").unwrap_err().to_string(), "unsupportedSource");
    }

    /// Tests that use the shared extraction-thread counter run one at a time.
    fn guarded_serial() -> std::sync::MutexGuard<'static, ()> {
        static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());
        SERIAL.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A structurally valid PDF whose only page has no MediaBox, which pdf-extract `expect`s.
    fn pdf_without_media_box() -> Vec<u8> {
        pdf_from_objects(&[
            "<</Type/Catalog/Pages 2 0 R>>".into(),
            "<</Type/Pages/Kids[3 0 R]/Count 1>>".into(),
            "<</Type/Page/Parent 2 0 R/Contents 4 0 R>>".into(),
            "<</Length 0>>stream\n\nendstream".into(),
        ])
    }

    /// A PDF with `pages` pages, each showing `text` in Helvetica. Object 3 is the shared font.
    fn pdf_with_pages(pages: usize, text: &str) -> Vec<u8> {
        let content = format!("BT /F1 12 Tf 10 50 Td ({text}) Tj ET");
        let kids: Vec<String> = (0..pages).map(|n| format!("{} 0 R", 5 + n)).collect();
        let mut objects = vec![
            "<</Type/Catalog/Pages 2 0 R>>".to_string(),
            format!("<</Type/Pages/Kids[{}]/Count {pages}>>", kids.join(" ")),
            "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>".to_string(),
            format!("<</Length {}>>stream\n{content}\nendstream", content.len()),
        ];
        objects.extend((0..pages).map(|_| {
            "<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Resources<</Font<</F1 3 0 R>>>>/Contents 4 0 R>>".to_string()
        }));
        pdf_from_objects(&objects)
    }

    fn pdf_from_objects(objects: &[String]) -> Vec<u8> {
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (n, body) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend(format!("{} 0 obj\n{body}\nendobj\n", n + 1).as_bytes());
        }
        let xref = pdf.len();
        pdf.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
        for offset in offsets {
            pdf.extend(format!("{offset:010} 00000 n \n").as_bytes());
        }
        pdf.extend(
            format!(
                "trailer\n<</Size {}/Root 1 0 R>>\nstartxref\n{xref}\n%%EOF\n",
                objects.len() + 1
            )
            .as_bytes(),
        );
        pdf
    }

    #[test]
    fn a_pdf_that_panics_the_parser_is_unreadable_not_a_crash() {
        let _serial = guarded_serial();
        let pdf = pdf_without_media_box();
        let caught = crate::crash_report::catch_expected(|| extract_bytes("pdf", &pdf));
        assert!(caught.is_err(), "this fixture must exercise a pdf-extract panic");
        assert_eq!(
            extract_guarded("pdf", pdf, EXTRACTION_TIMEOUT).unwrap_err(),
            GuardFailure::Unreadable
        );
        assert_eq!(
            extract_guarded("pdf", b"%PDF-1.4 truncated".to_vec(), EXTRACTION_TIMEOUT).unwrap_err(),
            GuardFailure::Unreadable
        );
        let ok = extract_guarded("txt", b"plain".to_vec(), EXTRACTION_TIMEOUT).unwrap();
        assert_eq!(ok.sections[0].1, "plain");
    }

    #[test]
    fn stuck_extractions_time_out_and_are_bounded() {
        let _serial = guarded_serial();
        let (release, gate) = std::sync::mpsc::channel::<()>();
        let gate = std::sync::Arc::new(std::sync::Mutex::new(gate));
        let stuck = |gate: std::sync::Arc<std::sync::Mutex<std::sync::mpsc::Receiver<()>>>| {
            move || {
                let _ = gate.lock().unwrap().recv();
                Ok(Extraction::default())
            }
        };
        let mut timed_out = 0;
        let mut busy = 0;
        for _ in 0..MAX_EXTRACTION_THREADS + 2 {
            match run_guarded(stuck(gate.clone()), Duration::from_millis(30)) {
                Err(GuardFailure::TimedOut) => timed_out += 1,
                Err(GuardFailure::Busy) => busy += 1,
                other => panic!("{other:?}"),
            }
        }
        assert!(timed_out <= MAX_EXTRACTION_THREADS && busy >= 2, "{timed_out} {busy}");
        assert!(EXTRACTION_THREADS.load(Ordering::SeqCst) <= MAX_EXTRACTION_THREADS);
        drop(release); // every parked thread now returns
        let started = std::time::Instant::now();
        while EXTRACTION_THREADS.load(Ordering::SeqCst) > 0 {
            assert!(started.elapsed() < Duration::from_secs(10));
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn abandoned_extractions_free_their_slot_but_stay_bounded() {
        let _serial = guarded_serial();
        let (release, gate) = std::sync::mpsc::channel::<()>();
        let gate = std::sync::Arc::new(std::sync::Mutex::new(gate));
        let stuck = |gate: std::sync::Arc<std::sync::Mutex<std::sync::mpsc::Receiver<()>>>| {
            move || {
                let _ = gate.lock().unwrap().recv();
                Ok(Extraction::default())
            }
        };
        let grace = Duration::from_millis(20);
        let quick = |text: &'static [u8]| move || extract_bytes("txt", text);
        let mut abandoned = 0;
        while abandoned < MAX_ABANDONED_THREADS {
            assert_eq!(
                run_guarded_with_grace(stuck(gate.clone()), Duration::from_millis(10), grace)
                    .unwrap_err(),
                GuardFailure::TimedOut
            );
            std::thread::sleep(grace * 3);
            abandoned += 1;
            if abandoned < MAX_ABANDONED_THREADS {
                // The stuck thread is past its budget and grace, so it no longer holds a working
                // slot: a fresh file is still extracted.
                let ok = run_guarded_with_grace(quick(b"fresh"), Duration::from_secs(5), grace).unwrap();
                assert_eq!(ok.sections[0].1, "fresh");
                assert_eq!(ABANDONED_THREADS.load(Ordering::SeqCst), abandoned);
                assert_eq!(EXTRACTION_THREADS.load(Ordering::SeqCst), 0);
            }
        }
        // With the abandoned cap reached, new work is refused with a retry-later state and no
        // new thread is started.
        assert_eq!(
            run_guarded_with_grace(quick(b"x"), Duration::from_secs(5), grace).unwrap_err(),
            GuardFailure::Stalled
        );
        assert_eq!(ABANDONED_THREADS.load(Ordering::SeqCst), MAX_ABANDONED_THREADS);
        drop(release); // the parked threads return and give their places back
        let started = std::time::Instant::now();
        while ABANDONED_THREADS.load(Ordering::SeqCst) > 0
            || EXTRACTION_THREADS.load(Ordering::SeqCst) > 0
        {
            assert!(started.elapsed() < Duration::from_secs(10));
            std::thread::sleep(Duration::from_millis(5));
        }
        let ok = run_guarded_with_grace(quick(b"again"), Duration::from_secs(5), grace).unwrap();
        assert_eq!(ok.sections[0].1, "again");
    }

    #[test]
    fn a_pdf_is_extracted_page_by_page_on_a_background_thread() {
        let _serial = guarded_serial();
        let out = extract_guarded("pdf", pdf_with_pages(2, "Budget owner"), EXTRACTION_TIMEOUT)
            .unwrap();
        let names: Vec<&str> = out.sections.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["page:1", "page:2"]);
        assert!(out.sections[0].1.contains("Budget owner"), "{:?}", out.sections);
    }

    #[test]
    fn pdf_pages_stop_once_the_character_budget_is_spent() {
        let limits = Limits { chars: 25, ..LIMITS };
        let out = extract_bytes_with("pdf", &pdf_with_pages(50, "0123456789"), limits).unwrap();
        assert!(out.truncated);
        assert!(out.sections.len() < 5, "{:?}", out.sections);
    }

    #[test]
    fn a_pdf_with_too_many_pages_is_refused_before_decoding_pages() {
        let at_cap = extract_bytes("pdf", &pdf_with_pages(MAX_PDF_PAGES, "x")).unwrap();
        assert_eq!(at_cap.sections.len(), MAX_PDF_PAGES);
        let over = extract_bytes("pdf", &pdf_with_pages(MAX_PDF_PAGES + 1, "x"));
        assert_eq!(over.unwrap_err().to_string(), "sourceTooLarge");
    }

    #[test]
    fn a_pdf_over_the_size_cap_is_refused_before_parsing() {
        let mut pdf = pdf_with_pages(1, "x");
        pdf.resize(MAX_SOURCE_BYTES as usize + 1, b' ');
        assert_eq!(extract_bytes("pdf", &pdf).unwrap_err().to_string(), "sourceTooLarge");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn extraction_threads_run_at_utility_quality_of_service() {
        extern "C" {
            fn pthread_get_qos_class_np(
                thread: libc::pthread_t,
                class: *mut u32,
                priority: *mut libc::c_int,
            ) -> libc::c_int;
        }
        let class = std::thread::spawn(|| {
            lower_thread_priority().unwrap();
            let (mut class, mut priority) = (0u32, 0);
            // SAFETY: both out-pointers are valid for the duration of the call.
            let rc = unsafe {
                pthread_get_qos_class_np(libc::pthread_self(), &mut class, &mut priority)
            };
            assert_eq!(rc, 0);
            class
        })
        .join()
        .unwrap();
        assert_eq!(class, libc::qos_class_t::QOS_CLASS_UTILITY as u32);
    }

    #[test]
    fn read_limited_accepts_exactly_the_limit() {
        let mut budget = 10;
        assert_eq!(read_limited(&b"0123456789"[..], 10, &mut budget, "x").unwrap().len(), 10);
        assert_eq!(budget, 0);
        let mut budget = 10;
        assert!(read_limited(&b"0123456789A"[..], 10, &mut budget, "x").is_err());
    }
}
