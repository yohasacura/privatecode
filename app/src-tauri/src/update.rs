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
use tauri::AppHandle;

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
        available: m.version != current,
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
    app.restart();
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
