use crate::win::util::{last_os_error, to_wide, OwnedHandle};
use std::io::{self, Read, Write};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
    ERROR_BROKEN_PIPE, ERROR_IO_PENDING, ERROR_PIPE_BUSY, GENERIC_READ, GENERIC_WRITE,
    INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_FLAG_OVERLAPPED, OPEN_EXISTING,
};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::System::Pipes::WaitNamedPipeW;
use windows_sys::Win32::System::Threading::{
    CreateEventW, ResetEvent, WaitForSingleObject,
};

/// Duplex Windows Named Pipe client stream with a hard overall deadline (`HUB_CLI_TIMEOUT_MS`).
/// Uses `FILE_FLAG_OVERLAPPED` + `CancelIoEx` + blocking `GetOverlappedResult` drain on timeout
/// so a hung peer can never wedge `hub.exe` indefinitely and stack `OVERLAPPED` pointers never dangle.
pub struct TimedPipeStream {
    pipe: OwnedHandle,
    event: OwnedHandle,
    deadline: Instant,
}

impl TimedPipeStream {
    fn remaining_ms(&self) -> io::Result<u32> {
        let now = Instant::now();
        if now >= self.deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "named pipe I/O timed out",
            ));
        }
        let ms = self
            .deadline
            .saturating_duration_since(now)
            .as_millis()
            .min(u32::MAX as u128) as u32;
        Ok(ms.max(1))
    }
}

impl Read for TimedPipeStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let wait_ms = self.remaining_ms()?;
        unsafe {
            let _ = ResetEvent(self.event.0);
        }
        let mut ov: OVERLAPPED = unsafe { std::mem::zeroed() };
        ov.hEvent = self.event.0;
        let mut transferred = 0u32;
        let chunk_len = buf.len().min(64 * 1024) as u32;
        let ok = unsafe {
            ReadFile(
                self.pipe.0,
                buf.as_mut_ptr(),
                chunk_len,
                &mut transferred,
                &mut ov,
            )
        };
        if ok != 0 {
            return Ok(transferred as usize);
        }
        let err = io::Error::last_os_error();
        match err.raw_os_error().map(|c| c as u32) {
            Some(ERROR_BROKEN_PIPE) => return Ok(0),
            Some(ERROR_IO_PENDING) => {}
            _ => return Err(err),
        }

        let wait_rc = unsafe { WaitForSingleObject(self.event.0, wait_ms) };
        if wait_rc == WAIT_TIMEOUT {
            unsafe {
                let _ = CancelIoEx(self.pipe.0, &ov);
                let _ = GetOverlappedResult(self.pipe.0, &ov, &mut transferred, 1);
            }
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "named pipe read timed out",
            ));
        }
        if wait_rc != WAIT_OBJECT_0 {
            unsafe {
                let _ = CancelIoEx(self.pipe.0, &ov);
                let _ = GetOverlappedResult(self.pipe.0, &ov, &mut transferred, 1);
            }
            return Err(last_os_error("WaitForSingleObject(pipe read)"));
        }

        let done_ok = unsafe { GetOverlappedResult(self.pipe.0, &ov, &mut transferred, 0) };
        if done_ok == 0 {
            let done_err = io::Error::last_os_error();
            if done_err.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
                return Ok(0);
            }
            return Err(done_err);
        }
        Ok(transferred as usize)
    }
}

impl Write for TimedPipeStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let wait_ms = self.remaining_ms()?;
        unsafe {
            let _ = ResetEvent(self.event.0);
        }
        let mut ov: OVERLAPPED = unsafe { std::mem::zeroed() };
        ov.hEvent = self.event.0;
        let mut transferred = 0u32;
        let chunk_len = buf.len().min(64 * 1024) as u32;
        let ok = unsafe {
            WriteFile(
                self.pipe.0,
                buf.as_ptr(),
                chunk_len,
                &mut transferred,
                &mut ov,
            )
        };
        if ok != 0 {
            return Ok(transferred as usize);
        }
        let err = io::Error::last_os_error();
        if err.raw_os_error() != Some(ERROR_IO_PENDING as i32) {
            return Err(err);
        }

        let wait_rc = unsafe { WaitForSingleObject(self.event.0, wait_ms) };
        if wait_rc == WAIT_TIMEOUT {
            unsafe {
                let _ = CancelIoEx(self.pipe.0, &ov);
                let _ = GetOverlappedResult(self.pipe.0, &ov, &mut transferred, 1);
            }
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "named pipe write timed out",
            ));
        }
        if wait_rc != WAIT_OBJECT_0 {
            unsafe {
                let _ = CancelIoEx(self.pipe.0, &ov);
                let _ = GetOverlappedResult(self.pipe.0, &ov, &mut transferred, 1);
            }
            return Err(last_os_error("WaitForSingleObject(pipe write)"));
        }

        let done_ok = unsafe { GetOverlappedResult(self.pipe.0, &ov, &mut transferred, 0) };
        if done_ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(transferred as usize)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Connects to a Windows Named Pipe (`\\.\pipe\...`), waiting on `ERROR_PIPE_BUSY` up to `connect_timeout`
/// and bounding subsequent HTTP request/response I/O to `io_timeout`.
pub fn connect_named_pipe(
    pipe_path: &str,
    connect_timeout: Duration,
    io_timeout: Duration,
) -> io::Result<TimedPipeStream> {
    let connect_deadline = Instant::now() + connect_timeout;
    let wide = to_wide(pipe_path);
    let pipe = loop {
        let raw = unsafe {
            CreateFileW(
                wide.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED,
                std::ptr::null_mut(),
            )
        };
        if !raw.is_null() && raw != INVALID_HANDLE_VALUE {
            break OwnedHandle(raw);
        }
        let err = io::Error::last_os_error();
        if err.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) {
            let now = Instant::now();
            if now >= connect_deadline {
                return Err(err);
            }
            let rem_ms = connect_deadline
                .saturating_duration_since(now)
                .as_millis()
                .min(1_000) as u32;
            let waited = unsafe { WaitNamedPipeW(wide.as_ptr(), rem_ms.max(25)) };
            if waited == 0 && Instant::now() >= connect_deadline {
                return Err(last_os_error("WaitNamedPipeW"));
            }
            continue;
        }
        return Err(err);
    };

    let raw_event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
    let event = OwnedHandle(raw_event);
    if !event.is_valid() {
        return Err(last_os_error("CreateEventW(pipe)"));
    }

    Ok(TimedPipeStream {
        pipe,
        event,
        deadline: Instant::now() + io_timeout,
    })
}
