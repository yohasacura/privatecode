//! Erasing everything PrivateCode has written on this machine.
//!
//! In the shell rather than in the agent, and that is not an arbitrary split. Three things
//! have to happen in one order and only this process can do them:
//!
//!   1. stop the sidecar — it holds the very state directories that are about to go, and on
//!      Windows an open handle is a delete that fails rather than a delete that waits
//!   2. delete
//!   3. relaunch, so the window comes back on the first-run screen instead of sitting on a
//!      workspace whose settings no longer exist
//!
//! The list of what goes is computed HERE, from the machine, and never accepted from the
//! window. A command that took paths from the webview and deleted them would be a
//! delete-anything primitive one bug away from reach; this one can only ever remove
//! directories it derived itself, and the derivation is three rules wide:
//!
//!   %APPDATA%\PrivateCode\        the user-scope settings, AGENTS.md, skills, ui.json
//!   %LOCALAPPDATA%\PrivateCode\   the browser profile
//!   <workspace>\.privatecode\     per project, for every workspace ui.json remembers
//!
//! The third is the one with teeth, so it is the one with the guards: the recorded workspace
//! root is never itself removed, only a child of it named exactly `.privatecode`.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// One thing that would be removed, described in the words a person can check.
#[derive(Debug, Clone, Serialize)]
pub struct EraseTarget {
    /// What it is, not where it is: "This project's data — D:\proj".
    pub label: String,
    pub path: String,
    pub bytes: u64,
    /// False for a path recorded somewhere but no longer on disk. Listed anyway, because a
    /// missing entry in a list headed "everything that will be deleted" reads as an omission.
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct EraseScan {
    pub targets: Vec<EraseTarget>,
    pub total_bytes: u64,
}

fn app_data_dir(var: &str, fallback: &[&str]) -> Option<PathBuf> {
    if let Ok(dir) = std::env::var(var) {
        if !dir.is_empty() {
            return Some(PathBuf::from(dir).join("PrivateCode"));
        }
    }
    // Same fallback shape core uses (`permissions/settings.ts`, `ui-config.ts`): a machine
    // with the variable unset still has the folder in the usual place under the profile.
    let home = std::env::var("USERPROFILE").ok()?;
    let mut path = PathBuf::from(home);
    for part in fallback {
        path.push(part);
    }
    Some(path.join("PrivateCode"))
}

/// Every workspace `ui.json` remembers, plus nothing else.
///
/// Parsed by hand rather than with a mirror of core's `UiConfig` struct: this needs one array
/// of strings out of a file another language owns, and a strict deserialize would make an
/// unrelated new field in that file turn "erase everything" into "erase nothing".
fn remembered_workspaces(app_data: &Path) -> Vec<PathBuf> {
    let Ok(text) = fs::read_to_string(app_data.join("ui.json")) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    value
        .get("recentWorkspaces")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(PathBuf::from)
                .collect()
        })
        .unwrap_or_default()
}

/// `<root>\.privatecode`, or `None` if that would not be a plain child of an absolute root.
///
/// The whole safety of the per-workspace half rests on this function. `recentWorkspaces`
/// comes out of a JSON file, and a file can say anything: the guards are that the root must
/// be absolute, that the result must still start with the root, and that the last component
/// is the literal directory name — so no entry can name the root itself, a parent, or
/// anything that is not ours.
fn private_dir_of(root: &Path) -> Option<PathBuf> {
    if !root.is_absolute() {
        return None;
    }
    let candidate = root.join(".privatecode");
    if !candidate.starts_with(root) || candidate == root {
        return None;
    }
    if candidate.file_name()? != ".privatecode" {
        return None;
    }
    Some(candidate)
}

fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    let mut total = 0;
    for entry in entries.flatten() {
        match entry.metadata() {
            Ok(meta) if meta.is_dir() => total += dir_size(&entry.path()),
            Ok(meta) => total += meta.len(),
            Err(_) => {}
        }
    }
    total
}

