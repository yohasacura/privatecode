# Installing PrivateCode on the work laptop

The work laptop needs NO toolchain — no Node, no Rust, no npm. Everything the app needs
(the agent core, a pinned Node runtime, ripgrep, tree-sitter grammars) ships inside the
installer as verified, vendored resources.

## 0. One-time prerequisite on the GPU laptop (this machine)

**Done — verified 2026-08-13.** The inbound rule `Qwen llama.cpp LAN 8080` exists and is
enabled. Nothing to run. (This section used to say the rule was missing and give the
command; it was created since, and the check that settles it is
`Get-NetFirewallRule -Direction Inbound -Enabled True` filtered on port 8080.)

The address the work laptop should point at: **`http://192.168.10.136:8080`** — this
machine's Wi-Fi address, measured 2026-08-13. Both laptops must be on the same network, per
the design.

That address is handed out by DHCP and can change. Re-read it with `ipconfig` (the Wi-Fi
adapter's IPv4) if the app suddenly cannot reach the server, or give the router a
reservation for this machine.

## 1. Build the installer (GPU laptop)

```powershell
cd D:\LocalAgentAI\PrivateCode\core; npm run bundle
cd ..\app; npx tauri build
```

Build only while the llama server is stopped or idle — Rust saturates the cores that
`-ncmoe 22 -t 6` needs. `npm run bundle` first is not optional: the staged sidecar is a
COPY, so a `tauri build` alone will ship an agent older than the code it was meant to
carry. Output:

- `app\src-tauri\target\release\bundle\nsis\PrivateCode_0.1.0_x64-setup.exe` — installer
- `app\src-tauri\target\release\app.exe` **plus the `sidecar\` folder beside it** — the
  portable form. Both together are self-contained and can be copied anywhere; the exe may
  be renamed. Verified by copying the pair to an unrelated directory and launching it
  there: the sidecar spawned from that directory and the window served its embedded UI.
  (An earlier version of this file claimed the bare exe "works only next to its resources;
  ship the installer, not the bare exe" — half right and misleading: the resources are the
  `sidecar\` folder, and taking it along is the whole trick.)

## 2. Install and first run (work laptop)

Either form works; pick one.

- **Portable** — copy `PrivateCode-0.1.0-portable.zip` (39 MB), unzip anywhere, run
  `PrivateCode.exe`. No install, no admin, nothing written outside `%APPDATA%\PrivateCode`.
- **Installer** — copy the `*-setup.exe` (27 MB) and run it (per-user, no admin).

Windows will warn about an unsigned app either way (SmartScreen "Windows protected your
PC" → *More info* → *Run anyway*). If Smart App Control is ON rather than off/evaluation,
it blocks unsigned binaries outright and cannot be overridden per-app — that remains
unresolved, and the only fixes are turning it off (a reset to do so) or signing the build.

Then, on first run, open **Settings** (gear, bottom right):

- **Server URL** — the address from step 0. The default `http://127.0.0.1:8080` is the GPU
  laptop's own loopback and is wrong on any other machine; this is the single most likely
  reason a fresh copy appears dead.
- **Workspace** — the project folder you will work on.

The status bar's server dot goes green when the server is reachable. If it stays red: the
llama.cpp server is not running on the GPU laptop, the two machines are not on the same
network, or its DHCP address changed — re-read it with `ipconfig`.

## 3. Daily use

- The GPU laptop starts the server manually (`Start-QwenServer.bat`) — PrivateCode never
  autostarts it, by design.
- Modes: normal (asks before edits/commands) · plan (read-only) · auto-edit · autopilot
  (red banner; asks once per session). "Always allow" writes a permission rule to the
  layer you pick; rules live in `%APPDATA%\PrivateCode\settings.json` (user layer) or
  `<workspace>\.privatecode\settings.json` (project layer).
- Esc interrupts a running turn; the partial reply is kept and the model continues
  cheaply (warm prefix).
- Sessions persist under `<workspace>\.privatecode\sessions\` and resume from the
  sessions drawer.
- Settings also holds **Permissions** (what has standing permission, and how to take it
  back), **Skills** (what procedures this workspace offers the model, and where to put
  more) and **MCP servers** (the `mcpServers` JSON, edited directly).
- Nothing carries over from this machine automatically. `%APPDATA%\PrivateCode\` holds the
  user-scope settings, AGENTS.md and skills — copy that folder too if you want them on the
  other laptop.

## Known limitations (deliberate)

- No images/screenshots: this GGUF has no vision tower (DESIGN.md §6).
- The app itself talks to exactly one network endpoint: the configured server URL.
- Unsigned build — see the SmartScreen/Smart App Control note in step 2.
