# Ferrum stage 1: get Ubuntu 24.04 for WSL2 onto a DIFFERENT DRIVE (C: is short on space).
# Works on any WSL version: installs normally, then moves the distro with export/import
# (the `wsl --install --location` option is ignored by some WSL builds, so it is not used).
# It also fixes the case "it already installed itself on C:".
#
# Default is a DRY RUN (checks only, changes nothing). Add -Execute to do it.
#   powershell -ExecutionPolicy Bypass -File scripts\windows\10-wsl-ubuntu-on-disk.ps1 -Path D:\WSL\Ferrum-Ubuntu
#   powershell -ExecutionPolicy Bypass -File scripts\windows\10-wsl-ubuntu-on-disk.ps1 -Path D:\WSL\Ferrum-Ubuntu -Execute
#
# Run as a NORMAL user. WSL itself must be installed already (one-time, from an ADMIN PowerShell:
# `wsl --install --no-distribution`, then reboot). NOT tested on every Windows build: ASCII only.
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [switch]$Execute
)
$ErrorActionPreference = 'Continue'
$Distro = 'Ubuntu-24.04'
$script:failed = $false
function Ok($m)   { Write-Host "  [ OK ] $m" }
function Warn($m) { Write-Host "  [WARN] $m" }
function Bad($m)  { Write-Host "  [FAIL] $m"; $script:failed = $true }

# wsl.exe writes UTF-16 to a pipe: decode it, drop NULs
function Wsl-Out([string[]]$wslArgs) {
  $old = [Console]::OutputEncoding
  try {
    [Console]::OutputEncoding = [System.Text.Encoding]::Unicode
    return ((& wsl.exe @wslArgs 2>&1 | Out-String) -replace "`0", '')
  } finally { [Console]::OutputEncoding = $old }
}

# Where does Windows say this distro lives? (registry is the source of truth)
function Get-DistroBase([string]$name) {
  $root = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'
  if (-not (Test-Path $root)) { return $null }
  foreach ($k in Get-ChildItem $root) {
    $p = Get-ItemProperty $k.PSPath
    if ($p.DistributionName -eq $name) { return ($p.BasePath -replace '^\\\\\?\\', '') }
  }
  return $null
}

