// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The Rust shell: spawns the agent sidecar (a Node process running the bundled
//! `agent.cjs`), relays its stdout lines to the WebView as `sidecar-line` events, exposes
//! a `sidecar_send` command that writes a line to its stdin, and kills the sidecar's whole
//! process tree when the app exits. The Rust side does no protocol interpretation at all
//! -- it does not parse the ndjson payload, does not know about `HostRequest`/`HostReply`/
//! `HostEvent`, and never re-implements `LineDecoder` -- it only moves whole lines in both
//! directions. `app/src/lib/client.ts` is where the protocol itself lives on this side.
//!
//! Dev vs release (documented once, here, per Plan 4 Task 4's requirement): in a debug
//! build (`tauri dev`), the sidecar is `node` resolved from PATH plus
//! `core/dist/sidecar/agent.cjs` read straight out of the workspace -- a developer already
//! has node on PATH to run `tauri dev` in the first place, and re-vendoring node.exe for
//! every dev iteration would be wasted work. In a release build, `node.exe` and the whole
//! `sidecar/` tree ship as bundled resources (Task 9), and `sidecar_paths` below switches
//! to `resource_dir()/sidecar/...` under `cfg!(debug_assertions)`.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

#[cfg(windows)]
mod job;
mod update;
#[cfg(windows)]
use job::{assign_to_job, JobHandle};

/// Cap on how many stderr lines `sidecar_stderr()` keeps -- a ring buffer, not a growing
/// log: this exists purely for interactive debugging (a developer or the controller
/// inspecting why a turn failed), not as an audit trail, so unbounded growth over a
/// long-lived session would be pure waste.
const STDERR_RING_CAP: usize = 200;

struct RunningSidecar {
    child: Child,
    stdin: ChildStdin,
    /// Held for the sidecar's lifetime and never read: dropping it is the whole point.
    /// See `JobHandle`.
    #[cfg(windows)]
    _job: Option<JobHandle>,
}

struct SidecarState {
    inner: Mutex<Option<RunningSidecar>>,
    stderr_ring: Mutex<VecDeque<String>>,
}

impl SidecarState {
    fn new() -> Self {
        Self { inner: Mutex::new(None), stderr_ring: Mutex::new(VecDeque::new()) }
    }
}

/// `(node_exe, agent_cjs, rg_exe, ts_wasm_dir)` -- everything needed to spawn and configure
/// the sidecar, resolved for whichever build this is. See this file's module doc comment
/// for the dev/release rationale.
/// Strips Windows' extended-length (`\\?\`) prefix that `Path::canonicalize` always adds.
///
/// This is not cosmetic. Node cannot load a MAIN MODULE given as a verbatim path: passing
/// `\\?\D:\...\agent.cjs` as argv[1] made it fail inside `resolveMainPath` with
/// `EISDIR: illegal operation on a directory, lstat 'D:'` and exit immediately — so the
/// dev build's sidecar died the instant it was spawned, every time. (Only the release
/// build had ever been driven end to end; it resolves its paths from `resource_dir()` and
/// never calls `canonicalize`, which is why this stayed hidden.)
///
/// `\\?\UNC\server\share` is converted back to `\\server\share` rather than left as a
/// path no ordinary API accepts.
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy().into_owned();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => path,
    }
}

