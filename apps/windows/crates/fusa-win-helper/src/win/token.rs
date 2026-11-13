use crate::sids::{ensure_worker_sid, load_or_create_sid_store};
use crate::win::acl::allow_null_device;
use crate::win::util::{last_os_error, win32_code_error, LocalSid, OwnedHandle};
use std::ffi::c_void;
use std::io;
use std::path::Path;
use windows_sys::Win32::Foundation::{ERROR_SUCCESS, GENERIC_ALL, HANDLE, HLOCAL, LocalFree};
use windows_sys::Win32::Security::Authorization::{
    SetEntriesInAclW, EXPLICIT_ACCESS_W, GRANT_ACCESS, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN,
    TRUSTEE_W,
};
use windows_sys::Win32::Security::{
    CopySid, CreateRestrictedToken, EqualSid, GetLengthSid, GetTokenInformation, IsValidSid,
    SetTokenInformation, TokenDefaultDacl, TokenGroups, TokenUser, ACL, DISABLE_MAX_PRIVILEGE,
    LUA_TOKEN, SID_AND_ATTRIBUTES, TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_PRIVILEGES,
    TOKEN_ADJUST_SESSIONID, TOKEN_ASSIGN_PRIMARY, TOKEN_DEFAULT_DACL, TOKEN_DUPLICATE,
    TOKEN_GROUPS, TOKEN_QUERY, TOKEN_USER, WRITE_RESTRICTED,
};
use windows_sys::Win32::Storage::FileSystem::READ_CONTROL;
use windows_sys::Win32::System::SystemServices::{
    SE_GROUP_ENABLED, SE_GROUP_LOGON_ID, SE_GROUP_USE_FOR_DENY_ONLY,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

unsafe fn copy_sid_bytes(psid: *mut c_void) -> io::Result<Vec<u8>> {
    if psid.is_null() || unsafe { IsValidSid(psid) } == 0 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid SID"));
    }
    let len = unsafe { GetLengthSid(psid) };
    let mut out = vec![0u8; len as usize];
    let ok = unsafe { CopySid(len, out.as_mut_ptr() as *mut c_void, psid) };
    if ok == 0 {
        return Err(last_os_error("CopySid"));
    }
    Ok(out)
}

fn query_token_info(token: HANDLE, class: i32) -> io::Result<Vec<u8>> {
    let mut needed = 0u32;
    unsafe {
        let _ = GetTokenInformation(token, class, std::ptr::null_mut(), 0, &mut needed);
    }
    if needed == 0 {
        return Err(last_os_error("GetTokenInformation(size)"));
    }
    let mut buf = vec![0u8; needed as usize];
    let ok = unsafe {
        GetTokenInformation(
            token,
            class,
            buf.as_mut_ptr() as *mut c_void,
            needed,
            &mut needed,
        )
    };
    if ok == 0 {
        return Err(last_os_error("GetTokenInformation(data)"));
    }
    Ok(buf)
}

pub fn current_user_sid_bytes() -> io::Result<Vec<u8>> {
    let mut tok: HANDLE = std::ptr::null_mut();
    let ok = unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut tok) };
    if ok == 0 {
        return Err(last_os_error("OpenProcessToken(TOKEN_QUERY)"));
    }
    let handle = OwnedHandle(tok);
    let user_buf = query_token_info(handle.0, TokenUser)?;
    let user = unsafe { &*(user_buf.as_ptr() as *const TOKEN_USER) };
    unsafe { copy_sid_bytes(user.User.Sid) }
}

unsafe fn set_restricted_token_default_dacl(
    token: HANDLE,
    user_sid: *mut c_void,
    logon_sid: Option<*mut c_void>,
) -> io::Result<()> {
    let owner_rights = LocalSid::from_string("S-1-3-4")?;
    let system_sid = LocalSid::from_string("S-1-5-18")?;
    let mut principals: Vec<(*mut c_void, u32)> = vec![
        (user_sid, GENERIC_ALL),
        (system_sid.as_ptr(), GENERIC_ALL),
        (owner_rights.as_ptr(), READ_CONTROL),
    ];
    if let Some(lsid) = logon_sid {
        if unsafe { EqualSid(lsid, user_sid) == 0 } {
            principals.push((lsid, GENERIC_ALL));
        }
    }
    let entries: Vec<EXPLICIT_ACCESS_W> = principals
        .into_iter()
        .map(|(sid, mask)| EXPLICIT_ACCESS_W {
            grfAccessPermissions: mask,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: 0,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: std::ptr::null_mut(),
                MultipleTrusteeOperation: 0,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: sid as *mut u16,
            },
        })
        .collect();

    let mut new_dacl: *mut ACL = std::ptr::null_mut();
    let code = unsafe {
        SetEntriesInAclW(
            entries.len() as u32,
            entries.as_ptr(),
            std::ptr::null_mut(),
            &mut new_dacl,
        )
    };
    if code != ERROR_SUCCESS {
        return Err(win32_code_error("SetEntriesInAclW(TokenDefaultDacl)", code));
    }
    let dacl_info = TOKEN_DEFAULT_DACL {
        DefaultDacl: new_dacl,
    };
    let ok = unsafe {
        SetTokenInformation(
            token,
            TokenDefaultDacl,
            &dacl_info as *const _ as *const c_void,
            std::mem::size_of::<TOKEN_DEFAULT_DACL>() as u32,
        )
    };
    let set_err = if ok == 0 {
        Some(last_os_error("SetTokenInformation(TokenDefaultDacl)"))
    } else {
        None
    };
    if !new_dacl.is_null() {
        unsafe {
            LocalFree(new_dacl as HLOCAL);
        }
    }
    if let Some(err) = set_err {
        return Err(err);
    }
    Ok(())
}

