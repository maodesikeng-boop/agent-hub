use crate::win::util::{last_os_error, OwnedHandle};
use std::ffi::c_void;
use std::io;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicUIRestrictions,
    JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
    JOBOBJECT_BASIC_UI_RESTRICTIONS, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOB_OBJECT_UILIMIT_DESKTOP, JOB_OBJECT_UILIMIT_GLOBALATOMS, JOB_OBJECT_UILIMIT_HANDLES,
};

pub struct SessionJob {
    handle: OwnedHandle,
}

unsafe impl Send for SessionJob {}
unsafe impl Sync for SessionJob {}

impl SessionJob {
    pub fn create(restrict_ui: bool) -> io::Result<Self> {
        let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        let handle = OwnedHandle(raw);
        if !handle.is_valid() {
            return Err(last_os_error("CreateJobObjectW"));
        }

        let mut ext: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        ext.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
        let ok = unsafe {
            SetInformationJobObject(
                handle.0,
                JobObjectExtendedLimitInformation,
                &ext as *const _ as *const c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            return Err(last_os_error(
                "SetInformationJobObject(JobObjectExtendedLimitInformation)",
            ));
        }

        if restrict_ui {
            let ui = JOBOBJECT_BASIC_UI_RESTRICTIONS {
                UIRestrictionsClass: JOB_OBJECT_UILIMIT_HANDLES
                    | JOB_OBJECT_UILIMIT_DESKTOP
                    | JOB_OBJECT_UILIMIT_GLOBALATOMS,
            };
            let ui_ok = unsafe {
                SetInformationJobObject(
                    handle.0,
                    JobObjectBasicUIRestrictions,
                    &ui as *const _ as *const c_void,
                    std::mem::size_of::<JOBOBJECT_BASIC_UI_RESTRICTIONS>() as u32,
                )
            };
            if ui_ok == 0 {
                return Err(last_os_error(
                    "SetInformationJobObject(JobObjectBasicUIRestrictions)",
                ));
            }
        }

        Ok(Self { handle })
    }

    /// # Safety
    /// `process` must be a valid open process handle with `PROCESS_SET_QUOTA` and `PROCESS_TERMINATE` rights.
    pub unsafe fn assign(&self, process: HANDLE) -> io::Result<()> {
        let ok = unsafe { AssignProcessToJobObject(self.handle.0, process) };
        if ok == 0 {
            return Err(last_os_error("AssignProcessToJobObject"));
        }
        Ok(())
    }

    pub fn terminate(&self, exit_code: u32) {
        unsafe {
            let _ = TerminateJobObject(self.handle.0, exit_code);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::SessionJob;
    use crate::win::util::to_wide;
    use std::ffi::c_void;
    use std::io::{self, Read, Write};
    use std::os::windows::io::AsRawHandle;
    use std::process::{Command, Stdio};
    use windows_sys::Win32::Foundation::{GENERIC_ALL, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        JobObjectBasicUIRestrictions, QueryInformationJobObject, JOBOBJECT_BASIC_UI_RESTRICTIONS,
        JOB_OBJECT_UILIMIT_DESKTOP, JOB_OBJECT_UILIMIT_GLOBALATOMS, JOB_OBJECT_UILIMIT_HANDLES,
    };
    use windows_sys::Win32::System::StationsAndDesktops::{CloseDesktop, CreateDesktopW};

    const CHILD_ENV: &str = "FUSA_JOB_TEST_CREATE_DESKTOP_CHILD";
    const CHILD_TEST: &str = "win::job::tests::create_desktop_child";

    fn try_create_desktop() -> io::Result<()> {
        let name = to_wide(format!("fusa-job-test-{}", std::process::id()));
        let desktop = unsafe {
            CreateDesktopW(
                name.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                GENERIC_ALL,
                std::ptr::null(),
            )
        };
        if desktop.is_null() {
            return Err(io::Error::last_os_error());
        }
        unsafe {
            CloseDesktop(desktop);
        }
        Ok(())
    }

    #[test]
    fn create_desktop_child() {
        if std::env::var_os(CHILD_ENV).is_none() {
            return;
        }
        let mut gate = [0u8; 1];
        let _ = io::stdin().read(&mut gate);
        let code = match try_create_desktop() {
            Ok(()) => 0,
            Err(err) => err.raw_os_error().unwrap_or(-1),
        };
        std::process::exit(code);
    }

    fn create_desktop_exit_code_in_job(restrict_ui: bool) -> i32 {
        let job = SessionJob::create(restrict_ui).expect("create job");
        let mut child = Command::new(std::env::current_exe().expect("test exe"))
            .args(["--exact", CHILD_TEST, "--nocapture", "--test-threads=1"])
            .env(CHILD_ENV, "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn child");
        // The child blocks on stdin until it is inside the job, so CreateDesktopW sees the job's limits.
        unsafe { job.assign(child.as_raw_handle() as HANDLE) }.expect("assign child to job");
        child
            .stdin
            .take()
            .expect("child stdin")
            .write_all(b"g")
            .expect("release child");
        child.wait().expect("wait child").code().unwrap_or(-1)
    }

    // Some vendor CLIs run every shell command on a private desktop they create first.
    #[test]
    fn worker_job_allows_creating_private_desktops() {
        assert_eq!(
            create_desktop_exit_code_in_job(false),
            0,
            "baseline: CreateDesktopW must work outside UI-restricted jobs on this host"
        );
        assert_eq!(
            create_desktop_exit_code_in_job(true),
            0,
            "CreateDesktopW inside the Worker job failed (5 = ERROR_ACCESS_DENIED)"
        );
    }

    #[test]
    fn worker_job_keeps_handle_and_atom_isolation() {
        let job = SessionJob::create(true).expect("create job");
        let mut ui: JOBOBJECT_BASIC_UI_RESTRICTIONS = unsafe { std::mem::zeroed() };
        let ok = unsafe {
            QueryInformationJobObject(
                job.handle.0,
                JobObjectBasicUIRestrictions,
                &mut ui as *mut _ as *mut c_void,
                std::mem::size_of::<JOBOBJECT_BASIC_UI_RESTRICTIONS>() as u32,
                std::ptr::null_mut(),
            )
        };
        assert_ne!(ok, 0, "QueryInformationJobObject failed");
        let kept = JOB_OBJECT_UILIMIT_HANDLES | JOB_OBJECT_UILIMIT_GLOBALATOMS;
        assert_eq!(ui.UIRestrictionsClass & kept, kept);
        assert_eq!(ui.UIRestrictionsClass & JOB_OBJECT_UILIMIT_DESKTOP, 0);
    }
}
