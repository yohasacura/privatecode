# Which PrivateCode build is this, and does the model reach for csharp_nav?
#
# Written because the two questions are entangled and neither can be answered by watching.
# The C# navigator answered type questions WRONGLY until 2026-08-14 11:40 -- `implementations`
# returned an empty list with ok:true on a project where four types implemented the interface --
# so any impression formed before that build is an impression of a broken tool, and reading
# usage numbers without first checking the build would compare two different programs.
#
# Reads only what is already on this machine and prints a summary. Sends nothing anywhere.
#
#   powershell -ExecutionPolicy Bypass -File check-build.ps1 -Workspace D:\path\to\project
#
# `-Workspace` is the folder you open in PrivateCode. Omit it and the script asks the app
# which folders it has opened recently.

param(
  [string]$Workspace,
  [string]$AppDir
)

$ErrorActionPreference = 'Stop'

# The helper shipped 2026-08-14 11:44. Anything else is older, and older means the wrong
# answers described above.
$FIXED_HELPER = '8c9547b8b57519d65640fb41abe8b7616568d66e6c0b37e452e26dee65a2cc86'

function Section($t) { Write-Host ''; Write-Host "== $t" -ForegroundColor Cyan }

# ---------------------------------------------------------------------------- which build

Section 'The build'

if (-not $AppDir) {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\PrivateCode'),
    (Join-Path $env:LOCALAPPDATA 'PrivateCode'),
    (Split-Path -Parent (Get-Process PrivateCode, app -ErrorAction SilentlyContinue |
      Select-Object -First 1 -ExpandProperty Path))
  ) | Where-Object { $_ -and (Test-Path $_) }
  $AppDir = $candidates | Select-Object -First 1
}

if (-not $AppDir) {
  Write-Host '  Could not find the app folder. Pass -AppDir <folder containing PrivateCode.exe>.' -ForegroundColor Yellow
} else {
  Write-Host "  app folder : $AppDir"
  $exe = Get-ChildItem $AppDir -Filter '*.exe' | Where-Object { $_.Name -match 'PrivateCode|^app\.exe$' } | Select-Object -First 1
  if ($exe) { Write-Host "  built      : $($exe.LastWriteTime)" }

  $helper = Join-Path $AppDir 'sidecar\vendor\roslyn\roslyn-nav.exe'
  if (-not (Test-Path $helper)) {
    Write-Host '  C# helper  : NOT PRESENT -- csharp_nav cannot work in this copy.' -ForegroundColor Red
  } else {
    $h = (Get-FileHash $helper -Algorithm SHA256).Hash.ToLower()
    if ($h -eq $FIXED_HELPER) {
      Write-Host '  C# helper  : the fixed one (2026-08-14 11:44).' -ForegroundColor Green
    } else {
      Write-Host '  C# helper  : OLDER THAN THE FIX.' -ForegroundColor Red
      Write-Host '               This copy answers `implementations` with an empty list and'
      Write-Host '               reports no interfaces for a class that declares one -- silently,'
      Write-Host '               with ok:true. Usage numbers below describe a broken tool.'
      Write-Host "               have: $h"
      Write-Host "               want: $FIXED_HELPER"
    }
  }
}

# ---------------------------------------------------------------------------- which workspace

Section 'The workspace'

if (-not $Workspace) {
  $ui = Join-Path $env:APPDATA 'PrivateCode\ui.json'
  if (Test-Path $ui) {
    $recent = (Get-Content $ui -Raw | ConvertFrom-Json).recentWorkspaces
    if ($recent) {
      Write-Host '  Recently opened:'
      $recent | ForEach-Object { Write-Host "    $_" }
      $Workspace = $recent[0]
    }
  }
}
if (-not $Workspace -or -not (Test-Path $Workspace)) {
  Write-Host '  No workspace to read. Pass -Workspace <folder>.' -ForegroundColor Yellow
  return
}
Write-Host "  reading    : $Workspace"

$sessions = Join-Path $Workspace '.privatecode\state\sessions'
if (-not (Test-Path $sessions)) { $sessions = Join-Path $Workspace '.privatecode\sessions' }
if (-not (Test-Path $sessions)) {
  Write-Host '  No recorded sessions in this workspace.' -ForegroundColor Yellow
  return
}

# ---------------------------------------------------------------------------- the counting

Section 'What the model actually called'

$files = Get-ChildItem $sessions -Filter '*.jsonl' | Where-Object { $_.Name -notlike '*.ui.jsonl' }
if (-not $files) { Write-Host '  No transcripts.' -ForegroundColor Yellow; return }

# Sessions older than the installed build ran a DIFFERENT program -- one whose C# navigator
# answered type questions wrongly -- so mixing them in dilutes the only number that answers
# the question. Counted separately rather than dropped: the contrast is itself the evidence.
$buildTime = if ($exe) { $exe.LastWriteTime } else { [datetime]::MinValue }