fn sidecar_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf, PathBuf, PathBuf), String> {
    if cfg!(debug_assertions) {
        // CARGO_MANIFEST_DIR is .../app/src-tauri at compile time -- walking up two levels
        // reaches the repo root, matching every other vendored-asset path in this repo
        // (search-code.ts's own vendoredRgPath comment: "core/src/tools -> core/src ->
        // core -> repo root -> vendor/ripgrep/rg.exe").
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let repo_root = strip_verbatim_prefix(
            manifest_dir
                .join("..").join("..") // app/src-tauri -> app -> repo root
                .canonicalize()
                .map_err(|e| format!("cannot resolve repo root from {manifest_dir:?}: {e}"))?,
        );
        let sidecar_dir = repo_root.join("core").join("dist").join("sidecar");
        Ok((
            PathBuf::from("node"), // resolved against PATH by Command itself
            sidecar_dir.join("agent.cjs"),
            sidecar_dir.join("vendor").join("ripgrep").join("rg.exe"),
            sidecar_dir.join("vendor").join("tree-sitter"),
        ))
    } else {
        // Task 9's other half: core/dist/sidecar/** (agent.cjs, node.exe, rg.exe, wasm)
        // ships as a bundled resource tree under tauri.conf.json's `bundle.resources`,
        // staged at `resource_dir()/sidecar` in the installed app.
        //
        // Stripped of the verbatim prefix, same as the debug branch — and this line's
        // absence was the strip's own comment coming true in reverse. That comment said
        // the release build "never calls canonicalize, which is why this stayed hidden":
        // true of OUR code, but Tauri's `resource_dir()` returns a `\\?\`-prefixed path
        // itself on Windows, so the very first release run died in `resolveMainPath` with
        // `EISDIR: lstat 'D:'` — the exact failure the dev branch had already been cured
        // of, reported by the user on first launch.
        let resource_dir = strip_verbatim_prefix(
            app.path().resource_dir().map_err(|e| e.to_string())?,
        );
        let sidecar_dir = resource_dir.join("sidecar");
        Ok((
            sidecar_dir.join("node.exe"),
            sidecar_dir.join("agent.cjs"),
            sidecar_dir.join("vendor").join("ripgrep").join("rg.exe"),
            sidecar_dir.join("vendor").join("tree-sitter"),
        ))
    }
}

