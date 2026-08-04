//! Proves the sidecar's job object takes its DESCENDANTS with it.
//!
//! The property under test is one Windows provides, not one this repo implements, so it can
//! only be established by observation: a unit test asserting that we called
//! `AssignProcessToJobObject` would prove we made the call, not that Edge stayed in the job
//! — and a browser breaking out of a job it was placed in is exactly the plausible failure.
//!
//! Run it as two halves, because the interesting case is a parent that dies WITHOUT
//! cleaning up:
//!
//! ```text
//! cargo run --example orphan_check -- spawn   # prints the pids, then waits forever
//! taskkill /PID <this process> /F             # no /T: nothing walks the tree
//! # every printed pid must be gone
//! ```
//!
//! Passing `close` instead exercises the ordinary path: it drops the job handle itself and
//! exits, which must have the same effect. Passing `no-job` is the control — the same tree
//! with no job at all, which must SURVIVE the kill, or this test proves nothing.
//!
//! Measured 2026-08-04: `close` and `spawn` leave nothing behind (child, grandchild and a
//! real headless Edge all gone); `no-job` leaves all three running.

#[path = "../src/job.rs"]
mod job;

use std::io::Write;
use std::process::{Command, Stdio};

/// A grandchild that will not exit on its own: it stands in for an MCP server process,
/// which is spawned by the sidecar and therefore two levels below the app.
const GRANDCHILD: &str = "setInterval(() => {}, 1000)";

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "spawn".into());

    // The child stands in for the sidecar: a node process that itself spawns things.
    let mut child = Command::new("node")
        .args(["-e", &format!(
            // Spawn a grandchild AND a real browser — the browser is the one that might
            // refuse to stay in a job, and the only way to find out is to put one there.
            r#"
            const {{ spawn }} = require('node:child_process');
            const gc = spawn(process.execPath, ['-e', {grandchild:?}], {{ stdio: 'ignore' }});
            const edge = spawn(process.env.PC_EDGE, [
              '--headless=new', '--remote-debugging-port=0',
              '--user-data-dir=' + process.env.TEMP + '\\pc-orphan-check',
              '--no-first-run', 'about:blank',
            ], {{ stdio: 'ignore' }});
            console.log(JSON.stringify({{ child: process.pid, grandchild: gc.pid, browser: edge.pid }}));
            setInterval(() => {{}}, 1000);
            "#,
            grandchild = GRANDCHILD,
        )])
        .env("PC_EDGE", edge_path())
        .stdout(Stdio::piped())
        .spawn()
        .expect("node must be on PATH");

    // `no-job` is the CONTROL, and without it this test could pass vacuously: if these
    // processes died on their own when the parent went away — a broken stdout pipe, say —
    // the job object would be proving nothing. Run this mode and the same pids must still
    // be alive after the kill.
    let handle = if mode == "no-job" {
        None
    } else {
        let assigned = job::assign_to_job(&child);
        assert!(assigned.is_some(), "the OS refused to create or assign the job object");
        assigned
    };

    // One line of JSON with every pid, so the shell half of the test knows what to check.
    let mut line = String::new();
    {
        use std::io::{BufRead, BufReader};
        let mut reader = BufReader::new(child.stdout.take().unwrap());
        reader.read_line(&mut line).expect("child must report its pids");
    }
    println!("{{\"self\":{},\"tree\":{}}}", std::process::id(), line.trim());
    std::io::stdout().flush().ok();

    if mode == "close" {
        // The ordinary path: we let go of the job and leave. Everything above must die with
        // it even though nothing was killed by name.
        drop(handle);
        return;
    }

    // The interesting path: stay alive until something kills this process outright.
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}

fn edge_path() -> String {
    let candidates = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    ];
    candidates
        .iter()
        .find(|p| std::path::Path::new(p).exists())
        .expect("no Edge or Chrome installed to test with")
        .to_string()
}