/// Everything that would go, in the order it would go.
fn targets() -> Vec<EraseTarget> {
    let mut out: Vec<EraseTarget> = Vec::new();
    let mut push = |label: String, path: PathBuf| {
        let exists = path.exists();
        out.push(EraseTarget {
            label,
            path: path.display().to_string(),
            bytes: if exists { dir_size(&path) } else { 0 },
            exists,
        });
    };

    let roaming = app_data_dir("APPDATA", &["AppData", "Roaming"]);
    if let Some(dir) = roaming.clone() {
        push(
            "Settings, permissions, AGENTS.md and skills".to_string(),
            dir,
        );
    }
    if let Some(dir) = app_data_dir("LOCALAPPDATA", &["AppData", "Local"]) {
        push("The browser profile".to_string(), dir);
    }
    if let Some(roaming) = roaming {
        for root in remembered_workspaces(&roaming) {
            if let Some(dir) = private_dir_of(&root) {
                push(format!("Project data — {}", root.display()), dir);
            }
        }
    }
    out
}

/// What an erase would remove, for the confirmation to show.
///
/// Read-only on purpose, and separate from the erase itself: a person about to do something
/// with no undo is owed the actual list and the actual size first, from the same code that
/// will act on it — not a description written alongside it that can drift.
#[tauri::command]
pub fn scan_local_data() -> EraseScan {
    let targets = targets();
    let total_bytes = targets.iter().map(|t| t.bytes).sum();
    EraseScan {
        targets,
        total_bytes,
    }
}

/// Deletes everything `scan_local_data` lists, then restarts the app.
///
/// The sidecar is stopped first because it is holding what is about to be deleted: session
/// files, the checkpoint stores, the log it is appending to. On Windows those are not
/// deletes that wait, they are deletes that fail with "access denied" — the erase would
/// report success on the settings and quietly leave every transcript in place.
///
/// Only returns on failure. On success the process replaces itself the same way an update
/// does, and comes back with nothing to remember, which is the first-run screen.
#[tauri::command]
pub fn erase_local_data(app: AppHandle) -> Result<(), String> {
    let planned = targets();

    crate::shutdown_sidecar(&app.state::<crate::SidecarState>());

    let mut refused: Vec<String> = Vec::new();
    for target in planned {
        if !target.exists {
            continue;
        }
        // `maxRetries` has no equivalent here, so the retry is explicit: a scanner or an
        // indexer holding a handle for a moment is the ordinary reason a delete fails on
        // this platform, and it passes.
        let path = PathBuf::from(&target.path);
        let mut last: Option<std::io::Error> = None;
        for attempt in 0..4 {
            match fs::remove_dir_all(&path) {
                Ok(()) => {
                    last = None;
                    break;
                }
                Err(e) => {
                    last = Some(e);
                    if attempt < 3 {
                        std::thread::sleep(std::time::Duration::from_millis(120));
                    }
                }
            }
        }
        if let Some(e) = last {
            refused.push(format!("{}: {e}", target.path));
        }
    }

    if !refused.is_empty() {
        // Reported rather than restarted through. Coming back on a fresh-looking first-run
        // screen while a transcript is still on disk is the one outcome this must not have:
        // the person would believe the data is gone.
        return Err(format!(
            "some of it could not be removed, so nothing was restarted:\n{}",
            refused.join("\n")
        ));
    }

    crate::update::relaunch_and_leave_without_sidecar(&app);
}

#[cfg(test)]
mod tests {
    use super::private_dir_of;
    use std::path::{Path, PathBuf};

    #[test]
    fn a_workspace_yields_its_own_private_directory() {
        let got = private_dir_of(Path::new(r"D:\proj"));
        assert_eq!(got, Some(PathBuf::from(r"D:\proj\.privatecode")));
    }

    #[test]
    fn a_relative_entry_is_refused() {
        // `recentWorkspaces` is JSON written by another process. A relative path would be
        // resolved against whatever this process's current directory happens to be, which is
        // not something an irreversible delete may depend on.
        assert_eq!(private_dir_of(Path::new(r"proj")), None);
        assert_eq!(private_dir_of(Path::new(r".")), None);
    }

    #[test]
    fn the_workspace_root_itself_is_never_the_target() {
        // The failure this rules out is the whole reason the function exists: an erase that
        // removed `D:\proj` instead of `D:\proj\.privatecode` would take the user's project.
        let root = Path::new(r"D:\proj");
        let got = private_dir_of(root).unwrap();
        assert_ne!(got, root);
        assert!(got.starts_with(root));
        assert_eq!(got.file_name().unwrap(), ".privatecode");
    }
}