Write-Host "`n== Checks =="
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if ((New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Bad 'running elevated. Use a normal PowerShell (an elevated WSL session can leak admin rights into powershell.exe interop)'
}
$full = [System.IO.Path]::GetFullPath($Path)
$drive = (Split-Path -Qualifier $full).TrimEnd(':')
$d = Get-PSDrive -Name $drive -ErrorAction SilentlyContinue
if (-not $d) { Bad "drive $drive`: not found" } else {
  $gb = [math]::Round($d.Free / 1GB, 1)
  if ($gb -lt 6) { Bad "$drive`: has only $gb GB free; need about 6 GB" } else { Ok "$drive`: has $gb GB free" }
}
if ($full -match '^[Cc]:') { Warn 'target is on C:, the drive that is short on space' }
if ((Test-Path $full) -and (Get-ChildItem $full -Force -ErrorAction SilentlyContinue | Select-Object -First 1)) { Bad "$full already exists and is not empty" }

$wslOk = $false
$ver = ''
# do not match on text: the output is localized (e.g. Russian Windows). Use the exit code.
try { $ver = Wsl-Out @('--version'); if ($LASTEXITCODE -eq 0) { $wslOk = $true } } catch { }
if ($wslOk) { Ok ('WSL answers: ' + (($ver -split "`r?`n" | Select-Object -First 1).Trim())) }
else { Bad 'WSL is not installed or does not answer. From an ADMIN PowerShell run: wsl --install --no-distribution   then reboot, then re-run this script as a normal user.' }

$base = Get-DistroBase $Distro
$exists = $null -ne $base
if ($exists) {
  Write-Host "  [INFO] $Distro is installed at: $base"
  if ($base.TrimEnd('\') -ieq $full.TrimEnd('\')) { Ok "$Distro is already at the target path. Nothing to do."; exit 0 }
} else { Write-Host "  [INFO] $Distro is not installed yet" }

Write-Host "`n== Plan =="
if (-not $exists) { Write-Host "  1. wsl --install -d $Distro --no-launch        (installs to the default location on C: first, about 1-2 GB, temporary)" }
else              { Write-Host "  1. (skip) $Distro is already installed" }
Write-Host "  2. wsl --terminate $Distro"
Write-Host "  3. wsl --export $Distro `"$full.tar`"      (backup tar on $drive`:, kept afterwards)"
Write-Host "  4. wsl --unregister $Distro                      <-- deletes the copy on C: ONLY after the tar exists and is not tiny"
Write-Host "  5. wsl --import $Distro `"$full`" `"$full.tar`" --version 2"
Write-Host "  6. create/keep a normal Linux user, write /etc/wsl.conf (systemd=true, default user), restart the distro"
Write-Host "  7. verify the new location in the registry and that the VHDX is on $drive`:"
Write-Host "`n  Recommended %UserProfile%\.wslconfig (only if your model endpoint runs on Windows at localhost):"
Write-Host '     [wsl2]'
Write-Host '     networkingMode=mirrored'
Write-Host '     (then run: wsl --shutdown)'

if ($script:failed) { Write-Host "`nFix the FAIL lines first."; exit 1 }
if (-not $Execute) { Write-Host "`nDRY RUN: nothing was changed. Re-run with -Execute."; exit 0 }

Write-Host "`n== Executing =="
$parent = Split-Path $full -Parent
New-Item -ItemType Directory -Force -Path $parent | Out-Null

if (-not $exists) {
  & wsl.exe --install -d $Distro --no-launch
  if ($LASTEXITCODE -ne 0) { Write-Host "wsl --install failed (exit $LASTEXITCODE)"; exit 1 }
  $base = Get-DistroBase $Distro
  if ($null -eq $base) {
    # --no-launch installs the package but the distro is registered on first launch: register it by launching once, non-interactively
    Write-Host '  registering the distro (first start) ...'
    & wsl.exe -d $Distro -u root -- true
    $base = Get-DistroBase $Distro
  }
  if ($null -eq $base) { Write-Host 'Could not register the distro. Run: wsl --install -d Ubuntu-24.04 and re-run this script.'; exit 1 }
}

# remember the normal user (uid 1000) if one exists
$user = (Wsl-Out @('-d', $Distro, '-u', 'root', '--', 'sh', '-c', 'getent passwd 1000 | cut -d: -f1')).Trim()

& wsl.exe --terminate $Distro
$tar = "$full.tar"
Write-Host "  exporting to $tar (this can take a few minutes) ..."
& wsl.exe --export $Distro $tar
$ti = Get-Item $tar -ErrorAction SilentlyContinue
if ($LASTEXITCODE -ne 0 -or -not $ti -or $ti.Length -lt 50MB) {
  Write-Host "Export failed or the tar is suspiciously small. NOT unregistering. Nothing was deleted."
  exit 1
}
Ok ("tar written: {0} MB" -f [math]::Round($ti.Length / 1MB))

& wsl.exe --unregister $Distro
if ($LASTEXITCODE -ne 0) { Write-Host 'unregister failed; the tar is safe at ' $tar; exit 1 }
New-Item -ItemType Directory -Force -Path $full | Out-Null
& wsl.exe --import $Distro $full $tar --version 2
if ($LASTEXITCODE -ne 0) { Write-Host "import failed. Restore with: wsl --import $Distro <folder> `"$tar`" --version 2"; exit 1 }

if (-not $user) {
  $user = Read-Host 'Choose a Linux username (lowercase letters/digits; NOT root)'
  if ($user -notmatch '^[a-z][a-z0-9_-]{0,30}$' -or $user -eq 'root') { Write-Host 'invalid username'; exit 1 }
  Write-Host "  creating user $user; you will be asked for a password:"
  & wsl.exe -d $Distro -u root -- adduser --gecos '' $user
  & wsl.exe -d $Distro -u root -- usermod -aG sudo $user
}
# printf inside the distro (piping a PowerShell string would append a CR/LF and corrupt the file)
& wsl.exe -d $Distro -u root -- sh -c "printf '[boot]\nsystemd=true\n\n[user]\ndefault=$user\n' > /etc/wsl.conf"
& wsl.exe --terminate $Distro

Write-Host "`n== Verify =="
$nb = Get-DistroBase $Distro
if ($nb -and ($nb.TrimEnd('\') -ieq $full.TrimEnd('\'))) { Ok "$Distro now lives at $nb" } else { Bad "registry says: $nb (expected $full)" }
if (Test-Path (Join-Path $full 'ext4.vhdx')) { Ok "ext4.vhdx is in $full" } else { Bad "no ext4.vhdx in $full" }
$who = (Wsl-Out @('-d', $Distro, '--', 'whoami')).Trim()
if ($who -eq $user) { Ok "default user: $who" } else { Bad "default user is '$who', expected '$user'" }
$sd = (Wsl-Out @('-d', $Distro, '--', 'sh', '-c', 'ps -p 1 -o comm=')).Trim()
if ($sd -eq 'systemd') { Ok 'systemd is PID 1' } else { Warn "PID 1 is '$sd' (systemd not active yet; run: wsl --shutdown, then open the distro again)" }
Write-Host "`nThe backup tar $tar can be deleted once everything works."
if ($script:failed) { exit 1 }
Write-Host 'Next: open Ubuntu and run (inside WSL):  git clone https://github.com/Ironcarrier228/Ferrum ~/Ferrum'
