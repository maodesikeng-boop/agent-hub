use crate::cli::SandboxMode;
use crate::cmdline::build_windows_command_line;
use crate::win::job::SessionJob;
use crate::win::token::create_worker_restricted_token;
use crate::win::util::{last_os_error, to_wide, OwnedHandle};
use std::ffi::c_void;
use std::fs::File;
use std::io::{self, BufRead, BufReader};
use std::os::windows::io::FromRawHandle;
use std::path::Path;
use std::sync::Arc;
use std::thread;
use windows_sys::Win32::Foundation::{
    SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_INBOUND};
use windows_sys::Win32::System::Console::{
    AllocConsole, FreeConsole, GenerateConsoleCtrlEvent, GetStdHandle, SetConsoleCtrlHandler,
    SetStdHandle, CTRL_BREAK_EVENT, CTRL_C_EVENT, STD_ERROR_HANDLE, STD_INPUT_HANDLE,
    STD_OUTPUT_HANDLE,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::{
    CreateProcessAsUserW, CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
    InitializeProcThreadAttributeList, ResumeThread, TerminateProcess, UpdateProcThreadAttribute,
    WaitForSingleObject, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
    EXTENDED_STARTUPINFO_PRESENT, INFINITE, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
    PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, STARTUPINFOEXW,
    STARTF_USESTDHANDLES,
};
use windows_sys::Win32::System::WindowsProgramming::{
    PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_DISABLE_PROCESS_TREE,
    PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_OVERRIDE,
};

unsafe extern "system" fn swallow_ctrl_handler(ctrl_type: u32) -> i32 {
    if ctrl_type == CTRL_C_EVENT || ctrl_type == CTRL_BREAK_EVENT {
        1
    } else {
        0
    }
}

fn setup_private_console(stdin_h: HANDLE, stdout_h: HANDLE, stderr_h: HANDLE) {
    unsafe {
        let _ = FreeConsole();
        let _ = AllocConsole();
        if !stdin_h.is_null() && stdin_h != INVALID_HANDLE_VALUE {
            let _ = SetStdHandle(STD_INPUT_HANDLE, stdin_h);
        }
        if !stdout_h.is_null() && stdout_h != INVALID_HANDLE_VALUE {
            let _ = SetStdHandle(STD_OUTPUT_HANDLE, stdout_h);
        }
        if !stderr_h.is_null() && stderr_h != INVALID_HANDLE_VALUE {
            let _ = SetStdHandle(STD_ERROR_HANDLE, stderr_h);
        }
        let _ = SetConsoleCtrlHandler(Some(swallow_ctrl_handler), 1);
    }
}

fn start_ctrl_pipe_listener(pipe_name: &str, job: Arc<SessionJob>) -> io::Result<()> {
    let wide = to_wide(pipe_name);
    let raw_pipe = unsafe {
        CreateNamedPipeW(
            wide.as_ptr(),
            PIPE_ACCESS_INBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            1,
            1024,
            1024,
            0,
            std::ptr::null(),
        )
    };
    if raw_pipe.is_null() || raw_pipe == INVALID_HANDLE_VALUE {
        return Err(last_os_error("CreateNamedPipeW(ctrl_pipe)"));
    }
    let pipe_addr = raw_pipe as usize;
    thread::spawn(move || {
        let pipe_handle = pipe_addr as HANDLE;
        let connected = unsafe { ConnectNamedPipe(pipe_handle, std::ptr::null_mut()) };
        if connected == 0 {
            let err = io::Error::last_os_error();
            // ERROR_PIPE_CONNECTED == 535 means client connected between CreateNamedPipeW and ConnectNamedPipe
            if err.raw_os_error() != Some(535) {
                unsafe {
                    let _ = File::from_raw_handle(pipe_handle as _);
                }
                return;
            }
        }
        let file = unsafe { File::from_raw_handle(pipe_handle as _) };
        let reader = BufReader::new(file);
        for line in reader.lines().map_while(Result::ok) {
            match line.trim() {
                "interrupt" => unsafe {
                    let _ = GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0);
                },
                "kill" => {
                    job.terminate(1);
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

struct AttrList {
    buf: Vec<u8>,
    handles: Vec<HANDLE>,
    desktop_policy: Box<u32>,
}

impl AttrList {
    fn build(handles: Vec<HANDLE>) -> io::Result<Self> {
        let attr_count = if handles.is_empty() { 1 } else { 2 };
        let mut size = 0usize;
        unsafe {
            let _ = InitializeProcThreadAttributeList(std::ptr::null_mut(), attr_count, 0, &mut size);
        }
        if size == 0 {
            return Err(last_os_error("InitializeProcThreadAttributeList(size)"));
        }
        let mut buf = vec![0u8; size];
        let ok = unsafe {
            InitializeProcThreadAttributeList(
                buf.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST,
                attr_count,
                0,
                &mut size,
            )
        };
        if ok == 0 {
            return Err(last_os_error("InitializeProcThreadAttributeList(init)"));
        }

        let mut me = Self {
            buf,
            handles,
            desktop_policy: Box::new(
                PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_DISABLE_PROCESS_TREE
                    | PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_OVERRIDE,
            ),
        };

        if !me.handles.is_empty() {
            let ok_h = unsafe {
                UpdateProcThreadAttribute(
                    me.as_mut_ptr(),
                    0,
                    PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                    me.handles.as_mut_ptr() as *mut c_void,
                    me.handles.len() * std::mem::size_of::<HANDLE>(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            };
            if ok_h == 0 {
                return Err(last_os_error("UpdateProcThreadAttribute(HANDLE_LIST)"));
            }
        }

        // Best-effort on Win10+; older builds that don't recognize DESKTOP_APP_POLICY ignore failure.
        unsafe {
            let _ = UpdateProcThreadAttribute(
                me.as_mut_ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY as usize,
                (&mut *me.desktop_policy) as *mut u32 as *mut c_void,
                std::mem::size_of::<u32>(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            );
        }
        Ok(me)
    }

    fn as_mut_ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.buf.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST
    }
}

impl Drop for AttrList {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.as_mut_ptr());
        }
    }
}

pub struct RunSessionSpec<'a> {
    pub sandbox: &'a SandboxMode,
    pub ctrl_pipe: Option<&'a str>,
    pub cwd: Option<&'a Path>,
    pub raw_tail: Option<&'a str>,
    pub program: &'a str,
    pub args: &'a [String],
}

pub fn run_session(spec: RunSessionSpec<'_>) -> io::Result<i32> {
    // Save inherited stdio handles BEFORE switching to our private hidden console!
    let stdin_h = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
    let stdout_h = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
    let stderr_h = unsafe { GetStdHandle(STD_ERROR_HANDLE) };

    setup_private_console(stdin_h, stdout_h, stderr_h);

    let mut unique_handles: Vec<HANDLE> = Vec::with_capacity(3);
    for h in [stdin_h, stdout_h, stderr_h] {
        if !h.is_null() && h != INVALID_HANDLE_VALUE {
            unsafe {
                let _ = SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
            }
            if !unique_handles.contains(&h) {
                unique_handles.push(h);
            }
        }
    }

    let is_worker_sandbox = matches!(spec.sandbox, SandboxMode::Worker { .. });
    let job = SessionJob::create(is_worker_sandbox).ok().map(Arc::new);
    if is_worker_sandbox && job.is_none() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "failed to create Job Object required for Worker sandbox",
        ));
    }

    if let (Some(pipe_name), Some(job_ref)) = (spec.ctrl_pipe, job.as_ref()) {
        let _ = start_ctrl_pipe_listener(pipe_name, Arc::clone(job_ref));
    }

    let restricted_token = match spec.sandbox {
        SandboxMode::None => None,
        SandboxMode::Worker {
            state_dir,
            worker_id,
            readonly_fallback,
        } => Some(create_worker_restricted_token(
            state_dir,
            worker_id.as_deref(),
            *readonly_fallback,
        )?),
    };

    let mut attr_list = AttrList::build(unique_handles.clone())?;
    let mut si_ex: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    si_ex.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    si_ex.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    si_ex.StartupInfo.hStdInput = stdin_h;
    si_ex.StartupInfo.hStdOutput = stdout_h;
    si_ex.StartupInfo.hStdError = stderr_h;
    si_ex.lpAttributeList = attr_list.as_mut_ptr();

    let cmdline = build_windows_command_line(spec.program, spec.args, spec.raw_tail);
    let mut cmdline_wide = to_wide(&cmdline);
    let cwd_wide = spec.cwd.map(to_wide);
    let cwd_ptr = cwd_wide
        .as_ref()
        .map(|w| w.as_ptr())
        .unwrap_or(std::ptr::null());

    let flags =
        CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT;
    let inherit = if unique_handles.is_empty() { 0 } else { 1 };
    let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };

    let created = unsafe {
        if let Some(ref tok) = restricted_token {
            CreateProcessAsUserW(
                tok.0,
                std::ptr::null(),
                cmdline_wide.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                inherit,
                flags,
                std::ptr::null(),
                cwd_ptr,
                &si_ex.StartupInfo,
                &mut pi,
            )
        } else {
            CreateProcessW(
                std::ptr::null(),
                cmdline_wide.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                inherit,
                flags,
                std::ptr::null(),
                cwd_ptr,
                &si_ex.StartupInfo,
                &mut pi,
            )
        }
    };
    if created == 0 {
        return Err(last_os_error(&format!(
            "CreateProcess failed for `{}`",
            spec.program
        )));
    }

    let proc_handle = OwnedHandle(pi.hProcess);
    let thread_handle = OwnedHandle(pi.hThread);

    if let Some(ref job_ref) = job {
        if let Err(assign_err) = job_ref.assign(proc_handle.0) {
            if is_worker_sandbox {
                unsafe {
                    let _ = TerminateProcess(proc_handle.0, 1);
                }
                return Err(assign_err);
            }
            eprintln!(
                "[fusa-run] warning: AssignProcessToJobObject failed in non-sandbox mode, continuing without job nesting: {assign_err}"
            );
        }
    }

    let resumed = unsafe { ResumeThread(thread_handle.0) };
    if resumed == u32::MAX {
        unsafe {
            let _ = TerminateProcess(proc_handle.0, 1);
        }
        return Err(last_os_error("ResumeThread"));
    }
    drop(thread_handle);

    unsafe {
        let _ = WaitForSingleObject(proc_handle.0, INFINITE);
    }
    let mut exit_code = 1u32;
    unsafe {
        let _ = GetExitCodeProcess(proc_handle.0, &mut exit_code);
    }

    if let Some(ref job_ref) = job {
        job_ref.terminate(1);
    }

    Ok(exit_code as i32)
}
