use crate::sids::{ensure_reader_sid, ensure_worker_sid, load_or_create_sid_store};
use crate::win::token::current_user_sid_bytes;
use crate::win::util::{to_wide, win32_code_error, LocalSid, OwnedHandle};
use std::ffi::c_void;
use std::fs;
use std::io;
use std::path::Path;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
    ERROR_PIPE_BUSY, ERROR_SUCCESS, GENERIC_ALL, HLOCAL, INVALID_HANDLE_VALUE, LocalFree,
};
use windows_sys::Win32::Security::Authorization::{
    GetNamedSecurityInfoW, GetSecurityInfo, SetEntriesInAclW, SetNamedSecurityInfoW,
    SetSecurityInfo, DENY_ACCESS, EXPLICIT_ACCESS_W, GRANT_ACCESS, SE_FILE_OBJECT,
    SE_KERNEL_OBJECT, SET_ACCESS, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
};
use windows_sys::Win32::Security::{
    DeleteAce, EqualSid, GetAce, GetSecurityDescriptorControl, ACCESS_ALLOWED_ACE,
    ACCESS_DENIED_ACE, ACE_HEADER, ACL, CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION,
    INHERITED_ACE, OBJECT_INHERIT_ACE, PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
    SE_DACL_PROTECTED,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, DELETE, FILE_APPEND_DATA, FILE_ATTRIBUTE_NORMAL, FILE_DELETE_CHILD,
    FILE_EXECUTE, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_READ_DATA,
    FILE_READ_EA, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_WRITE_ATTRIBUTES, FILE_WRITE_DATA,
    FILE_WRITE_EA, OPEN_EXISTING, READ_CONTROL, SYNCHRONIZE, WRITE_DAC, WRITE_OWNER,
};
use windows_sys::Win32::System::Pipes::WaitNamedPipeW;
use windows_sys::Win32::System::SystemServices::{
    ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE,
};

const INHERIT_CI_OI: u32 = CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE;

// Specific write rights only: FILE_GENERIC_WRITE also carries READ_CONTROL | SYNCHRONIZE, which would block reads under a restricted token.
pub const WORKER_DENY_WRITE_MASK: u32 = FILE_WRITE_DATA
    | FILE_APPEND_DATA
    | FILE_WRITE_EA
    | FILE_WRITE_ATTRIBUTES
    | DELETE
    | FILE_DELETE_CHILD
    | WRITE_DAC
    | WRITE_OWNER;

pub const WORKER_ALLOW_MODIFY_MASK: u32 = FILE_GENERIC_READ
    | FILE_GENERIC_WRITE
    | FILE_GENERIC_EXECUTE
    | DELETE
    | FILE_DELETE_CHILD;

// Attributes stay readable because tools stat parent paths for config files; traversal is bypassed by SeChangeNotifyPrivilege.
pub const WORKER_DENY_READ_MASK: u32 = FILE_READ_DATA | FILE_READ_EA | FILE_EXECUTE;

pub const WORKER_ALLOW_READ_MASK: u32 = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;

const WORKER_DENY_ANY_MASK: u32 = WORKER_DENY_WRITE_MASK | WORKER_DENY_READ_MASK;

const CHECK_DENY_BITS: u32 =
    FILE_WRITE_DATA | FILE_APPEND_DATA | DELETE | FILE_DELETE_CHILD | WRITE_DAC | WRITE_OWNER;
const CHECK_DENY_READ_BITS: u32 = FILE_READ_DATA | FILE_EXECUTE;
const CHECK_ALLOW_READ_BITS: u32 = FILE_READ_DATA | FILE_EXECUTE;
const CHECK_ALLOW_BITS: u32 =
    FILE_WRITE_DATA | FILE_APPEND_DATA | DELETE | FILE_DELETE_CHILD;

