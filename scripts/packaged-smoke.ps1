# Launches the packaged app (no Node.js, no source tree on PATH), restores a
# workspace with "start shells on restore" enabled, captures a screenshot of
# the window, records startup time and memory, then checks how shells behave
# when the app is closed normally and when it is force-killed.
#
# Usage: powershell -NoProfile -File scripts/packaged-smoke.ps1 [-AppDir out\SplitNest-win32-x64] [-Shot test-results\screenshots\15-packaged.png]
param(
  [string]$AppDir = "out\SplitNest-win32-x64",
  [string]$Shot = "test-results\screenshots\15-packaged.png"
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class W { [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Ri, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
'@
[void][W]::SetProcessDPIAware()

$exe = Join-Path (Resolve-Path $AppDir) 'splitnest.exe'
$work = Join-Path $env:TEMP ("tw-pkg-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$userData = Join-Path $work 'user-data'
$project = Join-Path $work "demo project 'one'"
New-Item -ItemType Directory -Force $userData, $project | Out-Null
$state = @{
  schemaVersion = 1; activeWorkspaceId = 'w1'
  settings = @{ defaultProfileId = $null; fontSize = 14; scrollback = 10000; startShellsOnRestore = $true; sidebarCollapsed = $false }
  workspaces = @(@{ id = 'w1'; name = 'demo project'; rootPath = $project; activePaneId = 'p1'
      layout = @{ type = 'split'; id = 's1'; direction = 'row'; sizes = @(0.5, 0.5)
        children = @(@{ type = 'pane'; id = 'p1'; profileId = 'windows-powershell' }, @{ type = 'pane'; id = 'p2'; profileId = 'windows-powershell' }) } })
}
$state | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8 (Join-Path $userData 'workspace-state.json')

$env:Path = ($env:Path -split ';' | Where-Object { $_ -notmatch 'nodejs|\\npm|nvm' }) -join ';'
$result = [ordered]@{ nodeOnPath = [bool](Get-Command node -ErrorAction SilentlyContinue) }

function Get-Shells([int]$rootPid) {
  $all = Get-CimInstance Win32_Process
  $ids = @($rootPid); $found = @()
  for ($i = 0; $i -lt 6; $i++) { $kids = $all | Where-Object { $ids -contains $_.ParentProcessId -and $found.ProcessId -notcontains $_.ProcessId }; $found += $kids; $ids += $kids.ProcessId }
  $found | Where-Object { $_.Name -in 'powershell.exe', 'OpenConsole.exe', 'conhost.exe' }
}

$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $exe -ArgumentList "--tw-user-data=$userData" -PassThru
while ($p.MainWindowHandle -eq 0 -and $sw.ElapsedMilliseconds -lt 20000) { Start-Sleep -Milliseconds 50; $p.Refresh() }
$result.mainWindowHandleMs = $sw.ElapsedMilliseconds
Start-Sleep -Seconds 6
$log = Get-Content (Join-Path $userData 'logs\splitnest.log') -Raw
$result.windowShownMs = [int]([regex]::Match($log, 'window shown (\d+) ms').Groups[1].Value)
$result.sessionsStartedOnRestore = ([regex]::Matches($log, 'session started')).Count
$appProcs = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'splitnest.exe' -and ($_.ProcessId -eq $p.Id -or $_.ParentProcessId -eq $p.Id) }
$result.appWorkingSetMb = [math]::Round(($appProcs | ForEach-Object { (Get-Process -Id $_.ProcessId).WorkingSet64 } | Measure-Object -Sum).Sum / 1MB)
$shells = @(Get-Shells $p.Id)
$result.shellProcessesWhileRunning = @($shells | Where-Object Name -eq 'powershell.exe').Count

[void][W]::SetForegroundWindow($p.MainWindowHandle); Start-Sleep -Milliseconds 400
$r = New-Object W+R; [void][W]::GetWindowRect($p.MainWindowHandle, [ref]$r)
$bmp = New-Object Drawing.Bitmap ($r.Ri - $r.L), ($r.B - $r.T)
$g = [Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
New-Item -ItemType Directory -Force (Split-Path $Shot) | Out-Null
$bmp.Save((Join-Path (Get-Location) $Shot)); $g.Dispose(); $bmp.Dispose()

# Forced termination (e.g. Task Manager): do shells outlive the app?
$shellPids = @($shells | Where-Object Name -eq 'powershell.exe').ProcessId
Stop-Process -Id $p.Id -Force
Start-Sleep -Seconds 4
$result.shellsAliveAfterForceKill = @($shellPids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }).Count
$leftover = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'splitnest.exe' -and $_.ExecutablePath -eq $exe }
$result.appProcessesAfterForceKill = @($leftover).Count
$leftover | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$shellPids | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }

$result | ConvertTo-Json
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
