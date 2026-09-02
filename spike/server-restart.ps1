# Restart the model server by hand with extra flags, for one experiment.
#
# The launcher (local-standard-server\dist\QwenLauncher.exe) owns the server in normal use
# and takes its arguments from its own config; flags it does not model go through
# `ExtraArgs`, which it reads only at its own start and then rewrites. So an experiment
# with new flags means: stop the launcher (its job object takes the server down with it),
# start llama-server with the launcher's exact command line plus the flags, wait for
# /health. To hand control back: run the launcher and press Start — it kills the orphan
# and starts its own, with whatever `ExtraArgs` config.json carries by then.
#
#   powershell -File spike\server-restart.ps1 -Extra "--slot-save-path D:\Projects\LocalAgent\slot-cache --spec-type draft-mtp,ngram-map-k4v"
#   powershell -File spike\server-restart.ps1 -Extra ""        # the launcher's own arguments, nothing added
#
# Run it from PowerShell directly, never through a shell pipe (`| tail`): the server it
# starts inherits the pipe's write end and lives for hours, so the reader never sees EOF
# and whatever comes after the pipe never runs. Learned by a probe that waited 500 s.
param(
  [string]$Extra = ''
)
$ErrorActionPreference = 'Continue'
$exe = 'D:\Projects\LocalAgent\local-standard-server\llama.cpp\llama-server.exe'
$model = 'D:\Projects\LocalAgent\KAT-Coder-V2.5-Dev-MTP-APEX-i-quality-v2.gguf'
# The launcher's command line, copied from its log header (dist\logs\server-*.log).
$base = @(
  '-m', $model, '--host', '0.0.0.0', '--port', '8080', '--alias', 'KAT-Coder-V2.5-Dev',
  '-c', '196608', '-ngl', '99', '-ncmoe', '26', '-fa', 'on', '-ctk', 'f16', '-ctv', 'f16', '-t', '6',
  '--jinja', '--reasoning-preserve', '--reasoning-format', 'deepseek', '--reasoning-budget', '-1',
  '--metrics', '--timeout', '3600', '--temp', '0.6', '--top-p', '0.95', '--top-k', '20',
  '--min-p', '0.0', '--presence-penalty', '0.0', '--spec-type', 'draft-mtp', '--spec-draft-n-max', '3',
  '-np', '1', '--load-mode', 'none'
)
$extraArgs = @()
if ($Extra.Trim() -ne '') { $extraArgs = $Extra.Trim() -split '\s+' }
# A later --spec-type wins over the launcher's own (llama-server takes the last occurrence).
$args = $base + $extraArgs

Get-Process -Name QwenLauncher -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
Get-Process -Name llama-server -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 3

New-Item -ItemType Directory -Force 'D:\Projects\LocalAgent\slot-cache' | Out-Null
$log = "D:\Projects\LocalAgent\local-standard-server\dist\logs\server-manual-$(Get-Date -Format yyyyMMdd-HHmmss).log"
"# manual start: $exe $($args -join ' ')" | Out-File -FilePath $log -Encoding utf8
$p = Start-Process -FilePath $exe -ArgumentList $args -WorkingDirectory 'D:\Projects\LocalAgent\local-standard-server\llama.cpp' -RedirectStandardError "$log.err" -RedirectStandardOutput "$log.out" -PassThru -WindowStyle Hidden
"started pid $($p.Id); log $log"

$deadline = (Get-Date).AddSeconds(240)
do {
  Start-Sleep -Seconds 3
  try {
    $h = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/health' -TimeoutSec 3
    if ($h.status -eq 'ok') { "healthy after $([int]((Get-Date) - $p.StartTime).TotalSeconds)s"; exit 0 }
  } catch {}
  if ($p.HasExited) { "server exited with $($p.ExitCode)"; Get-Content "$log.err" -Tail 20; exit 1 }
} while ((Get-Date) -lt $deadline)
"not healthy within 240 s"; Get-Content "$log.err" -Tail 20; exit 1