unsafe fn dacl_has_ace(
    dacl: *const ACL,
    target_sid: *mut c_void,
    ace_type: u8,
    required_flags: u8,
    required_mask: u32,
    exact_mask: bool,
) -> bool {
    if dacl.is_null() || target_sid.is_null() {
        return false;
    }
    let count = unsafe { (*dacl).AceCount as u32 };
    for idx in 0..count {
        let mut raw_ace: *mut c_void = std::ptr::null_mut();
        if unsafe { GetAce(dacl, idx, &mut raw_ace) } == 0 || raw_ace.is_null() {
            continue;
        }
        let header = unsafe { &*(raw_ace as *const ACE_HEADER) };
        if header.AceType != ace_type {
            continue;
        }
        if (header.AceFlags & required_flags) != required_flags {
            continue;
        }
        let (mask, sid_ptr) = if ace_type == ACCESS_DENIED_ACE_TYPE as u8 {
            let ace = unsafe { &*(raw_ace as *const ACCESS_DENIED_ACE) };
            (ace.Mask, &ace.SidStart as *const u32 as *mut c_void)
        } else if ace_type == ACCESS_ALLOWED_ACE_TYPE as u8 {
            let ace = unsafe { &*(raw_ace as *const ACCESS_ALLOWED_ACE) };
            (ace.Mask, &ace.SidStart as *const u32 as *mut c_void)
        } else {
            continue;
        };
        if unsafe { EqualSid(sid_ptr, target_sid) } == 0 {
            continue;
        }
        if exact_mask {
            if mask == required_mask {
                return true;
            }
        } else if (mask & required_mask) == required_mask {
            return true;
        }
    }
    false
}

// Older builds denied FILE_GENERIC_WRITE | GENERIC_WRITE; narrow those ACEs in place and return the bits to deny again.
unsafe fn take_overbroad_denies(dacl: *mut ACL, sid: *mut c_void) -> Option<u32> {
    if dacl.is_null() || sid.is_null() {
        return None;
    }
    let mut kept: Option<u32> = None;
    let count = unsafe { (*dacl).AceCount as u32 };
    for idx in (0..count).rev() {
        let mut raw_ace: *mut c_void = std::ptr::null_mut();
        if unsafe { GetAce(dacl, idx, &mut raw_ace) } == 0 || raw_ace.is_null() {
            continue;
        }
        let header = unsafe { &*(raw_ace as *const ACE_HEADER) };
        if header.AceType != ACCESS_DENIED_ACE_TYPE as u8
            || (header.AceFlags & INHERITED_ACE as u8) != 0
        {
            continue;
        }
        let ace = unsafe { &*(raw_ace as *const ACCESS_DENIED_ACE) };
        let mask = ace.Mask;
        if mask & !WORKER_DENY_ANY_MASK == 0
            || unsafe { EqualSid(&ace.SidStart as *const u32 as *mut c_void, sid) } == 0
        {
            continue;
        }
        if unsafe { DeleteAce(dacl, idx) } != 0 {
            kept = Some(kept.unwrap_or(0) | (mask & WORKER_DENY_ANY_MASK));
        }
    }
    kept
}

fn make_explicit_access(
    sid: *mut c_void,
    mode: i32,
    permissions: u32,
    inheritance: u32,
) -> EXPLICIT_ACCESS_W {
    EXPLICIT_ACCESS_W {
        grfAccessPermissions: permissions,
        grfAccessMode: mode,
        grfInheritance: inheritance,
        Trustee: TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: 0,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_UNKNOWN,
            ptstrName: sid as *mut u16,
        },
    }
}

fn read_named_dacl(path: &Path) -> io::Result<(*mut ACL, PSECURITY_DESCRIPTOR)> {
    let wide = to_wide(path);
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    let code = unsafe {
        GetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut sd,
        )
    };
    if code != ERROR_SUCCESS {
        return Err(win32_code_error(
            &format!("GetNamedSecurityInfoW({})", path.display()),
            code,
        ));
    }
    Ok((dacl, sd))
}

