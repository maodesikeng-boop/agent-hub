use crate::win::util::{last_os_error, OwnedHandle};
use std::io;
use windows_sys::Win32::System::Power::{
    SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, WaitForSingleObject, INFINITE, PROCESS_SYNCHRONIZE,
};

pub fn keep_awake_until_parent_exits(parent_pid: u32) -> io::Result<()> {
    let raw = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, parent_pid) };
    let parent = OwnedHandle(raw);
    if !parent.is_valid() {
        return Ok(());
    }
    let prev = unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
    if prev == 0 {
        return Err(last_os_error("SetThreadExecutionState"));
    }
    unsafe {
        let _ = WaitForSingleObject(parent.0, INFINITE);
        let _ = SetThreadExecutionState(ES_CONTINUOUS);
    }
    Ok(())
}
