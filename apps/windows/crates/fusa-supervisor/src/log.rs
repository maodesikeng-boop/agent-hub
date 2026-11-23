use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const ROTATE_LOCK_RETRY_STEP_BYTES: u64 = 64 * 1024;

pub struct RotatingLogWriter {
    log_path: PathBuf,
    max_bytes: u64,
    rotated_files: usize,
    file: Option<File>,
    current_bytes: u64,
    next_rotate_retry_bytes: u64,
}

impl RotatingLogWriter {
    pub fn open(
        log_path: impl Into<PathBuf>,
        max_bytes: u64,
        rotated_files: usize,
    ) -> std::io::Result<Self> {
        let log_path = log_path.into();
        if let Some(parent) = log_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let existing_len = fs::metadata(&log_path).map(|m| m.len()).unwrap_or(0);
        let mut writer = Self {
            log_path,
            max_bytes: max_bytes.max(1),
            rotated_files,
            file: None,
            current_bytes: existing_len,
            next_rotate_retry_bytes: 0,
        };
        if writer.current_bytes >= writer.max_bytes {
            writer.rotate()?;
        } else {
            writer.ensure_open()?;
        }
        Ok(writer)
    }

    pub fn log_path(&self) -> &Path {
        &self.log_path
    }

    pub fn rotated_path(&self, index: usize) -> PathBuf {
        let mut os = self.log_path.as_os_str().to_os_string();
        os.push(format!(".{index}"));
        PathBuf::from(os)
    }

    pub fn write_chunk(&mut self, mut data: &[u8]) -> std::io::Result<()> {
        while !data.is_empty() {
            let rotate_threshold = self.max_bytes.max(self.next_rotate_retry_bytes);
            if self.current_bytes >= rotate_threshold {
                self.rotate()?;
            }
            self.ensure_open()?;
            let active_limit = self.max_bytes.max(self.next_rotate_retry_bytes);
            let room = active_limit.saturating_sub(self.current_bytes).max(1) as usize;
            let take = data.len().min(room);
            if let Some(f) = self.file.as_mut() {
                f.write_all(&data[..take])?;
                f.flush()?;
            }
            self.current_bytes += take as u64;
            data = &data[take..];
        }
        Ok(())
    }

    pub fn write_line(&mut self, line: &str) -> std::io::Result<()> {
        self.write_chunk(line.as_bytes())?;
        if !line.ends_with('\n') {
            self.write_chunk(b"\n")?;
        }
        Ok(())
    }

    fn ensure_open(&mut self) -> std::io::Result<()> {
        if self.file.is_none() {
            let f = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.log_path)?;
            self.current_bytes = f.metadata().map(|m| m.len()).unwrap_or(0);
            self.file = Some(f);
        }
        Ok(())
    }

    fn rotate(&mut self) -> std::io::Result<()> {
        if let Some(mut f) = self.file.take() {
            let _ = f.flush();
        }
        let mut rename_failed = false;
        if self.rotated_files == 0 {
            if self.log_path.exists() && fs::remove_file(&self.log_path).is_err() {
                rename_failed = true;
            }
        } else if self.log_path.exists() {
            for idx in (1..self.rotated_files).rev() {
                let src = self.rotated_path(idx);
                let dst = self.rotated_path(idx + 1);
                if src.exists() {
                    let _ = fs::remove_file(&dst);
                    let _ = fs::rename(&src, &dst);
                }
            }
            let first_backup = self.rotated_path(1);
            let _ = fs::remove_file(&first_backup);
            if fs::rename(&self.log_path, &first_backup).is_err() {
                rename_failed = true;
            }
        }

        if let Ok(fresh) = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&self.log_path)
        {
            self.file = Some(fresh);
            self.current_bytes = 0;
            self.next_rotate_retry_bytes = 0;
            return Ok(());
        }

        // External viewers such as Notepad can lock the file; keep appending and retry rotation later instead of breaking the stdout pipe.
        let append_fallback = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log_path)?;
        let len = append_fallback
            .metadata()
            .map(|m| m.len())
            .unwrap_or(self.current_bytes);
        self.current_bytes = len;
        self.next_rotate_retry_bytes = if rename_failed {
            len.saturating_add(ROTATE_LOCK_RETRY_STEP_BYTES)
        } else {
            0
        };
        self.file = Some(append_fallback);
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct StderrTailCollector {
    max_bytes: usize,
    summary_max_lines: usize,
    menu_reason_max_chars: usize,
    buf: Vec<u8>,
}

impl StderrTailCollector {
    pub fn new(max_bytes: usize, summary_max_lines: usize, menu_reason_max_chars: usize) -> Self {
        Self {
            max_bytes: max_bytes.max(1),
            summary_max_lines: summary_max_lines.max(1),
            menu_reason_max_chars: menu_reason_max_chars.max(1),
            buf: Vec::with_capacity(max_bytes.min(4096)),
        }
    }

    pub fn from_contract(contract: &crate::contract::DesktopContract) -> Self {
        Self::new(
            contract.stderr_tail_max_bytes,
            contract.stderr_summary_max_lines,
            contract.menu_reason_max_chars,
        )
    }

    pub fn clear(&mut self) {
        self.buf.clear();
    }

    pub fn byte_len(&self) -> usize {
        self.buf.len()
    }

    pub fn append(&mut self, chunk: &[u8]) {
        if chunk.is_empty() {
            return;
        }
        if chunk.len() >= self.max_bytes {
            self.buf.clear();
            self.buf
                .extend_from_slice(&chunk[chunk.len() - self.max_bytes..]);
            return;
        }
        let total = self.buf.len() + chunk.len();
        if total > self.max_bytes {
            let drop_count = total - self.max_bytes;
            self.buf.drain(..drop_count);
        }
        self.buf.extend_from_slice(chunk);
    }

    pub fn tail_text(&self) -> String {
        let mut slice = self.buf.as_slice();
        while let Some(&first) = slice.first() {
            if (first & 0b1100_0000) == 0b1000_0000 {
                slice = &slice[1..];
            } else {
                break;
            }
        }
        String::from_utf8_lossy(slice).into_owned()
    }

    pub fn summary_lines(&self) -> Vec<String> {
        let text = self.tail_text();
        let non_empty: Vec<String> = text
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(ToOwned::to_owned)
            .collect();
        let skip = non_empty.len().saturating_sub(self.summary_max_lines);
        non_empty.into_iter().skip(skip).collect()
    }

    pub fn format_menu_crash_reason(&self, fallback_exit_desc: &str) -> String {
        let lines = self.summary_lines();
        let raw = lines
            .last()
            .map(String::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or(fallback_exit_desc);
        truncate_chars_clean(raw, self.menu_reason_max_chars)
    }
}

pub fn truncate_chars_clean(input: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }
    let collapsed: String = input.split_whitespace().collect::<Vec<_>>().join(" ");
    let char_count = collapsed.chars().count();
    if char_count <= max_chars {
        return collapsed;
    }
    if max_chars == 1 {
        return "…".to_string();
    }
    let mut out: String = collapsed.chars().take(max_chars - 1).collect();
    out.push('…');
    out
}