pub fn protect_root(state_dir: &Path, root_path: &Path) -> io::Result<bool> {
    fs::create_dir_all(root_path)?;
    let store = load_or_create_sid_store(state_dir)?;
    let worker_group = LocalSid::from_string(&store.worker_group_sid)?;
    let owner_rights = LocalSid::from_string("S-1-3-4")?;

    let (dacl, sd) = read_named_dacl(root_path)?;
    let legacy = unsafe { take_overbroad_denies(dacl, worker_group.as_ptr()) };
    let already_ok = legacy.is_none()
        && unsafe {
            dacl_has_ace(
                dacl,
                worker_group.as_ptr(),
                ACCESS_DENIED_ACE_TYPE as u8,
                INHERIT_CI_OI as u8,
                CHECK_DENY_BITS,
                false,
            ) && dacl_has_ace(
                dacl,
                owner_rights.as_ptr(),
                ACCESS_ALLOWED_ACE_TYPE as u8,
                INHERIT_CI_OI as u8,
                READ_CONTROL,
                true,
            )
        };
    if already_ok {
        if !sd.is_null() {
            unsafe {
                LocalFree(sd as HLOCAL);
            }
        }
        return Ok(false);
    }

    let entries = [
        make_explicit_access(
            worker_group.as_ptr(),
            DENY_ACCESS,
            WORKER_DENY_WRITE_MASK | legacy.unwrap_or(0),
            INHERIT_CI_OI,
        ),
        make_explicit_access(
            owner_rights.as_ptr(),
            SET_ACCESS,
            READ_CONTROL,
            INHERIT_CI_OI,
        ),
    ];

    let mut new_dacl: *mut ACL = std::ptr::null_mut();
    let code = unsafe {
        SetEntriesInAclW(
            entries.len() as u32,
            entries.as_ptr(),
            dacl,
            &mut new_dacl,
        )
    };
    let res = if code != ERROR_SUCCESS {
        Err(win32_code_error("SetEntriesInAclW(protect_root)", code))
    } else {
        let mut wide = to_wide(root_path);
        let set_code = unsafe {
            SetNamedSecurityInfoW(
                wide.as_mut_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                new_dacl,
                std::ptr::null(),
            )
        };
        if set_code != ERROR_SUCCESS {
            Err(win32_code_error(
                &format!("SetNamedSecurityInfoW({})", root_path.display()),
                set_code,
            ))
        } else {
            Ok(true)
        }
    };

    if !new_dacl.is_null() {
        unsafe {
            LocalFree(new_dacl as HLOCAL);
        }
    }
    if !sd.is_null() {
        unsafe {
            LocalFree(sd as HLOCAL);
        }
    }
    res
}

pub fn allow_worker_worktree(
    state_dir: &Path,
    worker_id: &str,
    worktree_path: &Path,
) -> io::Result<bool> {
    fs::create_dir_all(worktree_path)?;
    let (_, worker_sid_str) = ensure_worker_sid(state_dir, worker_id)?;
    let worker_sid = LocalSid::from_string(&worker_sid_str)?;

    let (dacl, sd) = read_named_dacl(worktree_path)?;
    let already_ok = unsafe {
        dacl_has_ace(
            dacl,
            worker_sid.as_ptr(),
            ACCESS_ALLOWED_ACE_TYPE as u8,
            INHERIT_CI_OI as u8,
            CHECK_ALLOW_BITS,
            false,
        )
    };
    if already_ok {
        if !sd.is_null() {
            unsafe {
                LocalFree(sd as HLOCAL);
            }
        }
        return Ok(false);
    }

    let explicit = make_explicit_access(
        worker_sid.as_ptr(),
        GRANT_ACCESS,
        WORKER_ALLOW_MODIFY_MASK,
        INHERIT_CI_OI,
    );
    let mut new_dacl: *mut ACL = std::ptr::null_mut();
    let code = unsafe { SetEntriesInAclW(1, &explicit, dacl, &mut new_dacl) };
    let res = if code != ERROR_SUCCESS {
        Err(win32_code_error("SetEntriesInAclW(allow_worker)", code))
    } else {
        let mut wide = to_wide(worktree_path);
        let set_code = unsafe {
            SetNamedSecurityInfoW(
                wide.as_mut_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                new_dacl,
                std::ptr::null(),
            )
        };
        if set_code != ERROR_SUCCESS {
            Err(win32_code_error(
                &format!("SetNamedSecurityInfoW({})", worktree_path.display()),
                set_code,
            ))
        } else {
            Ok(true)
        }
    };

    if !new_dacl.is_null() {
        unsafe {
            LocalFree(new_dacl as HLOCAL);
        }
    }
    if !sd.is_null() {
        unsafe {
            LocalFree(sd as HLOCAL);
        }
    }
    res
}

