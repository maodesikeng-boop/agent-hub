#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(windows)]
fn attach_parent_console_if_unredirected() {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Console::{
        AttachConsole, GetStdHandle, ATTACH_PARENT_PROCESS, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE,
    };
    unsafe {
        let out = GetStdHandle(STD_OUTPUT_HANDLE);
        let err = GetStdHandle(STD_ERROR_HANDLE);
        let has_valid_out = !out.is_null() && out != INVALID_HANDLE_VALUE;
        let has_valid_err = !err.is_null() && err != INVALID_HANDLE_VALUE;
        if !has_valid_out && !has_valid_err {
            let _ = AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }
}

fn main() {
    if std::env::args().skip(1).any(|arg| arg == "--self-test") {
        #[cfg(windows)]
        attach_parent_console_if_unredirected();

        use std::io::Write as _;
        match fusa_desktop::self_test::run_headless_self_test() {
            Ok(summary) => {
                println!("{summary}");
                let _ = std::io::stdout().flush();
                std::process::exit(0);
            }
            Err(err) => {
                eprintln!("[fusa-self-test] FAIL: {err}");
                let _ = std::io::stderr().flush();
                std::process::exit(1);
            }
        }
    }
    fusa_desktop::run();
}
