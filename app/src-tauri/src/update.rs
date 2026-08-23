//! Self-update for a portable build.
//!
//! Tauri's own updater is deliberately not used, and this is not a preference. On Windows it
//! does not replace the running binary: it downloads an NSIS or MSI installer, runs it, and
//! exits. That installer picks its target by reading `HKCU\Software\<Manufacturer>\<Product>`
//! and falls back to `%LOCALAPPDATA%` when the key is missing — which it always is for a
//! folder that was never installed. Clicking "update" in a portable PrivateCode would
//! therefore produce a SECOND, installed copy somewhere else while the folder you are running
//! stays on the old version. There is no configuration that avoids that.
//!
//! So the swap is done here, and it rests on one fact about Windows: a running `.exe` cannot
//! be overwritten or deleted, but it CAN be renamed within the same volume. Every self-updater
//! on this platform is built on that.
//!
//! The sequence, and why each step is where it is:
//!
//!   1. fetch the manifest, compare versions — cheap, and the only step that runs unattended
//!   2. download only the parts whose SHA-256 differs from what is on disk. The sidecar is
//!      368 MB of pinned binaries that change maybe twice a year; the app is ~3 MB and changes
//!      daily, so a routine update moves 3 MB rather than 380
//!   3. verify every downloaded byte against the manifest hash BEFORE anything on disk moves
//!   4. stage the new files beside the old ones, still not touching what is running
//!   5. rename the running exe out of the way, move the new one in, relaunch, exit
//!
//! Step 5 is the only irreversible one, and it happens last, after everything that can fail
//! has already succeeded. If the app dies between the rename and the relaunch, the old binary
//! is still on disk under `PrivateCode.old.exe` and the next launch cleans it up.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

/// Where the manifest lives. A GitHub release asset on a public repository, so no token, no
/// header and no account are involved — the reason the repository is public at all.
const MANIFEST_URL: &str =
    "https://github.com/yohasacura/privatecode/releases/latest/download/latest.json";

/// One downloadable part of a release.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Part {
    pub file: String,
    /// Of the ARCHIVE, checked against the downloaded bytes before anything is swapped.
    pub sha256: String,
    pub bytes: u64,
    /// The sidecar part only: its input-derived identity. See `sidecar_identity`.
    #[serde(default)]
    pub tree: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Manifest {
    pub version: String,
    pub app: Part,
    pub sidecar: Part,
}

/// What the window is told. `download_bytes` is what this update would actually cost, which is
/// the number a person wants before agreeing to it — not the size of the release.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateCheck {
    pub available: bool,
    pub current_version: String,
    pub new_version: String,
    pub download_bytes: u64,
    pub notes_url: String,
}

fn base_url() -> String {
    "https://github.com/yohasacura/privatecode/releases/latest/download".to_string()
}

/// The directory the running executable sits in — the portable folder itself.
fn install_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    exe.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "executable has no parent directory".to_string())
}

