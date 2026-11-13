use crate::win::util::{to_wide, win32_code_error};
use serde::Serialize;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use windows_sys::Win32::Foundation::{ERROR_MORE_DATA, ERROR_SUCCESS};
use windows_sys::Win32::System::RestartManager::{
    RmEndSession, RmGetList, RmRegisterResources, RmStartSession, CCH_RM_SESSION_KEY,
    RM_PROCESS_INFO,
};

const MAX_REGISTERED_FILES: usize = 64;

#[derive(Debug, Serialize)]
pub struct LockHolder {
    pub pid: u32,
    #[serde(rename = "appName")]
    pub app_name: String,
    #[serde(rename = "serviceShortName")]
    pub service_short_name: String,
    #[serde(rename = "applicationType")]
    pub application_type: i32,
}

#[derive(Debug, Serialize)]
pub struct WhoLocksResult {
    pub path: String,
    pub holders: Vec<LockHolder>,
}

fn collect_candidate_files(root: &Path, out: &mut Vec<PathBuf>) {
    if out.len() >= MAX_REGISTERED_FILES {
        return;
    }
    if root.is_file() {
        out.push(root.to_path_buf());
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_REGISTERED_FILES {
            break;
        }
        let p = entry.path();
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_symlink() {
            continue;
        }
        if ft.is_file() {
            out.push(p);
        } else if ft.is_dir() {
            collect_candidate_files(&p, out);
        }
    }
}

fn wide_array_to_string(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

pub fn query_who_locks(target: &Path) -> io::Result<WhoLocksResult> {
    let mut files = Vec::new();
    collect_candidate_files(target, &mut files);
    if files.is_empty() {
        files.push(target.to_path_buf());
    }

    let mut session_handle = 0u32;
    let mut session_key = [0u16; (CCH_RM_SESSION_KEY as usize) + 1];
    let start_code = unsafe { RmStartSession(&mut session_handle, 0, session_key.as_mut_ptr()) };
    if start_code != ERROR_SUCCESS {
        return Err(win32_code_error("RmStartSession", start_code));
    }

    struct RmGuard(u32);
    impl Drop for RmGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = RmEndSession(self.0);
            }
        }
    }
    let _guard = RmGuard(session_handle);

    let wide_files: Vec<Vec<u16>> = files.iter().map(to_wide).collect();
    let file_ptrs: Vec<*const u16> = wide_files.iter().map(|w| w.as_ptr()).collect();
    let reg_code = unsafe {
        RmRegisterResources(
            session_handle,
            file_ptrs.len() as u32,
            file_ptrs.as_ptr(),
            0,
            std::ptr::null(),
            0,
            std::ptr::null(),
        )
    };
    if reg_code != ERROR_SUCCESS {
        return Err(win32_code_error("RmRegisterResources", reg_code));
    }

    let mut needed = 0u32;
    let mut count = 0u32;
    let mut reboot_reasons = 0u32;
    let first_code = unsafe {
        RmGetList(
            session_handle,
            &mut needed,
            &mut count,
            std::ptr::null_mut(),
            &mut reboot_reasons,
        )
    };
    if first_code == ERROR_SUCCESS && needed == 0 {
        return Ok(WhoLocksResult {
            path: target.display().to_string(),
            holders: Vec::new(),
        });
    }
    if first_code != ERROR_MORE_DATA && first_code != ERROR_SUCCESS {
        return Err(win32_code_error("RmGetList(probe)", first_code));
    }

    let cap = needed.max(8);
    let mut infos: Vec<RM_PROCESS_INFO> = (0..cap).map(|_| unsafe { std::mem::zeroed() }).collect();
    count = cap;
    let list_code = unsafe {
        RmGetList(
            session_handle,
            &mut needed,
            &mut count,
            infos.as_mut_ptr(),
            &mut reboot_reasons,
        )
    };
    if list_code != ERROR_SUCCESS {
        return Err(win32_code_error("RmGetList(read)", list_code));
    }

    let holders = infos[..count as usize]
        .iter()
        .map(|info| LockHolder {
            pid: info.Process.dwProcessId,
            app_name: wide_array_to_string(&info.strAppName),
            service_short_name: wide_array_to_string(&info.strServiceShortName),
            application_type: info.ApplicationType,
        })
        .collect();

    Ok(WhoLocksResult {
        path: target.display().to_string(),
        holders,
    })
}
