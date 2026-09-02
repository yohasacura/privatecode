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
//!
//! Every step above reports itself to the window as an `update-progress` event, and a
//! download reports as it streams. The first version did none of that: it pulled the whole
//! archive into memory, verified, unpacked and swapped inside one silent command, so the
//! banner said "Downloading…" for the whole of a 4–125 MB transfer, then the window simply
//! vanished. What the person saw was a freeze and a flash — reported as "works, but it is
//! jerky" — and it was, because nothing between the click and the new window was visible.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

/// Where the manifest lives. A GitHub release asset on a public repository, so no token, no
/// header and no account are involved — the reason the repository is public at all.
const MANIFEST_URL: &str =
    "https://github.com/yohasacura/privatecode/releases/latest/download/latest.json";

/// The event the window listens to while an update runs. See `UpdateProgress`.
const PROGRESS_EVENT: &str = "update-progress";

/// The note the outgoing version leaves for the incoming one. See `write_updated_from`.
const UPDATED_FROM_MARKER: &str = ".updated-from";

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

/// Where an update has got to, for the window.
///
/// `phase` is one of `manifest`, `downloading`, `verifying`, `unpacking`, `installing`,
/// `restarting`, in that order. While `downloading`, `part` names the archive and
/// `received`/`total` count its bytes; the other phases carry zeros, because they take
/// under a second each and a bar for them would only flicker.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateProgress {
    pub phase: &'static str,
    pub part: Option<String>,
    pub received: u64,
    pub total: u64,
}

/// What the window asks at startup: did the previous process update into this one?
#[derive(Debug, Clone, Serialize)]
pub struct UpdateStartupInfo {
    pub current_version: String,
    /// The version that ran the update, or `None` for an ordinary launch.
    pub updated_from: Option<String>,
}

fn base_url() -> String {
    "https://github.com/yohasacura/privatecode/releases/latest/download".to_string()
}

/// The page for ONE release, not `/releases/latest`: by the time a person clicks the link the
/// latest may already be a different release than the one the banner named.
fn notes_url_for(version: &str) -> String {
    format!("https://github.com/yohasacura/privatecode/releases/tag/v{version}")
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

/// How long a connection may take to open, and how long a transfer may go SILENT.
///
/// A read timeout rather than a whole-request one: the sidecar is 120 MB and a slow link is
/// allowed to take its time, but a link that has stopped delivering must end in an error the
/// strip can show with its "try again" — not in a bar frozen at 61% until the socket dies of
/// natural causes, which is what an un-timed `reqwest::get` gave.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const READ_TIMEOUT: Duration = Duration::from_secs(60);

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .build()
        .map_err(|e| format!("could not set up the download: {e}"))
}

async fn get(url: &str) -> Result<Vec<u8>, String> {
    let res = client()?.get(url).send().await.map_err(|e| format!("{url}: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("{url}: HTTP {}", res.status()));
    }
    Ok(res.bytes().await.map_err(|e| e.to_string())?.to_vec())
}

/// Free bytes on the volume that holds `dir`, or `None` where the question cannot be asked.
#[cfg(windows)]
fn free_space(dir: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    let mut wide: Vec<u16> = dir.as_os_str().encode_wide().collect();
    wide.push(0);
    let mut free_to_caller: u64 = 0;
    let mut total: u64 = 0;
    let mut free: u64 = 0;
    // SAFETY: a NUL-terminated wide string and three out-pointers to locals, exactly what
    // the call documents; nothing is retained past the call.
    let ok = unsafe {
        windisk::GetDiskFreeSpaceExW(wide.as_ptr(), &mut free_to_caller, &mut total, &mut free)
    };
    (ok != 0).then_some(free_to_caller)
}

#[cfg(not(windows))]
fn free_space(_dir: &Path) -> Option<u64> {
    None
}

#[cfg(windows)]
mod windisk {
    // Declared rather than pulled in with the `windows` crate — see `winexit` below.
    extern "system" {
        pub fn GetDiskFreeSpaceExW(
            directory: *const u16,
            free_bytes_available_to_caller: *mut u64,
            total_number_of_bytes: *mut u64,
            total_number_of_free_bytes: *mut u64,
        ) -> i32;
    }
}

/// What an update of `download` bytes needs on disk: the archives, their unpacked contents
/// (about three times the archive for the sidecar's self-contained binaries, so three is used
/// for everything) and room to breathe. Generous on purpose — the failure this prevents is an
/// IO error halfway through an unpack, which reads as corruption, not as a full disk.
pub fn space_needed(download: u64) -> u64 {
    download.saturating_mul(4).saturating_add(64 * 1024 * 1024)
}

/// The refusal, worded for the person who has to free the space.
pub fn space_shortfall(free: u64, needed: u64) -> Option<String> {
    if free >= needed {
        return None;
    }
    let mb = |b: u64| b / (1024 * 1024);
    Some(format!(
        "not enough free space for the update: {} MB free, about {} MB needed",
        mb(free),
        mb(needed),
    ))
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
        notes_url: notes_url_for(&m.version),
        new_version: m.version,
        download_bytes: bytes,
    })
}

