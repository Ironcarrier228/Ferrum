# Ferrum stage 0: READ-ONLY Windows-side preflight. Run in a NORMAL (non-elevated)
# PowerShell. Changes nothing. Works in Windows PowerShell 5.1 and PowerShell 7.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\00-preflight.ps1
#
# NOTE: written without access to a Windows machine (authoring sandbox is Linux).
# It only reads state; if a check misbehaves on your PC, tell me the output.

$ErrorActionPreference = 'Continue'
$script:pass = 0; $script:warn = 0; $script:fail = 0
function Ok($m)   { Write-Host "  [ OK ] $m" -ForegroundColor Green;  $script:pass++ }
function Warn($m) { Write-Host "  [WARN] $m" -ForegroundColor Yellow; $script:warn++ }
function Bad($m)  { Write-Host "  [FAIL] $m" -ForegroundColor Red;    $script:fail++ }
function Hdr($m)  { Write-Host ""; Write-Host "== $m ==" }

Hdr 'Privileges'
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
    Bad 'This shell is elevated. WSL started from an elevated shell can make interop children elevated. Close it and use a normal PowerShell.'
} else {
    Ok "normal (non-elevated) user: $($id.Name)"
}

Hdr 'Windows'
$os = Get-CimInstance Win32_OperatingSystem
$build = [int]$os.BuildNumber
if ($build -ge 22000) { Ok "Windows 11 build $build ($($os.Caption))" } else { Warn "build $build is not Windows 11 (22000+)" }

Hdr 'WSL2'
$wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
if (-not $wsl) {
    Bad 'wsl.exe not found. Install: wsl --install -d Ubuntu-24.04 (elevated once, then reboot)'
} else {
    Ok 'wsl.exe present'
    # wsl.exe writes UTF-16; normalise to avoid NUL characters in the output.
    $prev = [Console]::OutputEncoding
    [Console]::OutputEncoding = [System.Text.Encoding]::Unicode
    $list = (& wsl.exe --list --verbose) 2>$null
    [Console]::OutputEncoding = $prev
    $ubuntu = $list | Where-Object { $_ -match 'Ubuntu-24\.04' }
    if (-not $ubuntu) {
        Bad 'Ubuntu-24.04 distro not found (wsl --list --verbose). Install: wsl --install -d Ubuntu-24.04'
    } else {
        Ok "distro: $(($ubuntu -replace '\s+', ' ').Trim())"
        if ($ubuntu -match '\s2\s*$') { Ok 'distro runs as WSL version 2' } else { Bad 'distro is not WSL version 2 (wsl --set-version Ubuntu-24.04 2)' }
        $u = (& wsl.exe -d Ubuntu-24.04 -- id -un) 2>$null
        if ($u -and $u.Trim() -ne 'root') { Ok "default WSL user: $($u.Trim()) (not root)" } else { Bad 'default WSL user is root; create a normal user and make it default' }
        $sd = (& wsl.exe -d Ubuntu-24.04 -- ps -p 1 -o comm=) 2>$null
        if ($sd -and $sd.Trim() -eq 'systemd') { Ok 'systemd enabled in the distro' } else { Warn 'systemd is not PID 1 in the distro (add [boot] systemd=true to /etc/wsl.conf, then wsl --shutdown)' }
    }
}

Hdr 'Container runtime (Docker Desktop is NOT required)'
# The sandbox needs a container runtime INSIDE WSL (native Docker Engine or rootless Podman).
# Docker Desktop is optional. Check from inside the distro:
$rt = (& wsl.exe -d Ubuntu-24.04 -- sh -c 'if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then echo docker; elif command -v podman >/dev/null 2>&1 && podman info >/dev/null 2>&1; then echo podman; else echo none; fi') 2>$null
if ($rt -and $rt.Trim() -ne 'none') { Ok "container runtime inside WSL: $($rt.Trim())" } else { Bad 'no working docker/podman inside Ubuntu-24.04. Light option: wsl -d Ubuntu-24.04 -- sudo apt-get install -y podman' }
$dd = Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue
if ($dd) { Write-Host '  [INFO] Docker Desktop is running (fine, but not required)' } else { Write-Host '  [INFO] Docker Desktop is not running (fine)' }

Hdr 'Disk space'
$c = Get-PSDrive -Name C
$freeGb = [math]::Round($c.Free / 1GB, 1)
if ($freeGb -lt 3)      { Bad  "C: has only $freeGb GB free; stage 0 needs ~3.3-4.2 GB (WSL distro lives on C: by default)" }
elseif ($freeGb -lt 8)  { Warn "C: has $freeGb GB free; tight (WSL virtual disk never shrinks by itself). Recommend >= 8 GB or relocate the distro to another drive" }
else                    { Ok   "C: has $freeGb GB free" }
Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Name -ne 'C' -and $_.Free -gt 0 } | ForEach-Object { Write-Host ("  [INFO] drive {0}: free {1} GB (candidate for relocating the WSL distro)" -f $_.Name, [math]::Round($_.Free / 1GB, 1)) }

Hdr 'Local-mode workspace (Windows side)'
$ws = Join-Path $env:USERPROFILE 'ferrum-workspace'
if (Test-Path -LiteralPath $ws) { Ok "exists: $ws" } else { Warn "will be created at stage 2: $ws" }

Hdr 'Summary'
Write-Host ("  pass={0} warn={1} fail={2}" -f $script:pass, $script:warn, $script:fail)
if ($script:fail -gt 0) { exit 1 } else { exit 0 }