pub fn harden_private_dir(state_dir: &Path, dir_path: &Path) -> io::Result<bool> {
    fs::create_dir_all(dir_path)?;
    let store = load_or_create_sid_store(state_dir)?;
    let worker_group = LocalSid::from_string(&store.worker_group_sid)?;
    let owner_rights = LocalSid::from_string("S-1-3-4")?;
    let system_sid = LocalSid::from_string("S-1-5-18")?;
    let user_sid = current_user_sid_bytes()?;
    let user_sid_ptr = user_sid.as_ptr() as *mut c_void;

    let (dacl, sd) = read_named_dacl(dir_path)?;
    let mut control = 0u16;
    let mut revision = 0u32;
    let ctrl_ok = unsafe { GetSecurityDescriptorControl(sd, &mut control, &mut revision) };
    let is_protected = ctrl_ok != 0 && (control & SE_DACL_PROTECTED) != 0;
    let legacy = unsafe { take_overbroad_denies(dacl, worker_group.as_ptr()) };
    let already_ok = legacy.is_none()
        && is_protected
        && unsafe {
            dacl_has_ace(
                dacl,
                worker_group.as_ptr(),
                ACCESS_DENIED_ACE_TYPE as u8,
                INHERIT_CI_OI as u8,
                CHECK_DENY_BITS,
                false,
            ) && dacl_has_ace(
                dacl,
                worker_group.as_ptr(),
                ACCESS_DENIED_ACE_TYPE as u8,
                INHERIT_CI_OI as u8,
                CHECK_DENY_READ_BITS,
                false,
            ) && dacl_has_ace(
                dacl,
                owner_rights.as_ptr(),
                ACCESS_ALLOWED_ACE_TYPE as u8,
                INHERIT_CI_OI as u8,
                READ_CONTROL,
                true,
            ) && dacl_has_ace(
                dacl,
                user_sid_ptr,
                ACCESS_ALLOWED_ACE_TYPE as u8,
                INHERIT_CI_OI as u8,
                FILE_GENERIC_READ | FILE_GENERIC_WRITE,
                false,
            )
        };
    if already_ok {
        if !sd.is_null() {
            unsafe {
                LocalFree(sd as HLOCAL);
            }
        }
        return Ok(false);
    }

    let entries = [
        make_explicit_access(
            worker_group.as_ptr(),
            DENY_ACCESS,
            WORKER_DENY_WRITE_MASK | WORKER_DENY_READ_MASK,
            INHERIT_CI_OI,
        ),
        make_explicit_access(
            owner_rights.as_ptr(),
            GRANT_ACCESS,
            READ_CONTROL,
            INHERIT_CI_OI,
        ),
        make_explicit_access(user_sid_ptr, GRANT_ACCESS, GENERIC_ALL, INHERIT_CI_OI),
        make_explicit_access(
            system_sid.as_ptr(),
            GRANT_ACCESS,
            GENERIC_ALL,
            INHERIT_CI_OI,
        ),
    ];

    let mut new_dacl: *mut ACL = std::ptr::null_mut();
    let code = unsafe {
        SetEntriesInAclW(
            entries.len() as u32,
            entries.as_ptr(),
            std::ptr::null_mut(),
            &mut new_dacl,
        )
    };
    let res = if code != ERROR_SUCCESS {
        Err(win32_code_error("SetEntriesInAclW(harden)", code))
    } else {
        let mut wide = to_wide(dir_path);
        let set_code = unsafe {
            SetNamedSecurityInfoW(
                wide.as_mut_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                new_dacl,
                std::ptr::null(),
            )
        };
        if set_code != ERROR_SUCCESS {
            Err(win32_code_error(
                &format!("SetNamedSecurityInfoW(harden {})", dir_path.display()),
                set_code,
            ))
        } else {
            Ok(true)
        }
    };

    if !new_dacl.is_null() {
        unsafe {
            LocalFree(new_dacl as HLOCAL);
        }
    }
    if !sd.is_null() {
        unsafe {
            LocalFree(sd as HLOCAL);
        }
    }
    res
}