/// Which sidecar this folder has, read from the marker the packager wrote into it.
///
/// Read rather than computed, and that is the whole point. Hashing the tree was the first
/// design and it was wrong: `dotnet publish` of a self-contained single file is not
/// byte-reproducible, so the same sources hash differently on every build — caught by
/// comparing a CI build against a local one. Every release would then have looked like a new
/// sidecar and every update would have pulled 120 MB instead of 3, which is exactly what
/// splitting the payload was for.
///
/// So `package-release.mjs` computes the identity from the pinned INPUTS (each vendor
/// PROVENANCE.md plus the source of the two .NET helpers) and writes it to `sidecar/.identity`.
/// A folder with no marker is one from before this existed, or a hand-assembled one: it reads
/// as "unknown", which makes the next update fetch the sidecar once and leave a marker behind.
fn sidecar_identity(dir: &Path) -> Option<String> {
    fs::read_to_string(dir.join(".identity"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

async fn get(url: &str) -> Result<Vec<u8>, String> {
    let res = reqwest::get(url).await.map_err(|e| format!("{url}: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("{url}: HTTP {}", res.status()));
    }
    Ok(res.bytes().await.map_err(|e| e.to_string())?.to_vec())
}

async fn manifest() -> Result<Manifest, String> {
    let body = get(MANIFEST_URL).await?;
    serde_json::from_slice(&body).map_err(|e| format!("manifest is not readable: {e}"))
}

/// Split a dotted numeric version. `None` for anything else, including an empty string.
fn version_parts(v: &str) -> Option<Vec<u64>> {
    let parts: Option<Vec<u64>> = v.split('.').map(|p| p.parse::<u64>().ok()).collect();
    parts.filter(|p| !p.is_empty())
}

/// Is the release LATER than what is running?
///
/// This was `m.version != current`, which is wrong in one direction: a build newer than the
/// latest release is told that an older one "is available", and taking it moves backwards.
/// That is not hypothetical — it happens to anyone running a local build, and to everyone
/// running the current release for as long as a bad one stays yanked. Observed while checking
/// this very change: a locally built 0.1.2 offered to update itself to the released 0.1.1.
///
/// Compared as numbers, not as strings, because `"0.10.0" < "0.9.0"` lexically. Shorter wins
/// against its own prefix (`0.1` is older than `0.1.1`) because `Vec` compares element by
/// element and then by length.
///
/// Anything that does not parse falls back to "different means newer" — the old behaviour,
/// and the conservative one for a manifest this app did not write.
fn is_newer(candidate: &str, current: &str) -> bool {
    match (version_parts(candidate), version_parts(current)) {
        (Some(a), Some(b)) => a > b,
        _ => candidate != current,
    }
}

/// Is there a newer release, and what would it cost to take it?
///
/// Deliberately says nothing and changes nothing when it cannot reach GitHub: an offline tool
/// whose whole point is that it needs no network must not announce a problem because a check
/// nobody asked for failed.
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<UpdateCheck, String> {
    let current = app.package_info().version.to_string();
    let m = manifest().await?;

    let dir = install_dir()?;
    let sidecar_dir = dir.join("sidecar");
    let have_sidecar = sidecar_identity(&sidecar_dir);

    // What this update would actually download: the app always, the sidecar only when the
    // pinned binaries moved.
    let mut bytes = m.app.bytes;
    if have_sidecar.as_deref() != Some(m.sidecar.tree.as_str()) {
        bytes += m.sidecar.bytes;
    }

    Ok(UpdateCheck {
        available: is_newer(&m.version, &current),
        current_version: current,
        new_version: m.version,
        download_bytes: bytes,
        notes_url: "https://github.com/yohasacura/privatecode/releases/latest".to_string(),
    })
}

fn unzip(archive: &Path, into: &Path) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    zip.extract(into).map_err(|e| e.to_string())
}

/// Download, verify, stage, swap, relaunch.
///
/// Everything that can fail happens before anything on disk is disturbed. The function only
/// returns on failure; on success the process replaces itself and exits.
#[tauri::command]
pub async fn apply_update(app: AppHandle) -> Result<(), String> {
    let m = manifest().await?;
    let dir = install_dir()?;
    let staging = dir.join(".update-staging");
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;

    // --- download and verify, touching nothing that is running ---------------------------
    let sidecar_dir = dir.join("sidecar");
    let need_sidecar = sidecar_identity(&sidecar_dir).as_deref() != Some(m.sidecar.tree.as_str());

    for part in std::iter::once(&m.app).chain(need_sidecar.then_some(&m.sidecar)) {
        let url = format!("{}/{}", base_url(), part.file);
        let bytes = get(&url).await?;
        let got = format!("{:x}", Sha256::digest(&bytes));
        if got != part.sha256 {
            return Err(format!(
                "{}: downloaded bytes do not match the manifest\n  expected {}\n  got      {got}",
                part.file, part.sha256,
            ));
        }
        let path = staging.join(&part.file);
        let mut f = fs::File::create(&path).map_err(|e| e.to_string())?;
        f.write_all(&bytes).map_err(|e| e.to_string())?;
        drop(f);
        unzip(&path, &staging)?;
        fs::remove_file(&path).ok();
    }

    // --- swap ------------------------------------------------------------------------------
    // The running exe cannot be overwritten, but it can be renamed. Everything above has
    // already succeeded by the time this line runs.
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let old = exe.with_extension("old.exe");
    let _ = fs::remove_file(&old);
    fs::rename(&exe, &old).map_err(|e| format!("could not move the running app aside: {e}"))?;

    let staged_exe = staging.join(
        exe.file_name()
            .ok_or("executable has no file name")?,
    );
    if let Err(e) = fs::rename(&staged_exe, &exe) {
        // Put it back rather than leaving a folder with no executable in it.
        let _ = fs::rename(&old, &exe);
        return Err(format!("could not move the new app into place: {e}"));
    }

    if need_sidecar {
        let staged_sidecar = staging.join("sidecar");
        if staged_sidecar.exists() {
            let retired = dir.join(".sidecar.old");
            let _ = fs::remove_dir_all(&retired);
            let _ = fs::rename(&sidecar_dir, &retired);
            fs::rename(&staged_sidecar, &sidecar_dir)
                .map_err(|e| format!("could not move the new sidecar into place: {e}"))?;
            let _ = fs::remove_dir_all(&retired);
        }
    } else {
        // The app archive carries agent.cjs, which belongs inside the existing sidecar tree.
        let staged_agent = staging.join("sidecar").join("agent.cjs");
        if staged_agent.exists() {
            fs::copy(&staged_agent, sidecar_dir.join("agent.cjs")).map_err(|e| e.to_string())?;
        }
    }

    let _ = fs::remove_dir_all(&staging);
    relaunch_and_leave(&app, &exe)
}

/// Start the replacement and go — without asking Tauri to arrange it.
///
/// `AppHandle::restart()` is the obvious call and it does not finish the job from here.
/// `apply_update` is an async command, so it runs on a worker thread, and off the main thread
/// `restart` only REQUESTS an exit and then parks the calling thread forever, leaving the
/// event loop to spawn the replacement and call `std::process::exit(0)`.
///
/// Measured against the real 0.1.0 → 0.1.1 release rather than reasoned about: the
/// replacement started correctly and the old process never left. It sat minimised off-screen
/// at (-32000, -32000), still answering, which meant two agents were live against one
/// workspace — and it held `PrivateCode.old.exe` open, so `clean_previous_update` on the next
/// launch could not delete it and every update would leave another 12 MB behind. Proved by
/// killing that process by hand: the file deleted immediately afterwards, so it was the thing
/// holding it.
///
/// `exit(0)` is where it stops. On Windows that abruptly terminates every other thread and
/// then runs DLL detach and the CRT's atexit chain; WebView2 keeps a large number of COM
/// threads, and one terminated while holding the loader lock deadlocks the teardown.
///
/// So the sidecar is shut down explicitly first — the graceful path, which the `RunEvent::Exit`
/// handler will no longer get to run — and then the process is ended with `TerminateProcess`,
/// which skips the teardown entirely.
///
/// That is safe here for a specific reason and not a general one: the sidecar and everything
/// it starts live in a kill-on-close job object (see `job.rs`), and the kernel closes the last
/// handle to that job when this process dies BY ANY MEANS. Verified, not assumed — the
/// leftover process was terminated by hand and its `node.exe` went with it.
fn relaunch_and_leave(app: &AppHandle, exe: &Path) -> ! {
    // Before the new process starts, so the two are never both talking to the same
    // `.privatecode/` at once.
    crate::shutdown_sidecar(&app.state::<crate::SidecarState>());

    if let Err(e) = std::process::Command::new(exe).spawn() {
        // Nothing left to report to: the window is about to go. The old binary is still on
        // disk under `.old.exe`, so the folder is not left without a working app.
        eprintln!("update: could not start the new version: {e}");
    }
    // SAFETY: ends this process and nothing else. The job object above owns the child
    // processes and the kernel releases it as part of our death.
    unsafe { winexit::TerminateProcess(winexit::GetCurrentProcess(), 0) };
    // TerminateProcess does not return for the current process, but it is not typed `!`.
    std::process::exit(0)
}

mod winexit {
    use std::ffi::c_void;

    // Declared rather than pulled in with the `windows` crate, matching `job.rs`: two
    // functions against a dependency larger than the app itself.
    extern "system" {
        pub fn GetCurrentProcess() -> *mut c_void;
        pub fn TerminateProcess(process: *mut c_void, exit_code: u32) -> i32;
    }
}

/// Removes the binary the previous update renamed aside. Called once at startup, when nothing
/// holds it open any more. Failure is ignored: a leftover file is untidy, not broken.
pub fn clean_previous_update() {
    if let Ok(exe) = std::env::current_exe() {
        let _ = fs::remove_file(exe.with_extension("old.exe"));
        if let Some(dir) = exe.parent() {
            let _ = fs::remove_dir_all(dir.join(".sidecar.old"));
            let _ = fs::remove_dir_all(dir.join(".update-staging"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::is_newer;

    #[test]
    fn only_a_later_release_counts_as_available() {
        assert!(is_newer("0.1.2", "0.1.1"));
        assert!(is_newer("0.2.0", "0.1.9"));
        assert!(is_newer("1.0.0", "0.99.99"));
        assert!(!is_newer("0.1.1", "0.1.1"));
    }

    #[test]
    fn an_older_release_is_not_offered() {
        // The bug this replaced: a locally built 0.1.2 was told the released 0.1.1 "is
        // available", and clicking would have moved it backwards.
        assert!(!is_newer("0.1.1", "0.1.2"));
        assert!(!is_newer("0.9.0", "1.0.0"));
    }

    #[test]
    fn compared_as_numbers_rather_than_as_text() {
        // The whole reason not to use string ordering: "0.10.0" < "0.9.0" lexically.
        assert!(is_newer("0.10.0", "0.9.0"));
        assert!(!is_newer("0.9.0", "0.10.0"));
    }

    #[test]
    fn a_prefix_is_older_than_what_extends_it() {
        assert!(is_newer("0.1.1", "0.1"));
        assert!(!is_newer("0.1", "0.1.1"));
    }

    #[test]
    fn anything_unparseable_falls_back_to_difference() {
        // A manifest this app did not write. Refusing to offer anything at all would make a
        // future versioning scheme silently un-updatable; "different means newer" is what
        // the code did before and it is the safe direction here.
        assert!(is_newer("2026-08-24", "0.1.1"));
        assert!(!is_newer("0.1.1-rc1", "0.1.1-rc1"));
    }
}