/// Spawns the sidecar and wires up its stdout/stderr readers. Does NOT store it in
/// `SidecarState` -- the caller does that, so this function stays a pure "start it and
/// hand back the handles" step.
fn spawn_sidecar(app: &AppHandle) -> Result<RunningSidecar, String> {
    let (node_exe, agent_cjs, rg_exe, wasm_dir) = sidecar_paths(app)?;
    // Optional, unlike the two above: the C# navigator is 92 MB and a build may ship
    // without it. Setting the variable to a path that does not exist would be a lie the
    // tool has to discover at call time, so an absent binary sets nothing at all and
    // `navProcess()` reports the feature as unavailable, which is what it is.
    let roslyn_exe = wasm_dir
        .parent()
        .map(|vendor| vendor.join("roslyn").join("roslyn-nav.exe"))
        .filter(|p| p.exists());

    // Optional in the same way, and with one extra condition: the SQL helper is two files.
    // `Microsoft.Data.SqlClient.SNI.dll` is a native library that a single-file publish
    // leaves beside the exe, and an exe without it starts and then cannot connect to
    // anything — a failure that reads as a network problem and is not one. Both or neither.
    let sql_exe = wasm_dir
        .parent()
        .map(|vendor| vendor.join("sql"))
        .filter(|dir| {
            dir.join("sql-probe.exe").exists()
                && dir.join("Microsoft.Data.SqlClient.SNI.dll").exists()
                && dir.join("SqlServerSpatial160.dll").exists()
        })
        .map(|dir| dir.join("sql-probe.exe"));

    let mut cmd = Command::new(&node_exe);
    cmd.arg(&agent_cjs)
        .env("PRIVATECODE_RG", &rg_exe)
        .env("PRIVATECODE_TS_WASM_DIR", &wasm_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = &roslyn_exe {
        cmd.env("PRIVATECODE_ROSLYN", path);
    }
    if let Some(path) = &sql_exe {
        cmd.env("PRIVATECODE_SQL", path);
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: the sidecar is a headless Node process with no console UI of
        // its own -- without this a stray console window flashes behind the app window.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn sidecar ({node_exe:?} {agent_cjs:?}): {e}"))?;

    // Before anything else touches the child: everything it spawns from here on joins this
    // job, so the OS can clean up after it no matter how this process ends. See `JobHandle`.
    #[cfg(windows)]
    let job = assign_to_job(&child);
    #[cfg(windows)]
    if job.is_none() {
        eprintln!("main.rs: could not put the sidecar in a job object; \
                   its processes will not be cleaned up if this app is killed");
    }

    let stdin = child.stdin.take().ok_or("sidecar stdin was not piped")?;
    let stdout = child.stdout.take().ok_or("sidecar stdout was not piped")?;
    let stderr = child.stderr.take().ok_or("sidecar stderr was not piped")?;

    // Relays every complete stdout line as a `sidecar-line` event. BufReader::lines()
    // already accumulates across read() calls until it sees '\n' -- it is doing the same
    // job as protocol.ts's LineDecoder, just at the OS-pipe layer instead of re-parsing
    // ndjson here; the actual JSON is never touched on the Rust side (see module doc
    // comment). The reader thread exits (and the loop ends) once the pipe closes, i.e.
    // once the sidecar itself exits.
    let stdout_app = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    let _ = stdout_app.emit("sidecar-line", l);
                }
                Err(_) => break,
            }
        }
        let _ = stdout_app.emit("sidecar-exit", ());
    });

    // Stderr never carries protocol data (stdio-main.ts writes only diagnostics there) --
    // it is kept in the ring buffer for `sidecar_stderr()` to surface on demand, purely
    // for debugging a stuck or crashed sidecar.
    let stderr_app = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            let Ok(l) = line else { break };
            // In a dev build the ring alone is a blind spot: if the sidecar dies during
            // startup the window never gets far enough to call `sidecar_stderr()`, so the
            // one message explaining why is written to a buffer nobody can reach. Echoing
            // to the console costs nothing and is where a developer is already looking.
            #[cfg(debug_assertions)]
            eprintln!("sidecar stderr: {l}");
            let state = stderr_app.state::<SidecarState>();
            let mut ring = state.stderr_ring.lock().unwrap();
            ring.push_back(l);
            while ring.len() > STDERR_RING_CAP {
                ring.pop_front();
            }
        }
        #[cfg(debug_assertions)]
        eprintln!("sidecar stderr: (stream closed)");
    });

    Ok(RunningSidecar {
        child,
        stdin,
        #[cfg(windows)]
        _job: job,
    })
}

/// Stops the current sidecar (if any) and starts a fresh one, replacing what
/// `SidecarState` holds.
///
/// This exists because a dead agent used to be an unrecoverable dead end: the window's
/// only options were "sit there" or "close the app". The frontend calls this from its
/// agent-unreachable screen and then reloads itself, so a crashed or killed agent costs a
/// button press instead of a restart.
#[tauri::command]
fn restart_sidecar(app: AppHandle, state: State<SidecarState>) -> Result<(), String> {
    shutdown_sidecar(&state);
    state.stderr_ring.lock().unwrap().clear();
    let running = spawn_sidecar(&app)?;
    let pid = running.child.id();
    *state.inner.lock().unwrap() = Some(running);
    eprintln!("main.rs: sidecar restarted, pid={pid}");
    Ok(())
}

/// Writes one already-framed protocol line (no trailing `\n` -- this command appends
/// exactly one) to the sidecar's stdin. The frontend is responsible for producing a valid
/// `HostRequest` JSON string; this command does not look at its contents at all.
#[tauri::command]
fn sidecar_send(line: String, state: State<SidecarState>) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let running = guard.as_mut().ok_or("sidecar is not running")?;
    running
        .stdin
        .write_all(format!("{line}\n").as_bytes())
        .map_err(|e| format!("failed to write to sidecar stdin: {e}"))?;
    running.stdin.flush().map_err(|e| e.to_string())
}

