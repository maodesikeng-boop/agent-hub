use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub const SANDBOX_SIDS_FILE: &str = "win-sandbox-sids.json";
pub const MAX_PERSISTED_WORKER_SIDS: usize = 1024;
/// Store-key prefix of per-session reader SIDs (`FusaRead-<key>`), kept apart from worker write SIDs.
const READER_KEY_PREFIX: &str = "read-";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SandboxSidStore {
    pub version: u32,
    pub worker_group_sid: String,
    #[serde(default)]
    pub worker_sids: BTreeMap<String, WorkerSidEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkerSidEntry {
    pub sid: String,
    pub seq: u64,
}

pub fn sids_file_path(state_dir: &Path) -> PathBuf {
    state_dir.join(SANDBOX_SIDS_FILE)
}

fn fill_random_bytes(buf: &mut [u8]) -> io::Result<()> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Security::Cryptography::{
            BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        };
        let status = unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                buf.as_mut_ptr(),
                buf.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        };
        if status != 0 {
            return Err(io::Error::other(format!("BCryptGenRandom failed: {status:#x}")));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        use std::io::Read;
        let mut f = fs::File::open("/dev/urandom")?;
        f.read_exact(buf)
    }
}

pub fn generate_random_cap_sid() -> io::Result<String> {
    let mut raw = [0u8; 16];
    fill_random_bytes(&mut raw)?;
    let a = u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]).max(1);
    let b = u32::from_le_bytes([raw[4], raw[5], raw[6], raw[7]]).max(1);
    let c = u32::from_le_bytes([raw[8], raw[9], raw[10], raw[11]]).max(1);
    let d = u32::from_le_bytes([raw[12], raw[13], raw[14], raw[15]]).max(1);
    Ok(format!("S-1-5-21-{a}-{b}-{c}-{d}"))
}

pub fn is_valid_cap_sid_syntax(sid: &str) -> bool {
    let mut parts = sid.split('-');
    if parts.next() != Some("S")
        || parts.next() != Some("1")
        || parts.next() != Some("5")
        || parts.next() != Some("21")
    {
        return false;
    }
    let mut count = 0usize;
    for sub in parts {
        if sub.parse::<u32>().is_err() {
            return false;
        }
        count += 1;
    }
    count == 4
}

fn persist_store(state_dir: &Path, store: &SandboxSidStore) -> io::Result<()> {
    fs::create_dir_all(state_dir)?;
    let target = sids_file_path(state_dir);
    let mut nonce = [0u8; 6];
    let _ = fill_random_bytes(&mut nonce);
    let hex: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
    let tmp = state_dir.join(format!(
        ".{SANDBOX_SIDS_FILE}.{}.{hex}.tmp",
        std::process::id()
    ));
    let payload = serde_json::to_vec_pretty(store)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    fs::write(&tmp, payload)?;
    if let Err(err) = fs::rename(&tmp, &target) {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    Ok(())
}

pub fn load_or_create_sid_store(state_dir: &Path) -> io::Result<SandboxSidStore> {
    let file = sids_file_path(state_dir);
    if file.exists() {
        if let Ok(raw) = fs::read_to_string(&file) {
            if let Ok(parsed) = serde_json::from_str::<SandboxSidStore>(&raw) {
                if is_valid_cap_sid_syntax(&parsed.worker_group_sid) {
                    return Ok(parsed);
                }
            }
        }
    }
    let created = SandboxSidStore {
        version: 1,
        worker_group_sid: generate_random_cap_sid()?,
        worker_sids: BTreeMap::new(),
    };
    persist_store(state_dir, &created)?;
    Ok(created)
}

pub fn ensure_worker_sid(
    state_dir: &Path,
    worker_id: &str,
) -> io::Result<(String, String)> {
    let key = worker_id.trim();
    if key.is_empty() || key.len() > 64 || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("invalid worker id: {worker_id}"),
        ));
    }
    let mut store = load_or_create_sid_store(state_dir)?;
    if let Some(existing) = store.worker_sids.get(key) {
        if is_valid_cap_sid_syntax(&existing.sid) {
            return Ok((store.worker_group_sid, existing.sid.clone()));
        }
    }
    let next_seq = store
        .worker_sids
        .values()
        .map(|e| e.seq)
        .max()
        .unwrap_or(0)
        .saturating_add(1);
    while store.worker_sids.len() >= MAX_PERSISTED_WORKER_SIDS {
        if let Some((oldest_key, _)) = store
            .worker_sids
            .iter()
            .min_by_key(|(_, v)| v.seq)
            .map(|(k, v)| (k.clone(), v.seq))
        {
            store.worker_sids.remove(&oldest_key);
        } else {
            break;
        }
    }
    let worker_sid = generate_random_cap_sid()?;
    store.worker_sids.insert(
        key.to_string(),
        WorkerSidEntry {
            sid: worker_sid.clone(),
            seq: next_seq,
        },
    );
    persist_store(state_dir, &store)?;
    Ok((store.worker_group_sid, worker_sid))
}

