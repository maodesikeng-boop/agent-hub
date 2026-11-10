use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

/// 严格遵循 `contract.json`（`logMaxBytes: 2 MiB` + `logRotatedFiles: 1`）的流式轮转日志写入器。
/// 单次超大块写入也会按剩余字节精确切分并轮转，确保主日志与 `.1` 备份任何时刻均不超过 `max_bytes`，且绝不生成 `.2`。
pub struct RotatingLogWriter {
    log_path: PathBuf,
    max_bytes: u64,
    rotated_files: usize,
    file: Option<File>,
    current_bytes: u64,
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
            if self.current_bytes >= self.max_bytes {
                self.rotate()?;
            }
            self.ensure_open()?;
            let room = (self.max_bytes - self.current_bytes) as usize;
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
        if self.rotated_files == 0 {
            let _ = fs::remove_file(&self.log_path);
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
            fs::rename(&self.log_path, &first_backup)?;
        }
        let fresh = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&self.log_path)?;
        self.file = Some(fresh);
        self.current_bytes = 0;
        Ok(())
    }
}

/// 严格受 `stderrTailMaxBytes`（4 KiB）与 `stderrSummaryMaxLines`（8 行）上限约束的 stderr 尾缓冲收集器。
/// 长期运行一个月也恒定最多占用 4 KiB 内存。
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

    /// 解码当前尾缓冲文本（跳过前端因按字节截断产生的半截 UTF-8 续字节）。
    pub fn tail_text(&self) -> String {
        let mut slice = self.buf.as_slice();
        while let Some(&first) = slice.first() {
            // UTF-8 续字节形如 10xxxxxx
            if (first & 0b1100_0000) == 0b1000_0000 {
                slice = &slice[1..];
            } else {
                break;
            }
        }
        String::from_utf8_lossy(slice).into_owned()
    }

    /// 提取最后最多 `summary_max_lines`（8）条非空 stderr 摘要行。
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

    /// 构造托盘菜单展示的单行崩溃原因摘要，字符数严格 `<= menu_reason_max_chars`（60 字）。
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

/// 将任意多行或多余空白折叠为单行，并按 Unicode 字符数上限截断（含省略号 `…` 总长不超过 `max_chars`）。
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
