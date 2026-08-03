# Installing PrivateCode on the work laptop

The work laptop needs NO toolchain — no Node, no Rust, no npm. Everything the app needs
(the agent core, a pinned Node runtime, ripgrep, tree-sitter grammars) ships inside the
installer as verified, vendored resources.

## 0. One-time prerequisite on the GPU laptop (this machine)

The llama.cpp server listens on port 8080, but the existing firewall rule covers port
11434 only (the old Ollama setup). Before the work laptop can connect, run ONCE in an
**elevated** PowerShell on the GPU laptop:

```powershell
New-NetFirewallRule -DisplayName "llama.cpp PrivateCode" -Direction Inbound `
  -Protocol TCP -LocalPort 8080 -Action Allow -Profile Private
```

(`-Profile Private` keeps it off public networks. Both laptops must be on the same LAN,
per the design.)

Also note the GPU laptop's LAN address: `ipconfig` → the Wi-Fi/Ethernet IPv4, e.g.
`192.168.1.42`.

## 1. Build the installer (GPU laptop)

```powershell
cd D:\LocalAgentAI\PrivateCode\core; npm run bundle
cd ..\app; npx tauri build
```

Build only while the llama server is stopped or idle — Rust saturates the cores that
`-ncmoe 22 -t 6` needs. Output:

- `app\src-tauri\target\release\bundle\nsis\PrivateCode_0.1.0_x64-setup.exe` — installer
- `app\src-tauri\target\release\privatecode-app.exe` works only next to its resources;
  ship the installer, not the bare exe.

## 2. Install and first run (work laptop)

1. Copy the `*-setup.exe` over and run it (per-user install, no admin needed).
2. Start PrivateCode. On first run open **Settings** (gear, bottom right):
   - **Server URL**: `http://<GPU-laptop-LAN-IP>:8080` (e.g. `http://192.168.1.42:8080`).
     The default `http://127.0.0.1:8080` only works when the model runs on the same
     machine.
   - **Workspace**: pick the project folder you will work on.
3. The status bar's server dot goes green when the server is reachable. If it stays red:
   the server isn't running on the GPU laptop, the firewall rule is missing (step 0), or
   the IP changed (DHCP — consider a reservation).

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

## Known limitations (deliberate)

- Assistant output renders as plain text — no markdown/HTML rendering (a WebView with
  IPC powers must not render model-controlled HTML; revisit later with a sanitizer).
- No images/screenshots: this GGUF has no vision tower (DESIGN.md §6).
- The app itself talks to exactly one network endpoint: the configured server URL.