fn ensure_inheritable_ace(
    path: &Path,
    sid: *mut c_void,
    mode: i32,
    mask: u32,
    ace_type: u8,
    check_bits: u32,
    what: &str,
) -> io::Result<bool> {
    let (dacl, sd) = read_named_dacl(path)?;
    let already_ok =
        unsafe { dacl_has_ace(dacl, sid, ace_type, INHERIT_CI_OI as u8, check_bits, false) };
    if already_ok {
        if !sd.is_null() {
            unsafe {
                LocalFree(sd as HLOCAL);
            }
        }
        return Ok(false);
    }
    let explicit = make_explicit_access(sid, mode, mask, INHERIT_CI_OI);
    let mut new_dacl: *mut ACL = std::ptr::null_mut();
    let code = unsafe { SetEntriesInAclW(1, &explicit, dacl, &mut new_dacl) };
    let res = if code != ERROR_SUCCESS {
        Err(win32_code_error(&format!("SetEntriesInAclW({what})"), code))
    } else {
        let mut wide = to_wide(path);
        let set_code = unsafe {
            SetNamedSecurityInfoW(
                wide.as_mut_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                new_dacl,
                std::ptr::null(),
            )
        };
        if set_code != ERROR_SUCCESS {
            Err(win32_code_error(
                &format!("SetNamedSecurityInfoW({what} {})", path.display()),
                set_code,
            ))
        } else {
            Ok(true)
        }
    };
    if !new_dacl.is_null() {
        unsafe {
            LocalFree(new_dacl as HLOCAL);
        }
    }
    if !sd.is_null() {
        unsafe {
            LocalFree(sd as HLOCAL);
        }
    }
    res
}

// Explicit ACEs sort before inherited ones, so allow_read can re-open entries under this inherited read deny.
pub fn deny_read(state_dir: &Path, path: &Path) -> io::Result<bool> {
    let store = load_or_create_sid_store(state_dir)?;
    let worker_group = LocalSid::from_string(&store.worker_group_sid)?;
    ensure_inheritable_ace(
        path,
        worker_group.as_ptr(),
        DENY_ACCESS,
        WORKER_DENY_READ_MASK,
        ACCESS_DENIED_ACE_TYPE as u8,
        CHECK_DENY_READ_BITS,
        "deny_read",
    )
}

pub fn allow_read(state_dir: &Path, reader: Option<&str>, path: &Path) -> io::Result<bool> {
    let sid_str = match reader {
        Some(key) => ensure_reader_sid(state_dir, key)?,
        None => load_or_create_sid_store(state_dir)?.worker_group_sid,
    };
    let sid = LocalSid::from_string(&sid_str)?;
    ensure_inheritable_ace(
        path,
        sid.as_ptr(),
        GRANT_ACCESS,
        WORKER_ALLOW_READ_MASK,
        ACCESS_ALLOWED_ACE_TYPE as u8,
        CHECK_ALLOW_READ_BITS,
        "allow_read",
    )
}