$counts = @{}          # this build only
$countsOld = @{}       # sessions that predate it
$navFailures = @()
$firstMoves = @()      # per session on THIS build: csharp_nav before the first read_file?
$oldest = $null; $newest = $null
$oldSessions = 0; $newSessions = 0

foreach ($f in $files) {
  if (-not $oldest -or $f.LastWriteTime -lt $oldest) { $oldest = $f.LastWriteTime }
  if (-not $newest -or $f.LastWriteTime -gt $newest) { $newest = $f.LastWriteTime }
  $onThisBuild = $f.LastWriteTime -ge $buildTime
  if ($onThisBuild) { $newSessions++ } else { $oldSessions++ }
  $sawNavFirst = $null
  foreach ($line in [System.IO.File]::ReadLines($f.FullName)) {
    if ($line.Length -eq 0) { continue }
    try { $d = $line | ConvertFrom-Json } catch { continue }

    if ($d.role -eq 'assistant' -and $d.tool_calls) {
      foreach ($tc in $d.tool_calls) {
        $n = $tc.function.name
        if (-not $n) { continue }
        if ($onThisBuild) { $counts[$n] = 1 + [int]$counts[$n] }
        else { $countsOld[$n] = 1 + [int]$countsOld[$n] }
        # The question that matters is not "did it ever", it is "did it reach for the
        # compiler BEFORE it started opening files".
        if ($onThisBuild -and $null -eq $sawNavFirst) {
          if ($n -eq 'csharp_nav') { $sawNavFirst = $true }
          elseif ($n -eq 'read_file') { $sawNavFirst = $false }
        }
      }
    }
    # A refusal is the loudest possible signal and must not be averaged away.
    if ($d.role -eq 'tool' -and $d.content -is [string] -and
        $d.content -match 'not available in this build|C# index could not be built|System\.Object') {
      $navFailures += "$($f.Name): $($d.content.Substring(0, [Math]::Min(160, $d.content.Length)))"
    }
  }
  if ($null -ne $sawNavFirst) { $firstMoves += [pscustomobject]@{ Session = $f.Name; NavFirst = $sawNavFirst } }
}

$total = ($counts.Values | Measure-Object -Sum).Sum
$totalOld = ($countsOld.Values | Measure-Object -Sum).Sum
Write-Host "  $($files.Count) sessions, $($oldest.ToString('MM-dd')) to $($newest.ToString('MM-dd'))"
Write-Host "  installed build dates from $($buildTime.ToString('MM-dd HH:mm'))"
Write-Host ''

if ($newSessions -eq 0) {
  Write-Host '  NO sessions have run on this build yet, so nothing here describes it.' -ForegroundColor Yellow
  Write-Host "  The $oldSessions older session(s) below ran a version whose C# navigator"
  Write-Host '  answered type questions wrongly. Use the app for a while, then re-run this.'
} else {
  Write-Host "  ON THIS BUILD -- $newSessions session(s), $total tool calls" -ForegroundColor Green
  $counts.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object {
    $bar = '#' * [Math]::Min(40, [Math]::Ceiling($_.Value * 40 / [Math]::Max(1, $total)))
    '  {0,-18} {1,5}  {2}' -f $_.Key, $_.Value, $bar
  }
}

if ($totalOld -gt 0) {
  Write-Host ''
  Write-Host "  before it -- $oldSessions session(s), $totalOld tool calls (a different program)" -ForegroundColor DarkGray
  $countsOld.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 6 | ForEach-Object {
    '  {0,-18} {1,5}' -f $_.Key, $_.Value
  }
}

Section 'csharp_nav'

$nav = [int]$counts['csharp_nav']
$reads = [int]$counts['read_file']
if ($newSessions -eq 0) {
  Write-Host '  Nothing to say yet -- no session has run on this build.' -ForegroundColor Yellow
} elseif ($nav -eq 0) {
  Write-Host "  Never called on this build, against $reads read_file calls." -ForegroundColor Yellow
} else {
  Write-Host "  Called $nav times on this build, against $reads read_file calls."
}

# The metric with a threshold set in advance: reaching for the compiler before opening files.
# Only sessions on this build count -- the earlier ones were answering to a broken helper.
$navFirstCount = ($firstMoves | Where-Object { $_.NavFirst }).Count
if ($firstMoves.Count -gt 0) {
  Write-Host "  Reached for FIRST (before any read_file) in $navFirstCount of $($firstMoves.Count) sessions on this build."
  Write-Host '  Bar set in advance: >=3 of 5 keep the nudge, <=1 revert it.'
  if ($firstMoves.Count -lt 5) {
    Write-Host "  ($($firstMoves.Count) session(s) is not yet enough to decide.)" -ForegroundColor DarkGray
  }
}

if ($navFailures.Count -gt 0) {
  Write-Host ''
  Write-Host "  $($navFailures.Count) call(s) came back refused or degraded:" -ForegroundColor Red
  $navFailures | Select-Object -First 5 | ForEach-Object { Write-Host "    $_" }
} else {
  Write-Host '  No refusals recorded.'
}

Write-Host ''
Write-Host 'Nothing left this machine.' -ForegroundColor DarkGray
