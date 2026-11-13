use crate::win::util::OwnedHandle;
use serde::Serialize;
use windows_sys::Win32::Foundation::{FILETIME, STILL_ACTIVE};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, GetProcessTimes, OpenProcess, QueryFullProcessImageNameW,
    PROCESS_QUERY_LIMITED_INFORMATION,
};

#[derive(Debug, Serialize)]
pub struct InspectResult {
    pub pid: u32,
    pub alive: bool,
    #[serde(rename = "creationTime", skip_serializing_if = "Option::is_none")]
    pub creation_time: Option<String>,
    #[serde(rename = "imagePath", skip_serializing_if = "Option::is_none")]
    pub image_path: Option<String>,
}

pub fn inspect_process(pid: u32) -> InspectResult {
    let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    let handle = OwnedHandle(raw);
    if !handle.is_valid() {
        return InspectResult {
            pid,
            alive: false,
            creation_time: None,
            image_path: None,
        };
    }

    let mut exit_code = 0u32;
    let exit_ok = unsafe { GetExitCodeProcess(handle.0, &mut exit_code) };
    if exit_ok == 0 || exit_code != STILL_ACTIVE as u32 {
        return InspectResult {
            pid,
            alive: false,
            creation_time: None,
            image_path: None,
        };
    }

    let mut creation = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut exit_ft = creation;
    let mut kernel_ft = creation;
    let mut user_ft = creation;
    let creation_time = unsafe {
        if GetProcessTimes(
            handle.0,
            &mut creation,
            &mut exit_ft,
            &mut kernel_ft,
            &mut user_ft,
        ) != 0
        {
            let ticks = ((creation.dwHighDateTime as u64) << 32) | (creation.dwLowDateTime as u64);
            Some(ticks.to_string())
        } else {
            None
        }
    };

    let mut buf = vec![0u16; 1024];
    let mut size = buf.len() as u32;
    let image_path = unsafe {
        if QueryFullProcessImageNameW(handle.0, 0, buf.as_mut_ptr(), &mut size) != 0 {
            Some(String::from_utf16_lossy(&buf[..size as usize]))
        } else {
            None
        }
    };

    InspectResult {
        pid,
        alive: true,
        creation_time,
        image_path,
    }
}
