use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SandboxMode {
    None,
    Worker {
        state_dir: PathBuf,
        worker_id: Option<String>,
        readonly_fallback: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FusaRunCommand {
    Run {
        sandbox: SandboxMode,
        ctrl_pipe: Option<String>,
        cwd: Option<PathBuf>,
        raw_tail: Option<String>,
        program: String,
        args: Vec<String>,
    },
    Probe {
        state_dir: Option<PathBuf>,
    },
    AclProtectRoot {
        state_dir: PathBuf,
        path: PathBuf,
    },
    AclAllowWorker {
        state_dir: PathBuf,
        worker_id: String,
        path: PathBuf,
    },
    AclHarden {
        state_dir: PathBuf,
        path: PathBuf,
    },
    Inspect {
        pid: u32,
    },
    WhoLocks {
        path: PathBuf,
    },
    KeepAwake {
        parent_pid: u32,
    },
    InternalProbeChild {
        denied_file: PathBuf,
        allowed_file: PathBuf,
        outside_file: PathBuf,
    },
}

fn next_val<'a>(iter: &mut impl Iterator<Item = &'a str>, flag: &str) -> Result<String, String> {
    iter.next()
        .map(|s| s.to_string())
        .ok_or_else(|| format!("missing value for {flag}"))
}

pub fn parse_fusa_run_args(raw_args: &[String]) -> Result<FusaRunCommand, String> {
    if raw_args.is_empty() {
        return Err("usage: fusa-run <subcommand | [options] -- <program> [args...]>".to_string());
    }

    match raw_args[0].as_str() {
        "probe" => {
            let mut state_dir = None;
            let mut it = raw_args[1..].iter().map(String::as_str);
            while let Some(arg) = it.next() {
                match arg {
                    "--state-dir" => state_dir = Some(PathBuf::from(next_val(&mut it, "--state-dir")?)),
                    other => return Err(format!("unknown probe option: {other}")),
                }
            }
            return Ok(FusaRunCommand::Probe { state_dir });
        }
        "inspect" => {
            let mut pid: Option<u32> = None;
            let mut it = raw_args[1..].iter().map(String::as_str);
            while let Some(arg) = it.next() {
                match arg {
                    "--pid" => {
                        let v = next_val(&mut it, "--pid")?;
                        pid = Some(v.parse::<u32>().map_err(|_| format!("invalid --pid: {v}"))?);
                    }
                    other => return Err(format!("unknown inspect option: {other}")),
                }
            }
            let pid = pid.ok_or_else(|| "inspect requires --pid <N>".to_string())?;
            return Ok(FusaRunCommand::Inspect { pid });
        }
        "who-locks" => {
            let path = raw_args
                .get(1)
                .ok_or_else(|| "who-locks requires <path>".to_string())?;
            return Ok(FusaRunCommand::WhoLocks {
                path: PathBuf::from(path),
            });
        }
        "keep-awake" => {
            let mut parent_pid: Option<u32> = None;
            let mut it = raw_args[1..].iter().map(String::as_str);
            while let Some(arg) = it.next() {
                match arg {
                    "--parent" => {
                        let v = next_val(&mut it, "--parent")?;
                        parent_pid = Some(
                            v.parse::<u32>()
                                .map_err(|_| format!("invalid --parent: {v}"))?,
                        );
                    }
                    other => return Err(format!("unknown keep-awake option: {other}")),
                }
            }
            let parent_pid =
                parent_pid.ok_or_else(|| "keep-awake requires --parent <pid>".to_string())?;
            return Ok(FusaRunCommand::KeepAwake { parent_pid });
        }
        "acl" => {
            let action = raw_args
                .get(1)
                .map(String::as_str)
                .ok_or_else(|| "acl requires subcommand: protect-root | allow-worker | harden".to_string())?;
            let mut state_dir: Option<PathBuf> = None;
            let mut worker_id: Option<String> = None;
            let mut path: Option<PathBuf> = None;
            let mut it = raw_args[2..].iter().map(String::as_str);
            while let Some(arg) = it.next() {
                match arg {
                    "--state-dir" => state_dir = Some(PathBuf::from(next_val(&mut it, "--state-dir")?)),
                    "--worker" => worker_id = Some(next_val(&mut it, "--worker")?),
                    "--path" => path = Some(PathBuf::from(next_val(&mut it, "--path")?)),
                    other => return Err(format!("unknown acl option: {other}")),
                }
            }
            let state_dir = state_dir.ok_or_else(|| "acl requires --state-dir <dir>".to_string())?;
            let path = path.ok_or_else(|| "acl requires --path <dir>".to_string())?;
            return match action {
                "protect-root" => Ok(FusaRunCommand::AclProtectRoot { state_dir, path }),
                "allow-worker" => {
                    let worker_id =
                        worker_id.ok_or_else(|| "acl allow-worker requires --worker <id>".to_string())?;
                    Ok(FusaRunCommand::AclAllowWorker {
                        state_dir,
                        worker_id,
                        path,
                    })
                }
                "harden" => Ok(FusaRunCommand::AclHarden { state_dir, path }),
                other => Err(format!("unknown acl action: {other}")),
            };
        }
        "internal-probe-child" => {
            if raw_args.len() != 4 {
                return Err("internal-probe-child requires 3 file paths".to_string());
            }
            return Ok(FusaRunCommand::InternalProbeChild {
                denied_file: PathBuf::from(&raw_args[1]),
                allowed_file: PathBuf::from(&raw_args[2]),
                outside_file: PathBuf::from(&raw_args[3]),
            });
        }
        _ => {}
    }

    let sep = raw_args
        .iter()
        .position(|a| a == "--")
        .ok_or_else(|| "fusa-run run mode requires `-- <program> [args...]`".to_string())?;
    let head = &raw_args[..sep];
    let tail = &raw_args[sep + 1..];
    let program = tail
        .first()
        .cloned()
        .ok_or_else(|| "missing <program> after `--`".to_string())?;
    let args = tail[1..].to_vec();

    let mut sandbox_kind = "none".to_string();
    let mut state_dir: Option<PathBuf> = None;
    let mut worker_id: Option<String> = None;
    let mut readonly_fallback = false;
    let mut ctrl_pipe: Option<String> = None;
    let mut cwd: Option<PathBuf> = None;
    let mut raw_tail: Option<String> = None;

    let mut it = head.iter().map(String::as_str);
    while let Some(arg) = it.next() {
        match arg {
            "--sandbox" => sandbox_kind = next_val(&mut it, "--sandbox")?,
            "--state-dir" => state_dir = Some(PathBuf::from(next_val(&mut it, "--state-dir")?)),
            "--worker" => worker_id = Some(next_val(&mut it, "--worker")?),
            "--readonly-fallback" => readonly_fallback = true,
            "--ctrl-pipe" => ctrl_pipe = Some(next_val(&mut it, "--ctrl-pipe")?),
            "--cwd" => cwd = Some(PathBuf::from(next_val(&mut it, "--cwd")?)),
            "--raw-tail" => raw_tail = Some(next_val(&mut it, "--raw-tail")?),
            other => return Err(format!("unknown run option: {other}")),
        }
    }

    let sandbox = match sandbox_kind.as_str() {
        "none" => SandboxMode::None,
        "worker" => {
            let state_dir =
                state_dir.ok_or_else(|| "--sandbox worker requires --state-dir <dir>".to_string())?;
            if !readonly_fallback && worker_id.is_none() {
                return Err(
                    "--sandbox worker requires --worker <id> (or --readonly-fallback)".to_string(),
                );
            }
            SandboxMode::Worker {
                state_dir,
                worker_id,
                readonly_fallback,
            }
        }
        other => return Err(format!("unsupported --sandbox mode: {other}")),
    };

    Ok(FusaRunCommand::Run {
        sandbox,
        ctrl_pipe,
        cwd,
        raw_tail,
        program,
        args,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vec_s(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_worker_sandbox_and_subcommands() {
        let cmd = parse_fusa_run_args(&vec_s(&[
            "--sandbox",
            "worker",
            "--state-dir",
            "C:\\Users\\u\\.agent-hub\\state",
            "--worker",
            "524",
            "--ctrl-pipe",
            "\\\\.\\pipe\\fusa-ctrl-1",
            "--",
            "C:\\Program Files\\nodejs\\node.exe",
            "cli.js",
            "--flag",
        ]))
        .expect("parse run");
        assert_eq!(
            cmd,
            FusaRunCommand::Run {
                sandbox: SandboxMode::Worker {
                    state_dir: PathBuf::from("C:\\Users\\u\\.agent-hub\\state"),
                    worker_id: Some("524".to_string()),
                    readonly_fallback: false,
                },
                ctrl_pipe: Some("\\\\.\\pipe\\fusa-ctrl-1".to_string()),
                cwd: None,
                raw_tail: None,
                program: "C:\\Program Files\\nodejs\\node.exe".to_string(),
                args: vec_s(&["cli.js", "--flag"]),
            }
        );

        let ro = parse_fusa_run_args(&vec_s(&[
            "--sandbox",
            "worker",
            "--state-dir",
            "C:\\state",
            "--readonly-fallback",
            "--",
            "agy.exe",
        ]))
        .expect("parse readonly fallback");
        assert!(matches!(
            ro,
            FusaRunCommand::Run {
                sandbox: SandboxMode::Worker {
                    readonly_fallback: true,
                    worker_id: None,
                    ..
                },
                ..
            }
        ));

        assert_eq!(
            parse_fusa_run_args(&vec_s(&["inspect", "--pid", "4321"])).expect("inspect"),
            FusaRunCommand::Inspect { pid: 4321 }
        );
    }
}