/// Did the previous process update into this one? Answered once: the note is consumed.
#[tauri::command]
pub fn update_startup_info(app: AppHandle) -> UpdateStartupInfo {
    UpdateStartupInfo {
        current_version: app.package_info().version.to_string(),
        updated_from: install_dir().ok().and_then(|dir| take_updated_from(&dir)),
    }
}

/// Tell the window. Never fails: a window that cannot hear about progress still gets the
/// update, and a window that has already gone does not need to.
fn report(app: &AppHandle, phase: &'static str, part: Option<&str>, received: u64, total: u64) {
    let _ = app.emit(
        PROGRESS_EVENT,
        UpdateProgress { phase, part: part.map(str::to_string), received, total },
    );
}

/// Which readings of a download are worth an event.
///
/// A 125 MB archive arrives in tens of thousands of chunks, and an event per chunk would
/// spend more on the window than on the download. One per percent, or one per 150 ms when the
/// link is slow enough that a percent takes longer than that — and always the last one, so
/// the bar reaches its end before the phase changes. Pure, so it can be tested.
pub struct ProgressGate {
    last_at: Option<Instant>,
    last_fraction: f64,
}

impl ProgressGate {
    const MIN_INTERVAL: Duration = Duration::from_millis(150);
    const MIN_STEP: f64 = 0.01;

    pub fn new() -> Self {
        Self { last_at: None, last_fraction: -1.0 }
    }

    pub fn due(&mut self, now: Instant, received: u64, total: u64) -> bool {
        let fraction = if total == 0 { 0.0 } else { received as f64 / total as f64 };
        let first = self.last_at.is_none();
        let finished = total > 0 && received >= total;
        // With no total there is no percent to step by, and the clock alone decides.
        let stepped = total == 0 || fraction - self.last_fraction >= Self::MIN_STEP;
        let waited = self
            .last_at
            .map(|t| now.duration_since(t) >= Self::MIN_INTERVAL)
            .unwrap_or(true);
        if first || finished || (stepped && waited) {
            self.last_at = Some(now);
            self.last_fraction = fraction;
            return true;
        }
        false
    }
}

