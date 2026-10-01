# Ferrum stage 1: install Ubuntu 24.04 for WSL2 on a DIFFERENT DRIVE (C: is short on space).
# Default is a DRY RUN: it only checks and prints what it would do. Add -Execute to really do it.
#   powershell -ExecutionPolicy Bypass -File scripts\windows\10-wsl-ubuntu-on-disk.ps1 -Path D:\WSL\Ferrum-Ubuntu
#   powershell -ExecutionPolicy Bypass -File scripts\windows\10-wsl-ubuntu-on-disk.ps1 -Path D:\WSL\Ferrum-Ubuntu -Execute
# Uses the documented option `wsl --install -d Ubuntu-24.04 --location <folder>`.
# NOTE: written without access to a Windows machine; UNTESTED. Keep ASCII-only. Run as a NORMAL user
# (if WSL itself is not installed yet, Windows will ask for elevation for that one step).
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [switch]$Execute
)
$ErrorActionPreference = 'Stop'
$Distro = 'Ubuntu-24.04'
function Ok($m)   { Write-Host "  [ OK ] $m" }
function Warn($m) { Write-Host "  [WARN] $m" }
function Bad($m)  { Write-Host "  [FAIL] $m"; $script:failed = $true }
$script:failed = $false

# wsl.exe writes UTF-16: decode it properly
function Wsl-Out([string[]]$wslArgs) {
  $old = [Console]::OutputEncoding
  try { [Console]::OutputEncoding = [System.Text.Encoding]::Unicode; return (& wsl.exe @wslArgs 2>&1 | Out-String) -replace "`0", '' }
  finally { [Console]::OutputEncoding = $old }
}

Write-Host "`n== Checks =="
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if ((New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Bad 'running elevated. Close this window and use a normal PowerShell (an elevated WSL session can leak admin rights into powershell.exe interop)'
}
$full = [System.IO.Path]::GetFullPath($Path)
$drive = (Split-Path -Qualifier $full).TrimEnd(':')
$d = Get-PSDrive -Name $drive -ErrorAction SilentlyContinue
if (-not $d) { Bad "drive $drive`: not found" } else {
  $gb = [math]::Round($d.Free / 1GB, 1)
  if ($gb -lt 6) { Bad "$drive`: has only $gb GB free; need about 6 GB for the distro, Docker engine, image and logs (8+ recommended)" }
  elseif ($gb -lt 8) { Warn "$drive`: has $gb GB free (tight; 8+ recommended)" } else { Ok "$drive`: has $gb GB free" }
}
if ($full -match '^[Cc]:') { Warn 'target is on C:, which is the drive you said is short on space' }
if ((Test-Path $full) -and (Get-ChildItem $full -Force -ErrorAction SilentlyContinue | Select-Object -First 1)) { Bad "$full already exists and is not empty" }

$wslOk = $true
try { $st = Wsl-Out @('--status'); Ok 'wsl.exe present' } catch { $wslOk = $false; Warn 'wsl.exe did not answer; WSL may not be installed yet (the install below will set it up)' }
if ($wslOk) {
  $list = Wsl-Out @('-l', '-q')
  if ($list -split "`r?`n" | Where-Object { $_.Trim() -eq $Distro }) {
    Bad "a distro named $Distro already exists (probably on C:). To MOVE it instead, see the commands printed below."
  } else { Ok "no existing $Distro distro" }
}

Write-Host "`n== Plan =="
Write-Host "  1. wsl --install -d $Distro --location `"$full`""
Write-Host '     (you will be asked to create a Linux username and password: choose a normal, non-root user)'
Write-Host "  2. enable systemd inside the distro (needed for Docker and, later, the gateway service):"
Write-Host "     wsl -d $Distro -u root -- sh -c 'grep -q systemd /etc/wsl.conf 2>/dev/null || printf `"[boot]\nsystemd=true\n`" >> /etc/wsl.conf'"
Write-Host "     wsl --terminate $Distro"
Write-Host "`n  To MOVE an existing $Distro from C: instead (DESTRUCTIVE step marked; back up first):"
Write-Host "     wsl --export $Distro $drive`:\wsl-move.tar"
Write-Host "     wsl --unregister $Distro                      # <-- deletes the old copy"
Write-Host "     wsl --import $Distro `"$full`" $drive`:\wsl-move.tar --version 2"
Write-Host "     then set the default user:  wsl -d $Distro -u root -- sh -c 'printf `"[user]\ndefault=YOURNAME\n`" >> /etc/wsl.conf'"
Write-Host "`n  Recommended %UserProfile%\.wslconfig (only if your model endpoint runs on Windows at localhost):"
Write-Host '     [wsl2]'
Write-Host '     networkingMode=mirrored'
Write-Host "     (then run: wsl --shutdown)"

if ($script:failed) { Write-Host "`nFix the FAIL lines first."; exit 1 }
if (-not $Execute) { Write-Host "`nDRY RUN: nothing was changed. Re-run with -Execute to do steps 1-2."; exit 0 }

Write-Host "`n== Executing =="
New-Item -ItemType Directory -Force -Path (Split-Path $full -Parent) | Out-Null
& wsl.exe --install -d $Distro --location $full
if ($LASTEXITCODE -ne 0) { Write-Host "wsl --install failed (exit $LASTEXITCODE)"; exit $LASTEXITCODE }
& wsl.exe -d $Distro -u root -- sh -c 'grep -q systemd /etc/wsl.conf 2>/dev/null || printf "[boot]\nsystemd=true\n" >> /etc/wsl.conf'
& wsl.exe --terminate $Distro
Write-Host "`nDone. Open Ubuntu, then in WSL:"
Write-Host '  git clone <your Ferrum repo> ~/Ferrum && cd ~/Ferrum && bash scripts/wsl/00-preflight.sh'