fn contains_sid(list: &[Vec<u8>], candidate: *mut c_void) -> bool {
    list.iter()
        .any(|existing| unsafe { EqualSid(existing.as_ptr() as *mut c_void, candidate) != 0 })
}

/// Creates a `WRITE_RESTRICTED` token copying:
/// - Current token's `TokenUser` SID
/// - All enabled `TokenGroups` SIDs (so `Authenticated Users`, `Users`, logon SID, etc. remain writable outside protected roots, e.g. `D:\`)
/// - `Everyone` (`S-1-1-0`)
/// - Persistent `FusaWorker` SID (denied write on protected roots)
/// - Optional `FusaWorker-<workerId>` SID (allowed write on this worker's own worktree; omitted in `--readonly-fallback` mode)
pub fn create_worker_restricted_token(
    state_dir: &Path,
    worker_id: Option<&str>,
    readonly_fallback: bool,
) -> io::Result<OwnedHandle> {
    let (group_sid_str, worker_sid_str) = if readonly_fallback {
        let store = load_or_create_sid_store(state_dir)?;
        (store.worker_group_sid, None)
    } else {
        let wid = worker_id.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "worker_id required when not in readonly_fallback mode",
            )
        })?;
        let (g, w) = ensure_worker_sid(state_dir, wid)?;
        (g, Some(w))
    };

    let desired = TOKEN_DUPLICATE
        | TOKEN_QUERY
        | TOKEN_ASSIGN_PRIMARY
        | TOKEN_ADJUST_DEFAULT
        | TOKEN_ADJUST_SESSIONID
        | TOKEN_ADJUST_PRIVILEGES;
    let mut base_raw: HANDLE = std::ptr::null_mut();
    let ok = unsafe { OpenProcessToken(GetCurrentProcess(), desired, &mut base_raw) };
    if ok == 0 {
        return Err(last_os_error("OpenProcessToken(restriction)"));
    }
    let base = OwnedHandle(base_raw);

    let user_buf = query_token_info(base.0, TokenUser)?;
    let token_user = unsafe { &*(user_buf.as_ptr() as *const TOKEN_USER) };
    let user_sid = unsafe { copy_sid_bytes(token_user.User.Sid)? };

    let groups_buf = query_token_info(base.0, TokenGroups)?;
    let token_groups = unsafe { &*(groups_buf.as_ptr() as *const TOKEN_GROUPS) };
    let groups_slice = unsafe {
        std::slice::from_raw_parts(
            token_groups.Groups.as_ptr(),
            token_groups.GroupCount as usize,
        )
    };

    let mut owned_sids: Vec<Vec<u8>> = Vec::with_capacity(groups_slice.len() + 4);
    owned_sids.push(user_sid.clone());
    let mut logon_sid: Option<Vec<u8>> = None;

    for entry in groups_slice {
        let attrs = entry.Attributes;
        let logon_flag = SE_GROUP_LOGON_ID as u32;
        if (attrs & logon_flag) == logon_flag && logon_sid.is_none() {
            if let Ok(copied) = unsafe { copy_sid_bytes(entry.Sid) } {
                logon_sid = Some(copied);
            }
        }
        let enabled = (attrs & (SE_GROUP_ENABLED as u32)) != 0;
        let deny_only = (attrs & (SE_GROUP_USE_FOR_DENY_ONLY as u32)) != 0;
        if enabled && !deny_only && !contains_sid(&owned_sids, entry.Sid) {
            owned_sids.push(unsafe { copy_sid_bytes(entry.Sid)? });
        }
    }

    let world = LocalSid::from_string("S-1-1-0")?;
    if !contains_sid(&owned_sids, world.as_ptr()) {
        owned_sids.push(unsafe { copy_sid_bytes(world.as_ptr())? });
    }

    let group_sid = LocalSid::from_string(&group_sid_str)?;
    allow_null_device(group_sid.as_ptr());
    owned_sids.push(unsafe { copy_sid_bytes(group_sid.as_ptr())? });

    if let Some(ws_str) = worker_sid_str {
        let ws = LocalSid::from_string(&ws_str)?;
        allow_null_device(ws.as_ptr());
        owned_sids.push(unsafe { copy_sid_bytes(ws.as_ptr())? });
    }

    let restricting: Vec<SID_AND_ATTRIBUTES> = owned_sids
        .iter()
        .map(|bytes| SID_AND_ATTRIBUTES {
            Sid: bytes.as_ptr() as *mut c_void,
            Attributes: 0,
        })
        .collect();

    let mut out_token: HANDLE = std::ptr::null_mut();
    let ok = unsafe {
        CreateRestrictedToken(
            base.0,
            DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED,
            0,
            std::ptr::null(),
            0,
            std::ptr::null(),
            restricting.len() as u32,
            restricting.as_ptr(),
            &mut out_token,
        )
    };
    if ok == 0 {
        return Err(last_os_error("CreateRestrictedToken"));
    }
    let restricted = OwnedHandle(out_token);

    unsafe {
        set_restricted_token_default_dacl(
            restricted.0,
            user_sid.as_ptr() as *mut c_void,
            logon_sid.as_ref().map(|b| b.as_ptr() as *mut c_void),
        )?;
    }

    Ok(restricted)
}