fn open_pipe_for_dacl_edit(pipe_path: &str) -> io::Result<OwnedHandle> {
    let wide = to_wide(pipe_path);
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let raw = unsafe {
            CreateFileW(
                wide.as_ptr(),
                READ_CONTROL | WRITE_DAC,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            )
        };
        if !raw.is_null() && raw != INVALID_HANDLE_VALUE {
            return Ok(OwnedHandle(raw));
        }
        let err = io::Error::last_os_error();
        if err.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) && Instant::now() < deadline {
            unsafe {
                let _ = WaitNamedPipeW(wide.as_ptr(), 50);
            }
            continue;
        }
        return Err(err);
    }
}

fn add_pipe_ace(pipe_path: &str, explicit: &EXPLICIT_ACCESS_W, what: &str) -> io::Result<()> {
    let handle = open_pipe_for_dacl_edit(pipe_path)?;
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    let get_code = unsafe {
        GetSecurityInfo(
            handle.0,
            SE_KERNEL_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut sd,
        )
    };
    if get_code != ERROR_SUCCESS {
        return Err(win32_code_error(
            &format!("GetSecurityInfo(pipe {pipe_path})"),
            get_code,
        ));
    }
    let mut new_dacl: *mut ACL = std::ptr::null_mut();
    let res = unsafe {
        let acl_code = SetEntriesInAclW(1, explicit, dacl, &mut new_dacl);
        if acl_code != ERROR_SUCCESS {
            Err(win32_code_error(&format!("SetEntriesInAclW({what})"), acl_code))
        } else {
            let set_code = SetSecurityInfo(
                handle.0,
                SE_KERNEL_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                new_dacl,
                std::ptr::null(),
            );
            if set_code != ERROR_SUCCESS {
                Err(win32_code_error(
                    &format!("SetSecurityInfo(pipe {pipe_path})"),
                    set_code,
                ))
            } else {
                Ok(())
            }
        }
    };
    if !new_dacl.is_null() {
        unsafe {
            LocalFree(new_dacl as HLOCAL);
        }
    }
    if !sd.is_null() {
        unsafe {
            LocalFree(sd as HLOCAL);
        }
    }
    res
}

// Restricted tokens carry FusaWorker, so this deny holds even though the same user owns the pipe.
pub fn deny_worker_on_named_pipe(state_dir: &Path, pipe_path: &str) -> io::Result<()> {
    let store = load_or_create_sid_store(state_dir)?;
    let worker_group = LocalSid::from_string(&store.worker_group_sid)?;
    let explicit = make_explicit_access(
        worker_group.as_ptr(),
        DENY_ACCESS,
        FILE_GENERIC_READ | FILE_GENERIC_WRITE,
        0,
    );
    add_pipe_ace(pipe_path, &explicit, "deny_pipe")
}

