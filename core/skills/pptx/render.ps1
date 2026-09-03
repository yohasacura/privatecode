# Renders a .pptx with the PowerPoint installed on this machine, over COM: one PNG per slide,
# a PDF, or both, plus an optional labelled contact sheet. Prints one JSON object per line.
#
# The real PowerPoint renders, so fonts are not substituted: the text fit in these images is
# exactly what the reader will see. If PowerPoint is already open, this attaches to it and
# leaves it running; it only quits an instance it started. The deck is opened read-only.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File render.ps1 -Path deck.pptx -OutDir qa
#       [-Width 1600] [-Pdf] [-Grid] [-Prefix slide]
#
# Exit codes: 0 done; 2 PowerPoint is not installed; 3 PowerPoint could not open the file.
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$OutDir = '.',
  [int]$Width = 1600,
  [switch]$Pdf,
  [switch]$Png,
  [switch]$Grid,
  [string]$Prefix = 'slide'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Emit($obj) { Write-Output ($obj | ConvertTo-Json -Compress) }

if (-not (Test-Path -LiteralPath $Path)) { Emit @{ error = "not found: $Path"; code = 'not-found' }; exit 1 }
$Path = (Resolve-Path -LiteralPath $Path).Path
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path -LiteralPath $OutDir).Path
if (-not $Pdf) { $Png = $true }

$startedByUs = $false
$app = $null
try { $app = [System.Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application') } catch { $app = $null }
if ($null -eq $app) {
  try {
    $app = New-Object -ComObject PowerPoint.Application
    $startedByUs = $true
  } catch {
    Emit @{ error = 'PowerPoint is not installed on this machine (COM class PowerPoint.Application is not registered)'; code = 'no-powerpoint' }
    exit 2
  }
}

$pres = $null
try {
  # ReadOnly = msoTrue (-1), Untitled = msoFalse (0), WithWindow = msoFalse (0)
  $pres = $app.Presentations.Open($Path, -1, 0, 0)
} catch {
  Emit @{ error = "PowerPoint could not open the file: $($_.Exception.Message)"; code = 'open-failed' }
  if ($startedByUs) { $app.Quit() }
  exit 3
}

try {
  $n = $pres.Slides.Count
  $ratio = $pres.PageSetup.SlideHeight / $pres.PageSetup.SlideWidth
  $h = [int][Math]::Round($Width * $ratio)
  $stem = [System.IO.Path]::GetFileNameWithoutExtension($Path)

  if ($Pdf) {
    $pdfPath = Join-Path $OutDir ($stem + '.pdf')
    if (Test-Path -LiteralPath $pdfPath) { Remove-Item -LiteralPath $pdfPath -Force }
    $pres.SaveAs($pdfPath, 32)   # ppSaveAsPDF
    Emit @{ pdf = $pdfPath }
  }

  if ($Png) {
    $pad = if ($n -ge 100) { 3 } elseif ($n -ge 10) { 2 } else { 1 }
    Get-ChildItem -LiteralPath $OutDir -Filter ($Prefix + '-*.png') -ErrorAction SilentlyContinue | Remove-Item -Force
    $files = @()
    for ($i = 1; $i -le $n; $i++) {
      $f = Join-Path $OutDir ('{0}-{1}.png' -f $Prefix, $i.ToString().PadLeft($pad, '0'))
      $pres.Slides.Item($i).Export($f, 'PNG', $Width, $h)
      $files += $f
      Emit @{ png = $f; slide = $i }
    }
    if ($Grid -and $files.Count -gt 0) {
      Add-Type -AssemblyName System.Drawing
      $cols = 4; $perSheet = 12; $cellW = 480; $cellH = [int]($cellW * $ratio); $label = 26; $padPx = 10
      $sheets = [Math]::Ceiling($files.Count / $perSheet)
      for ($s = 0; $s -lt $sheets; $s++) {
        $chunk = $files[($s * $perSheet)..([Math]::Min($files.Count, ($s + 1) * $perSheet) - 1)]
        $rows = [Math]::Ceiling($chunk.Count / $cols)
        $c = [Math]::Min($chunk.Count, $cols)
        $bmp = New-Object System.Drawing.Bitmap (($c * ($cellW + $padPx)) + $padPx), (($rows * ($cellH + $label + $padPx)) + $padPx)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.Clear([System.Drawing.Color]::White)
        $font = New-Object System.Drawing.Font('Arial', 12)
        $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(200, 200, 200))
        $brush = [System.Drawing.Brushes]::Black
        for ($k = 0; $k -lt $chunk.Count; $k++) {
          $x = $padPx + ($k % $cols) * ($cellW + $padPx)
          $y = $padPx + [Math]::Floor($k / $cols) * ($cellH + $label + $padPx)
          $img = [System.Drawing.Image]::FromFile($chunk[$k])
          $g.DrawImage($img, $x, $y, $cellW, $cellH)
          $img.Dispose()
          $g.DrawRectangle($pen, $x, $y, $cellW, $cellH)
          $g.DrawString(('Slide {0}' -f ($s * $perSheet + $k + 1)), $font, $brush, $x + 2, $y + $cellH + 4)
        }
        $gridPath = if ($sheets -eq 1) { Join-Path $OutDir ($Prefix + '-grid.jpg') } else { Join-Path $OutDir ('{0}-grid-{1}.jpg' -f $Prefix, ($s + 1)) }
        $bmp.Save($gridPath, [System.Drawing.Imaging.ImageFormat]::Jpeg)
        $g.Dispose(); $bmp.Dispose()
        Emit @{ grid = $gridPath }
      }
    }
  }
  Emit @{ done = $true; slides = $n; width = $Width; height = $h }
} finally {
  if ($null -ne $pres) { $pres.Close() }
  if ($startedByUs) { $app.Quit() }
}