/// Stream one archive to disk, hashing as it arrives, reporting as it goes.
///
/// To disk rather than into memory: the sidecar is 120 MB, and holding it whole was the
/// first version's way of having nothing to report until it was over. The hash is finished
/// before the file is trusted, and a short read — the transfer ending early — is a failure by
/// count before it is one by hash, so the message can say which.
async fn download_to(
    app: &AppHandle, url: &str, into: &Path, part: &Part,
) -> Result<(), String> {
    let mut res = client()?.get(url).send().await.map_err(|e| format!("{url}: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("{url}: HTTP {}", res.status()));
    }
    let total = res.content_length().unwrap_or(part.bytes);
    let mut file = fs::File::create(into).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut gate = ProgressGate::new();
    report(app, "downloading", Some(&part.file), 0, total);
    while let Some(chunk) = res.chunk().await.map_err(|e| format!("{}: {e}", part.file))? {
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        hasher.update(&chunk);
        received += chunk.len() as u64;
        if gate.due(Instant::now(), received, total) {
            report(app, "downloading", Some(&part.file), received, total);
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);

    report(app, "verifying", Some(&part.file), 0, 0);
    if received != part.bytes {
        return Err(format!(
            "{}: the download ended early — {} of {} bytes arrived",
            part.file, received, part.bytes,
        ));
    }
    let got = format!("{:x}", hasher.finalize());
    if got != part.sha256 {
        return Err(format!(
            "{}: downloaded bytes do not match the manifest\n  expected {}\n  got      {got}",
            part.file, part.sha256,
        ));
    }
    Ok(())
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
    report(&app, "manifest", None, 0, 0);
    let m = manifest().await?;
    let current = app.package_info().version.to_string();
    let dir = install_dir()?;
    let staging = dir.join(".update-staging");
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;

    // --- download and verify, touching nothing that is running ---------------------------
    let sidecar_dir = dir.join("sidecar");
    let need_sidecar = sidecar_identity(&sidecar_dir).as_deref() != Some(m.sidecar.tree.as_str());

    // Room first. An unpack that runs out of disk halfway fails with an IO error that reads
    // as corruption; the same fact asked up front reads as what it is.
    let download = m.app.bytes.saturating_add(if need_sidecar { m.sidecar.bytes } else { 0 });
    if let Some(free) = free_space(&dir) {
        if let Some(shortfall) = space_shortfall(free, space_needed(download)) {
            let _ = fs::remove_dir_all(&staging);
            return Err(shortfall);
        }
    }

    for part in std::iter::once(&m.app).chain(need_sidecar.then_some(&m.sidecar)) {
        let url = format!("{}/{}", base_url(), part.file);
        let path = staging.join(&part.file);
        download_to(&app, &url, &path, part).await?;
        report(&app, "unpacking", Some(&part.file), 0, 0);
        unzip(&path, &staging)?;
        fs::remove_file(&path).ok();
    }

    // --- swap ------------------------------------------------------------------------------
    // The running exe cannot be overwritten, but it can be renamed. Everything above has
    // already succeeded by the time this line runs.
    report(&app, "installing", None, 0, 0);
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    install(&dir, &exe, &staging, need_sidecar)?;

    let _ = fs::remove_dir_all(&staging);
    // The note the next process announces itself with. Best effort: a launch with no note is
    // an ordinary launch, which is the worse of two harmless outcomes.
    write_updated_from(&dir, &current);
    report(&app, "restarting", None, 0, 0);
    // Before the new process starts, so the two are never both talking to the same
    // `.privatecode/` at once.
    crate::shutdown_sidecar(&app.state::<crate::SidecarState>());
    relaunch_and_leave(&exe)
}

/// The swap itself, as one step with one undo.
///
/// The running exe is renamed aside and the staged one moved in; then either the whole
/// sidecar tree is replaced (when the pinned binaries moved) or only `agent.cjs` inside it.
/// Any failure after the first rename puts EVERYTHING back — the old sidecar under its own
/// name, the old exe under its — because the first version undid only the exe step: a
/// sidecar move that failed after the old tree had been renamed away returned an error and
/// left the folder with a new exe and no sidecar at all, so the next launch had no agent.
/// Pure over paths, so it can be exercised on a scratch folder where nothing is running.
fn install(dir: &Path, exe: &Path, staging: &Path, need_sidecar: bool) -> Result<(), String> {
    install_with(dir, exe, staging, need_sidecar, &|from, to| fs::rename(from, to))
}

/// `install` over an injectable move, so the undo can be exercised: a rename that fails on
/// demand is the only honest way to reach the rollback on a machine where every real rename
/// succeeds. Production passes `fs::rename`.
fn install_with(
    dir: &Path,
    exe: &Path,
    staging: &Path,
    need_sidecar: bool,
    mv: &dyn Fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), String> {
    let old = exe.with_extension("old.exe");
    let _ = fs::remove_file(&old);
    mv(exe, &old).map_err(|e| format!("could not move the running app aside: {e}"))?;

    let staged_exe = staging.join(exe.file_name().ok_or("executable has no file name")?);
    if let Err(e) = mv(&staged_exe, exe) {
        // Put it back rather than leaving a folder with no executable in it.
        let _ = mv(&old, exe);
        return Err(format!("could not move the new app into place: {e}"));
    }
    let undo_exe = || {
        let _ = fs::remove_file(exe);
        let _ = mv(&old, exe);
    };

    let sidecar_dir = dir.join("sidecar");
    if need_sidecar {
        let staged_sidecar = staging.join("sidecar");
        if staged_sidecar.exists() {
            let retired = dir.join(".sidecar.old");
            let _ = fs::remove_dir_all(&retired);
            let had_sidecar = sidecar_dir.exists();
            if had_sidecar {
                if let Err(e) = mv(&sidecar_dir, &retired) {
                    undo_exe();
                    return Err(format!("could not move the old sidecar aside: {e}"));
                }
            }
            if let Err(e) = mv(&staged_sidecar, &sidecar_dir) {
                if had_sidecar {
                    let _ = mv(&retired, &sidecar_dir);
                }
                undo_exe();
                return Err(format!("could not move the new sidecar into place: {e}"));
            }
            let _ = fs::remove_dir_all(&retired);
        }
    } else {
        // The app archive carries agent.cjs, which belongs inside the existing sidecar tree.
        let staged_agent = staging.join("sidecar").join("agent.cjs");
        if staged_agent.exists() {
            if let Err(e) = fs::copy(&staged_agent, sidecar_dir.join("agent.cjs")) {
                undo_exe();
                return Err(format!("could not install the new agent: {e}"));
            }
        }
    }
    Ok(())
}

/// The outgoing version leaves its number beside the new binary, so the process that starts
/// next can say "updated to 0.3.0 from 0.2.0" instead of appearing out of nowhere. A file
/// rather than a command-line flag because the flag would survive into a launch that had
/// nothing to do with an update — a shortcut copied while it was there — and a file is read
/// once and gone.
pub fn write_updated_from(dir: &Path, version: &str) -> bool {
    fs::write(dir.join(UPDATED_FROM_MARKER), format!("{version}\n")).is_ok()
}

/// Read the note and remove it, so it is announced exactly once.
pub fn take_updated_from(dir: &Path) -> Option<String> {
    let path = dir.join(UPDATED_FROM_MARKER);
    let text = fs::read_to_string(&path).ok()?;
    let _ = fs::remove_file(&path);
    let version = text.trim().to_string();
    if version.is_empty() { None } else { Some(version) }
}

/// The erase path's entry point: the sidecar is already down by the time it is called, since
/// the files it was holding had to go first.
pub fn relaunch_and_leave_without_sidecar(_app: &AppHandle) -> ! {
    match std::env::current_exe() {
        Ok(exe) => relaunch_and_leave(&exe),
        Err(e) => {
            eprintln!("erase: could not find our own executable to restart: {e}");
            std::process::exit(0)
        }
    }
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
fn relaunch_and_leave(exe: &Path) -> ! {
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
    use super::{
        install, install_with, is_newer, notes_url_for, space_needed, space_shortfall,
        take_updated_from, write_updated_from, ProgressGate,
    };
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    /// A scratch portable folder: an "exe", a sidecar with an agent and a binary, and a
    /// staging area holding the new exe and whatever else the test wants in it.
    fn scratch(name: &str, staged_sidecar: bool) -> (PathBuf, PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("pc-install-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sidecar")).unwrap();
        fs::write(dir.join("PrivateCode.exe"), "old exe").unwrap();
        fs::write(dir.join("sidecar").join("agent.cjs"), "old agent").unwrap();
        fs::write(dir.join("sidecar").join("node.exe"), "old node").unwrap();
        let staging = dir.join(".update-staging");
        fs::create_dir_all(staging.join("sidecar")).unwrap();
        fs::write(staging.join("PrivateCode.exe"), "new exe").unwrap();
        fs::write(staging.join("sidecar").join("agent.cjs"), "new agent").unwrap();
        if staged_sidecar {
            fs::write(staging.join("sidecar").join("node.exe"), "new node").unwrap();
            fs::write(staging.join("sidecar").join(".identity"), "abc").unwrap();
        }
        (dir.clone(), dir.join("PrivateCode.exe"), staging)
    }

    fn read(p: &Path) -> String {
        fs::read_to_string(p).unwrap_or_default()
    }

    #[test]
    fn an_app_only_update_swaps_the_exe_and_the_agent_and_nothing_else() {
        let (dir, exe, staging) = scratch("app-only", false);
        install(&dir, &exe, &staging, false).unwrap();
        assert_eq!(read(&exe), "new exe");
        assert_eq!(read(&dir.join("PrivateCode.old.exe")), "old exe");
        assert_eq!(read(&dir.join("sidecar").join("agent.cjs")), "new agent");
        assert_eq!(read(&dir.join("sidecar").join("node.exe")), "old node");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_sidecar_update_replaces_the_whole_tree() {
        let (dir, exe, staging) = scratch("sidecar", true);
        install(&dir, &exe, &staging, true).unwrap();
        assert_eq!(read(&exe), "new exe");
        assert_eq!(read(&dir.join("sidecar").join("node.exe")), "new node");
        assert_eq!(read(&dir.join("sidecar").join("agent.cjs")), "new agent");
        assert_eq!(read(&dir.join("sidecar").join(".identity")), "abc");
        assert!(!dir.join(".sidecar.old").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_sidecar_move_that_fails_puts_the_exe_and_the_old_sidecar_back() {
        let (dir, exe, staging) = scratch("rollback", true);
        // The move of the NEW sidecar into place fails — the old tree has already been moved
        // aside by then, and the exe has already been swapped. The install must leave the
        // folder as it found it, not exe-new/sidecar-gone, which is what the first version
        // did here: it undid only the exe step.
        let staged_sidecar = staging.join("sidecar");
        let failing = |from: &Path, to: &Path| -> std::io::Result<()> {
            if from == staged_sidecar {
                return Err(std::io::Error::other("simulated: the new sidecar could not be moved"));
            }
            fs::rename(from, to)
        };
        let err = install_with(&dir, &exe, &staging, true, &failing).unwrap_err();
        assert!(err.contains("new sidecar"), "{err}");
        assert_eq!(read(&exe), "old exe");
        assert_eq!(read(&dir.join("sidecar").join("node.exe")), "old node");
        assert_eq!(read(&dir.join("sidecar").join("agent.cjs")), "old agent");
        assert!(!dir.join("PrivateCode.old.exe").exists());
        assert!(!dir.join(".sidecar.old").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_old_sidecar_that_cannot_be_moved_aside_stops_the_install_with_the_exe_put_back() {
        let (dir, exe, staging) = scratch("rollback-aside", true);
        let sidecar_dir = dir.join("sidecar");
        let failing = |from: &Path, to: &Path| -> std::io::Result<()> {
            if from == sidecar_dir {
                return Err(std::io::Error::other("simulated: the old sidecar is held open"));
            }
            fs::rename(from, to)
        };
        let err = install_with(&dir, &exe, &staging, true, &failing).unwrap_err();
        assert!(err.contains("old sidecar"), "{err}");
        assert_eq!(read(&exe), "old exe");
        assert_eq!(read(&dir.join("sidecar").join("node.exe")), "old node");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_space_check_is_generous_and_says_the_numbers() {
        let mb = 1024 * 1024;
        assert_eq!(space_needed(100 * mb), 464 * mb);
        assert_eq!(space_shortfall(500 * mb, 464 * mb), None);
        let msg = space_shortfall(120 * mb, 464 * mb).unwrap();
        assert!(msg.contains("120 MB free"), "{msg}");
        assert!(msg.contains("464 MB needed"), "{msg}");
    }

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

    #[test]
    fn the_notes_link_names_the_release_the_banner_named() {
        assert_eq!(notes_url_for("0.3.0"), "https://github.com/yohasacura/privatecode/releases/tag/v0.3.0");
    }

    #[test]
    fn progress_is_reported_per_percent_and_always_at_the_end() {
        let mut gate = ProgressGate::new();
        let t0 = Instant::now();
        let total = 10_000;
        // The first reading always goes out, so the bar appears at once.
        assert!(gate.due(t0, 0, total));
        // Fifty bytes later is half a percent, and the interval has not passed either.
        assert!(!gate.due(t0 + Duration::from_millis(1), 50, total));
        // A whole percent, but the interval has not passed: still held.
        assert!(!gate.due(t0 + Duration::from_millis(10), 100, total));
        // A percent AND the interval: reported.
        assert!(gate.due(t0 + Duration::from_millis(200), 100, total));
        // The end is always reported, whatever the clock says.
        assert!(gate.due(t0 + Duration::from_millis(201), total, total));
    }

    #[test]
    fn a_download_of_unknown_size_still_reports_first_and_last() {
        let mut gate = ProgressGate::new();
        let t0 = Instant::now();
        assert!(gate.due(t0, 0, 0));
        // With no total there is no fraction to step, so only the clock decides.
        assert!(!gate.due(t0 + Duration::from_millis(50), 4096, 0));
        assert!(gate.due(t0 + Duration::from_millis(400), 8192, 0));
    }

    #[test]
    fn the_updated_from_note_is_read_exactly_once() {
        let dir = std::env::temp_dir().join(format!("pc-update-note-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(write_updated_from(&dir, "0.2.0"));
        assert_eq!(take_updated_from(&dir), Some("0.2.0".to_string()));
        // Consumed: a second launch is an ordinary launch.
        assert_eq!(take_updated_from(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