// Lets `> NUL` work inside restricted tokens.
pub fn allow_null_device(psid: *mut c_void) {
    let wide = to_wide(r"\\.\NUL");
    let raw = unsafe {
        CreateFileW(
            wide.as_ptr(),
            READ_CONTROL | WRITE_DAC,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    if raw.is_null() || raw == INVALID_HANDLE_VALUE {
        return;
    }
    let handle = OwnedHandle(raw);
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    let code = unsafe {
        GetSecurityInfo(
            handle.0,
            SE_KERNEL_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut sd,
        )
    };
    if code == ERROR_SUCCESS {
        let explicit = make_explicit_access(
            psid,
            SET_ACCESS,
            FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE,
            0,
        );
        let mut new_dacl: *mut ACL = std::ptr::null_mut();
        if unsafe { SetEntriesInAclW(1, &explicit, dacl, &mut new_dacl) } == ERROR_SUCCESS {
            unsafe {
                let _ = SetSecurityInfo(
                    handle.0,
                    SE_KERNEL_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    new_dacl,
                    std::ptr::null(),
                );
                if !new_dacl.is_null() {
                    LocalFree(new_dacl as HLOCAL);
                }
            }
        }
    }
    if !sd.is_null() {
        unsafe {
            LocalFree(sd as HLOCAL);
        }
    }
}

// Under an elevated token libuv grants pipe write to BUILTIN\Administrators, which LUA_TOKEN disables in sandboxed Workers; grant the user SID instead.
pub fn allow_current_user_on_named_pipe(pipe_path: &str) -> io::Result<()> {
    let user_sid = current_user_sid_bytes()?;
    let explicit = make_explicit_access(
        user_sid.as_ptr() as *mut c_void,
        GRANT_ACCESS,
        FILE_GENERIC_READ | FILE_GENERIC_WRITE | SYNCHRONIZE,
        0,
    );
    add_pipe_ace(pipe_path, &explicit, "allow_pipe")
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::Foundation::{GENERIC_EXECUTE, GENERIC_READ, GENERIC_WRITE};
    use windows_sys::Win32::Storage::FileSystem::FILE_READ_ATTRIBUTES;

    fn explicit_denies(path: &Path, sid: *mut c_void) -> Vec<u32> {
        let (dacl, sd) = read_named_dacl(path).expect("read dacl");
        let mut masks = Vec::new();
        let count = unsafe { (*dacl).AceCount as u32 };
        for idx in 0..count {
            let mut raw_ace: *mut c_void = std::ptr::null_mut();
            if unsafe { GetAce(dacl, idx, &mut raw_ace) } == 0 {
                continue;
            }
            let header = unsafe { &*(raw_ace as *const ACE_HEADER) };
            if header.AceType != ACCESS_DENIED_ACE_TYPE as u8
                || (header.AceFlags & INHERITED_ACE as u8) != 0
            {
                continue;
            }
            let ace = unsafe { &*(raw_ace as *const ACCESS_DENIED_ACE) };
            if unsafe { EqualSid(&ace.SidStart as *const u32 as *mut c_void, sid) } != 0 {
                masks.push(ace.Mask);
            }
        }
        unsafe {
            LocalFree(sd as HLOCAL);
        }
        masks
    }

    #[test]
    fn deny_masks_leave_handle_and_metadata_rights_alone() {
        let handle_and_metadata = READ_CONTROL
            | SYNCHRONIZE
            | FILE_READ_ATTRIBUTES
            | GENERIC_READ
            | GENERIC_WRITE
            | GENERIC_EXECUTE
            | GENERIC_ALL;
        assert_eq!(WORKER_DENY_WRITE_MASK & handle_and_metadata, 0);
        assert_eq!(WORKER_DENY_WRITE_MASK & WORKER_DENY_READ_MASK, 0);
        assert_eq!(WORKER_DENY_READ_MASK & handle_and_metadata, 0);
    }

    #[test]
    fn protect_root_narrows_overbroad_deny_from_older_builds() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let state = tmp.path().join("state");
        let root = tmp.path().join("root");
        fs::create_dir_all(&root).expect("root");
        let store = load_or_create_sid_store(&state).expect("sid store");
        let group = LocalSid::from_string(&store.worker_group_sid).expect("group sid");
        let legacy =
            FILE_GENERIC_WRITE | GENERIC_WRITE | WORKER_DENY_WRITE_MASK | WORKER_DENY_READ_MASK;
        ensure_inheritable_ace(
            &root,
            group.as_ptr(),
            DENY_ACCESS,
            legacy,
            ACCESS_DENIED_ACE_TYPE as u8,
            CHECK_DENY_BITS,
            "legacy",
        )
        .expect("legacy deny");

        assert!(protect_root(&state, &root).expect("protect root"));
        let masks = explicit_denies(&root, group.as_ptr());
        assert!(!masks.is_empty());
        assert!(
            masks.iter().all(|m| m & !WORKER_DENY_ANY_MASK == 0),
            "{masks:x?}"
        );
        let denied = masks.iter().fold(0, |acc, m| acc | m);
        assert_eq!(denied & WORKER_DENY_WRITE_MASK, WORKER_DENY_WRITE_MASK);
        assert_eq!(denied & WORKER_DENY_READ_MASK, WORKER_DENY_READ_MASK);
        assert!(!protect_root(&state, &root).expect("protect root again"));
    }
}
