use crate::cli::SandboxMode;
use crate::win::acl::{allow_worker_worktree, protect_root};
use crate::win::runner::{run_session, RunSessionSpec};
use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub fn run_internal_probe_child(
    denied_file: &Path,
    allowed_file: &Path,
    outside_file: &Path,
) -> i32 {
    if fs::write(denied_file, b"should-fail").is_ok() {
        eprintln!(
            "sandbox probe failed: write to protected directory unexpectedly succeeded: {}",
            denied_file.display()
        );
        return 10;
    }
    if let Err(err) = fs::write(allowed_file, b"ok") {
        eprintln!(
            "sandbox probe failed: write to allowed worktree directory failed ({}): {err}",
            allowed_file.display()
        );
        return 11;
    }
    if let Err(err) = fs::write(outside_file, b"ok") {
        eprintln!(
            "sandbox probe failed: write outside protected root failed ({}): {err}",
            outside_file.display()
        );
        return 12;
    }
    0
}

pub fn run_sandbox_probe(custom_state_dir: Option<&Path>) -> io::Result<()> {
    let base_tmp = env::temp_dir().join(format!(
        "fusa-win-probe-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    fs::create_dir_all(&base_tmp)?;

    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(base_tmp.clone());

    let probe_state = match custom_state_dir {
        Some(dir) => dir.to_path_buf(),
        None => base_tmp.join("state"),
    };
    let protected_dir = base_tmp.join("protected");
    let allowed_dir = protected_dir.join("worktrees").join("probe");
    let outside_dir = base_tmp.join("outside");
    fs::create_dir_all(&protected_dir)?;
    fs::create_dir_all(&outside_dir)?;

    protect_root(&probe_state, &protected_dir)?;
    allow_worker_worktree(&probe_state, "probe", &allowed_dir)?;

    let exe = env::current_exe()?;
    let exe_str = exe.to_string_lossy().into_owned();
    let denied_file = protected_dir.join("denied.txt");
    let allowed_file = allowed_dir.join("allowed.txt");
    let outside_file = outside_dir.join("outside.txt");

    let sandbox = SandboxMode::Worker {
        state_dir: probe_state,
        worker_id: Some("probe".to_string()),
        readonly_fallback: false,
    };
    let child_args = vec![
        "internal-probe-child".to_string(),
        denied_file.to_string_lossy().into_owned(),
        allowed_file.to_string_lossy().into_owned(),
        outside_file.to_string_lossy().into_owned(),
    ];
    let code = run_session(RunSessionSpec {
        sandbox: &sandbox,
        ctrl_pipe: None,
        cwd: Some(&allowed_dir),
        raw_tail: None,
        program: &exe_str,
        args: &child_args,
    })?;
    if code != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("sandbox probe child exited with code {code}"),
        ));
    }
    Ok(())
}
