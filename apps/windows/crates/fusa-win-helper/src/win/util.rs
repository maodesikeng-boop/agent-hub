use std::ffi::{c_void, OsStr};
use std::io;
use std::os::windows::ffi::OsStrExt;
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, HANDLE, HLOCAL, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSidToSidW,
};

pub fn to_wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value
        .as_ref()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

pub fn last_os_error(context: &str) -> io::Error {
    let code = unsafe { GetLastError() };
    io::Error::new(
        io::Error::from_raw_os_error(code as i32).kind(),
        format!("{context} (win32 error {code})"),
    )
}

pub fn win32_code_error(context: &str, code: u32) -> io::Error {
    io::Error::new(
        io::Error::from_raw_os_error(code as i32).kind(),
        format!("{context} (win32 error {code})"),
    )
}

pub struct OwnedHandle(pub HANDLE);

impl OwnedHandle {
    pub fn is_valid(&self) -> bool {
        !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if self.is_valid() {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

pub struct LocalSid {
    psid: *mut c_void,
}

impl LocalSid {
    pub fn from_string(sid: &str) -> io::Result<Self> {
        let wide = to_wide(sid);
        let mut psid: *mut c_void = std::ptr::null_mut();
        let ok = unsafe { ConvertStringSidToSidW(wide.as_ptr(), &mut psid) };
        if ok == 0 || psid.is_null() {
            return Err(last_os_error(&format!("ConvertStringSidToSidW({sid})")));
        }
        Ok(Self { psid })
    }

    pub fn as_ptr(&self) -> *mut c_void {
        self.psid
    }
}

impl Drop for LocalSid {
    fn drop(&mut self) {
        if !self.psid.is_null() {
            unsafe {
                LocalFree(self.psid as HLOCAL);
            }
        }
    }
}

pub unsafe fn sid_to_string(psid: *mut c_void) -> Option<String> {
    if psid.is_null() {
        return None;
    }
    let mut str_ptr: *mut u16 = std::ptr::null_mut();
    let ok = unsafe { ConvertSidToStringSidW(psid, &mut str_ptr) };
    if ok == 0 || str_ptr.is_null() {
        return None;
    }
    let mut len = 0usize;
    unsafe {
        while *str_ptr.add(len) != 0 {
            len += 1;
        }
        let slice = std::slice::from_raw_parts(str_ptr, len);
        let out = String::from_utf16_lossy(slice);
        LocalFree(str_ptr as HLOCAL);
        Some(out)
    }
}
