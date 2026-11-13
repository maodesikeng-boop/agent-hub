use crate::win::util::{last_os_error, to_wide};
use std::fs::{File, OpenOptions};
use std::io;
use std::os::windows::fs::OpenOptionsExt;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::ERROR_PIPE_BUSY;
use windows_sys::Win32::System::Pipes::WaitNamedPipeW;

/// Connects to a Windows Named Pipe (`\\.\pipe\...`), waiting on `ERROR_PIPE_BUSY` up to `timeout`.
pub fn connect_named_pipe(pipe_path: &str, timeout: Duration) -> io::Result<File> {
    let deadline = Instant::now() + timeout;
    let wide = to_wide(pipe_path);
    loop {
        match OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(0)
            .open(pipe_path)
        {
            Ok(file) => return Ok(file),
            Err(err) => {
                if err.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) {
                    let now = Instant::now();
                    if now >= deadline {
                        return Err(err);
                    }
                    let rem_ms = deadline
                        .saturating_duration_since(now)
                        .as_millis()
                        .min(1_000) as u32;
                    let waited = unsafe { WaitNamedPipeW(wide.as_ptr(), rem_ms.max(25)) };
                    if waited == 0 && Instant::now() >= deadline {
                        return Err(last_os_error("WaitNamedPipeW"));
                    }
                    continue;
                }
                return Err(err);
            }
        }
    }
}
