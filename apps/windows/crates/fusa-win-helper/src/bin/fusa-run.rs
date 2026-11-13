use fusa_win_helper::cli::parse_fusa_run_args;

fn main() {
    let raw_args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = match parse_fusa_run_args(&raw_args) {
        Ok(cmd) => cmd,
        Err(msg) => {
            eprintln!("fusa-run: {msg}");
            std::process::exit(2);
        }
    };

    #[cfg(not(windows))]
    {
        let _ = cmd;
        eprintln!("fusa-run is only supported on Windows");
        std::process::exit(1);
    }

    #[cfg(windows)]
    {
        use fusa_win_helper::cli::FusaRunCommand;
        use fusa_win_helper::win::{acl, awake, inspect, locks, probe, runner};

        let exit_code = match cmd {
            FusaRunCommand::Run {
                sandbox,
                ctrl_pipe,
                cwd,
                raw_tail,
                program,
                args,
            } => match runner::run_session(runner::RunSessionSpec {
                sandbox: &sandbox,
                ctrl_pipe: ctrl_pipe.as_deref(),
                cwd: cwd.as_deref(),
                raw_tail: raw_tail.as_deref(),
                program: &program,
                args: &args,
            }) {
                Ok(code) => code,
                Err(err) => {
                    eprintln!("fusa-run: {err}");
                    127
                }
            },
            FusaRunCommand::Probe { state_dir } => {
                match probe::run_sandbox_probe(state_dir.as_deref()) {
                    Ok(()) => {
                        println!(r#"{{"ok":true}}"#);
                        0
                    }
                    Err(err) => {
                        eprintln!("fusa-run probe failed: {err}");
                        1
                    }
                }
            }
            FusaRunCommand::AclProtectRoot { state_dir, path } => {
                match acl::protect_root(&state_dir, &path) {
                    Ok(changed) => {
                        println!(r#"{{"ok":true,"changed":{changed}}}"#);
                        0
                    }
                    Err(err) => {
                        eprintln!("fusa-run acl protect-root failed: {err}");
                        1
                    }
                }
            }
            FusaRunCommand::AclAllowWorker {
                state_dir,
                worker_id,
                path,
            } => match acl::allow_worker_worktree(&state_dir, &worker_id, &path) {
                Ok(changed) => {
                    println!(r#"{{"ok":true,"changed":{changed}}}"#);
                    0
                }
                Err(err) => {
                    eprintln!("fusa-run acl allow-worker failed: {err}");
                    1
                }
            },
            FusaRunCommand::AclHarden { state_dir, path } => {
                match acl::harden_private_dir(&state_dir, &path) {
                    Ok(changed) => {
                        println!(r#"{{"ok":true,"changed":{changed}}}"#);
                        0
                    }
                    Err(err) => {
                        eprintln!("fusa-run acl harden failed: {err}");
                        1
                    }
                }
            }
            FusaRunCommand::Inspect { pid } => {
                let res = inspect::inspect_process(pid);
                println!(
                    "{}",
                    serde_json::to_string(&res).unwrap_or_else(|_| r#"{"alive":false}"#.to_string())
                );
                if res.alive { 0 } else { 1 }
            }
            FusaRunCommand::WhoLocks { path } => match locks::query_who_locks(&path) {
                Ok(res) => {
                    println!(
                        "{}",
                        serde_json::to_string(&res)
                            .unwrap_or_else(|_| r#"{"holders":[]}"#.to_string())
                    );
                    0
                }
                Err(err) => {
                    eprintln!("fusa-run who-locks failed: {err}");
                    1
                }
            },
            FusaRunCommand::KeepAwake { parent_pid } => {
                match awake::keep_awake_until_parent_exits(parent_pid) {
                    Ok(()) => 0,
                    Err(err) => {
                        eprintln!("fusa-run keep-awake failed: {err}");
                        1
                    }
                }
            }
            FusaRunCommand::InternalProbeChild {
                denied_file,
                allowed_file,
                outside_file,
            } => probe::run_internal_probe_child(&denied_file, &allowed_file, &outside_file),
        };
        std::process::exit(exit_code);
    }
}