/// Returns (and does not clear) the current contents of the stderr ring buffer, oldest
/// first -- a debugging surface, not a protocol channel.
#[tauri::command]
fn sidecar_stderr(state: State<SidecarState>) -> Result<Vec<String>, String> {
    let ring = state.stderr_ring.lock().map_err(|e| e.to_string())?;
    Ok(ring.iter().cloned().collect())
}

/// Attempts a clean stdin close first (mirroring stdio-main.ts's own 'end' handler, which
/// runs its shutdown() teardown and lets the process exit via process.exitCode discipline
/// -- see stdio-main.ts's comment on why it never calls process.exit()), then polls briefly
/// for the child to exit on its own, and only falls back to killing the whole process tree
/// (`taskkill /PID <pid> /T /F`) if it hasn't. This is the exact same escalation
/// tools/background-task.ts uses for an orphaned child on Windows -- cited here rather than
/// reimplemented differently, so the two places this repo kills a child process agree on
/// how.
fn shutdown_sidecar(state: &SidecarState) {
    let mut guard = match state.inner.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    let Some(mut running) = guard.take() else { return };

    // Dropping stdin closes the pipe from this end -- stdio-main.ts's `process.stdin.on
    // ('end', ...)` fires, runs SessionHost.shutdown(), and the process exits on its own.
    drop(running.stdin);

    let pid = running.child.id();
    let mut exited = false;
    for _ in 0..15 {
        // ~1.5s total, matching a "the window may pause briefly on close" tradeoff that
        // favors giving the clean path a real chance over an instant hard kill.
        match running.child.try_wait() {
            Ok(Some(_status)) => {
                exited = true;
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(_) => break,
        }
    }
    if !exited {
        #[cfg(windows)]
        {
            let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output();
        }
        let _ = running.child.wait();
    }

    // Closing the job is the last line of defence, not bookkeeping, and it matters most in
    // the branch that LOOKS like success: a sidecar that exited on its own sets `exited`
    // and skips the taskkill above — which could not have helped anyway, since `/T` needs a
    // live parent to walk the tree from. Its MCP servers and its browser are still running
    // at this point, and closing the job is what ends them.
    //
    // Explicit rather than left to the end of scope: `running.stdin` was moved out above,
    // so `running` is partially moved and cannot be dropped as a whole.
    #[cfg(windows)]
    drop(running._job);
}

fn main() {
    let app = tauri::Builder::default()
        // The workspace-picker's native folder dialog (Task 8's settings modal, release
        // builds only -- the dev-bridge transport has no Tauri window behind it and uses
        // a plain text field instead; see status.tsx's `pickWorkspaceDialog`).
        .plugin(tauri_plugin_dialog::init())
        // An unattended run assumes you walked away. Everything the app built for those
        // runs -- parking a question instead of blocking, stopping for a named reason --
        // is worth nothing if the only way to learn it happened is to come back and look.
        .plugin(tauri_plugin_notification::init())
        .manage(SidecarState::new())
        .invoke_handler(tauri::generate_handler![
            sidecar_send,
            sidecar_stderr,
            restart_sidecar,
            update::check_for_update,
            update::apply_update
        ])
        .setup(|app| {
            // Sweep up whatever the previous update renamed aside. Here rather than at the end
            // of the update itself: the old binary is still held open until this process is
            // the new one, which it is by now.
            update::clean_previous_update();
            let handle = app.handle().clone();
            let running = spawn_sidecar(&handle).map_err(std::io::Error::other)?;
            let pid = running.child.id();
            *app.state::<SidecarState>().inner.lock().unwrap() = Some(running);
            eprintln!("main.rs: sidecar spawned, pid={pid}");
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            // Fires once, right before the process actually exits -- the single place
            // this shell tears the sidecar down, regardless of whether the window was
            // closed by the user, Alt-F4, or a programmatic exit. Blocking here is fine:
            // the process is already on its way out.
            let state = app_handle.state::<SidecarState>();
            shutdown_sidecar(&state);
        }
    });
}
