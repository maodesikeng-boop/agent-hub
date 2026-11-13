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

    pub fn assign(&self, process: HANDLE) -> io::Result<()> {
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