/// Per-session reader SID (`FusaRead-<key>`): only ever granted read on that session's own files
/// (`acl allow-read --reader <key>`), never write, so readonly Workers can carry it too.
pub fn ensure_reader_sid(state_dir: &Path, key: &str) -> io::Result<String> {
    let (_, sid) = ensure_worker_sid(state_dir, &format!("{READER_KEY_PREFIX}{}", key.trim()))?;
    Ok(sid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persists_and_caps_worker_sids() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let (group1, w1) = ensure_worker_sid(tmp.path(), "524").expect("sid 524");
        let (group2, w1_again) = ensure_worker_sid(tmp.path(), "524").expect("sid 524 again");
        let (_, w2) = ensure_worker_sid(tmp.path(), "525").expect("sid 525");
        assert_eq!(group1, group2);
        assert_eq!(w1, w1_again);
        assert_ne!(w1, w2);
        assert!(is_valid_cap_sid_syntax(&group1));
        assert!(is_valid_cap_sid_syntax(&w1));

        for i in 0..(MAX_PERSISTED_WORKER_SIDS + 10) {
            ensure_worker_sid(tmp.path(), &format!("w{i}")).expect("cap sid");
        }
        let loaded = load_or_create_sid_store(tmp.path()).expect("load");
        assert_eq!(loaded.worker_sids.len(), MAX_PERSISTED_WORKER_SIDS);
    }

    /// Each thread opens the store on its own, the same way separate `fusa-run` processes do.
    #[test]
    fn concurrent_writers_keep_every_sid_and_one_group() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let threads: Vec<_> = (0..16)
            .map(|t| {
                let dir = tmp.path().to_path_buf();
                std::thread::spawn(move || {
                    (0..8)
                        .map(|i| {
                            let key = format!("w{t}-{i}");
                            let (group, sid) = ensure_worker_sid(&dir, &key).expect("sid");
                            (key, group, sid)
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        let issued: Vec<_> = threads
            .into_iter()
            .flat_map(|t| t.join().expect("thread"))
            .collect();
        let store = load_or_create_sid_store(tmp.path()).expect("load");
        assert_eq!(store.worker_sids.len(), issued.len());
        for (key, group, sid) in &issued {
            assert_eq!(group, &store.worker_group_sid, "group SID of {key}");
            assert_eq!(&store.worker_sids[key].sid, sid, "SID of {key}");
        }
    }

    #[test]
    fn reader_sids_are_separate_from_worker_sids() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let (_, worker) = ensure_worker_sid(tmp.path(), "7").expect("worker sid");
        let reader = ensure_reader_sid(tmp.path(), "7").expect("reader sid");
        assert_ne!(worker, reader);
        assert_eq!(reader, ensure_reader_sid(tmp.path(), "7").expect("reader sid again"));
        assert!(ensure_reader_sid(tmp.path(), "bad key").is_err());
    }
}
