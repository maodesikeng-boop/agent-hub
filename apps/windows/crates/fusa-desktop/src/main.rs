#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().skip(1).any(|arg| arg == "--self-test") {
        match fusa_desktop::self_test::run_headless_self_test() {
            Ok(summary) => {
                println!("{summary}");
                std::process::exit(0);
            }
            Err(err) => {
                eprintln!("[fusa-self-test] FAIL: {err}");
                std::process::exit(1);
            }
        }
    }
    fusa_desktop::run();
}
