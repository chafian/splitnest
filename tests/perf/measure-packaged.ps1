# Resource measurements of the PACKAGED SplitNest build, from outside (the packaged app has
# Node inspection disabled, so no test hooks). Each run uses a temporary user-data folder and a
# temporary project folder with N PowerShell terminals that start automatically on restore.
# It only ever stops processes it started itself (the process tree of the exe it launched).
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tests\perf\measure-packaged.ps1 `
#          -Exe <path to splitnest.exe> [-Counts 1,5,10] [-Runs 3] [-Out result.json]
param(
  [Parameter(Mandatory)] [string] $Exe,
  # Text, split below: `powershell -File` passes "1,5,10" as one string (which [int[]] would read as 1510).
  [string] $Counts = '1,5,10',
  [int] $Runs = 3,
  [int] $SettleSeconds = 20,
  [int] $IdleSeconds = 30,
  [string] $Out = ''
)
$ErrorActionPreference = 'Stop'

function New-Id { [guid]::NewGuid().ToString() }

# N panes, one PowerShell tab each: two rows when N > 5.
function New-Layout([int] $n) {
  # @(...): with one pane PowerShell would otherwise return the hashtable itself, not a list.
  $panes = @(1..$n | ForEach-Object { $t = New-Id; @{ type = 'pane'; id = (New-Id); tabs = @(@{ id = $t; kind = 'terminal'; profileId = 'windows-powershell' }); activeTabId = $t } })
  if ($n -eq 1) { return $panes[0] }
  $row = { param($items) if ($items.Count -eq 1) { $items[0] } else { @{ type = 'split'; id = (New-Id); direction = 'row'; children = @($items); sizes = @($items | ForEach-Object { 1 / $items.Count }) } } }
  if ($n -le 5) { return (& $row $panes) }
  $half = [math]::Ceiling($n / 2)
  $top = & $row ($panes[0..($half - 1)]); $bottom = & $row ($panes[$half..($n - 1)])
  return @{ type = 'split'; id = (New-Id); direction = 'column'; children = @($top, $bottom); sizes = @(0.5, 0.5) }
}

function Get-Tree([int] $rootPid) {
  $all = Get-CimInstance Win32_Process
  $kids = @{}; foreach ($p in $all) { $kids[[int]$p.ParentProcessId] += , $p }
  $out = @(); $queue = [System.Collections.Queue]::new(); $queue.Enqueue($rootPid)
  $root = $all | Where-Object { $_.ProcessId -eq $rootPid }; if ($root) { $out += $root }
  while ($queue.Count) { $id = $queue.Dequeue(); foreach ($c in $kids[$id]) { if ($c.ProcessId -ne $id) { $out += $c; $queue.Enqueue([int]$c.ProcessId) } } }
  return $out
}

# Class of each process: the app's own processes vs shells / console hosts / helpers.
function Get-Class($p, [int] $mainPid, [hashtable] $byPid) {
  $name = $p.Name.ToLower(); $cmd = [string]$p.CommandLine
  if ($name -eq 'splitnest.exe') {
    if ($p.ProcessId -eq $mainPid) { return 'app: main' }
    if ($cmd -match '--type=renderer') { return 'app: renderer' }
    if ($cmd -match '--type=gpu-process') { return 'app: gpu' }
    if ($cmd -match '--type=utility') { return 'app: utility (incl. pty host)' }
    if ($cmd -match '--type=crashpad') { return 'app: crashpad' }
    return 'app: other'
  }
  if ($name -in 'openconsole.exe', 'conhost.exe') { return 'console host (ConPTY)' }
  if ($name -eq 'powershell.exe' -or $name -eq 'pwsh.exe') {
    # The agent-detection helper is a direct child of the main process; shells hang off the pty host.
    if ([int]$p.ParentProcessId -eq $mainPid) { return 'app helper: agent detection (PowerShell)' }
    return 'shell: PowerShell'
  }
  return "other: $name"
}

function Get-Memory([object[]] $procs) {
  # Private working set (what Task Manager shows as "Memory") and private bytes (commit).
  $perf = @{}; Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | ForEach-Object { $perf[[int]$_.IDProcess] = $_ }
  foreach ($p in $procs) {
    $f = $perf[[int]$p.ProcessId]
    [pscustomobject]@{ pid = [int]$p.ProcessId; wsPrivateMB = if ($f) { [math]::Round($f.WorkingSetPrivate / 1MB, 1) } else { $null }; privateMB = [math]::Round($p.PrivatePageCount / 1MB, 1) }
  }
}

function Get-CpuTimes([object[]] $procs) {
  $h = @{}; foreach ($p in $procs) { try { $h[[int]$p.ProcessId] = (Get-Process -Id $p.ProcessId -ErrorAction Stop).TotalProcessorTime.TotalMilliseconds } catch {} }
  return $h
}

function Stop-Tree([int] $rootPid) {
  # Only our own launched instance (and its children). Never touches other SplitNest processes.
  & taskkill.exe /T /F /PID $rootPid 2>$null | Out-Null
}

$results = @()
foreach ($n in ($Counts -split '[,\s]+' | Where-Object { $_ } | ForEach-Object { [int]$_ })) {
  foreach ($run in 1..$Runs) {
    $work = Join-Path $env:TEMP ("tw-perf-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    $proj = Join-Path $work 'perf-project'; $ud = Join-Path $work 'ud'
    New-Item -ItemType Directory -Force $proj, $ud | Out-Null
    $wsId = New-Id
    $layout = New-Layout $n
    $state = @{
      schemaVersion = 3; activeWorkspaceId = $wsId
      workspaces = @(@{ id = $wsId; name = 'perf-project'; rootPath = $proj; layout = $layout; activePaneId = $null })
      settings = @{ defaultProfileId = 'windows-powershell'; fontSize = 14; scrollback = 10000; startShellsOnRestore = $true; sidebarCollapsed = $false; shortPromptPaths = $true; compactFolders = $true; themeMode = 'dark'; darkTheme = 'graphite' }
    }
    # No byte-order mark (Set-Content -Encoding utf8 adds one in Windows PowerShell).
    [IO.File]::WriteAllText((Join-Path $ud 'workspace-state.json'), ($state | ConvertTo-Json -Depth 30))

    $sw = [Diagnostics.Stopwatch]::StartNew()
    $proc = Start-Process -FilePath $Exe -ArgumentList "--tw-user-data=`"$ud`"" -PassThru
    $mainPid = $proc.Id
    $tWindow = $null; $tShells = $null; $tSettled = $null
    $lastCpu = $null; $quietSince = $null
    try {
      while ($sw.Elapsed.TotalSeconds -lt 90) {
        if (-not $tWindow) { $proc.Refresh(); if ($proc.MainWindowHandle -ne 0) { $tWindow = $sw.Elapsed.TotalMilliseconds } }
        $tree = Get-Tree $mainPid
        $shells = @($tree | Where-Object { (Get-Class $_ $mainPid @{}) -eq 'shell: PowerShell' })
        if (-not $tShells -and $shells.Count -ge $n) { $tShells = $sw.Elapsed.TotalMilliseconds }
        if ($tShells) {
          # "Settled": the shells' total CPU time stopped growing for 1.5 s (startup done, prompt drawn).
          $cpu = ($shells | ForEach-Object { try { (Get-Process -Id $_.ProcessId -ErrorAction Stop).TotalProcessorTime.TotalMilliseconds } catch { 0 } } | Measure-Object -Sum).Sum
          if ($lastCpu -ne $null -and [math]::Abs($cpu - $lastCpu) -lt 1) { if (-not $quietSince) { $quietSince = $sw.Elapsed.TotalMilliseconds } elseif ($sw.Elapsed.TotalMilliseconds - $quietSince -ge 1500) { $tSettled = $quietSince; break } } else { $quietSince = $null }
          $lastCpu = $cpu
        }
        Start-Sleep -Milliseconds 100
      }
      Start-Sleep -Seconds $SettleSeconds
      $tree = Get-Tree $mainPid
      $byPid = @{}; foreach ($p in $tree) { $byPid[[int]$p.ProcessId] = $p }
      # Memory: average of 3 samples, 2 s apart.
      $mem = @{}
      foreach ($i in 1..3) { foreach ($m in Get-Memory (Get-Tree $mainPid)) { $mem[$m.pid] += , $m }; Start-Sleep -Seconds 2 }
      # Idle CPU over IdleSeconds.
      $cpu0 = Get-CpuTimes $tree; Start-Sleep -Seconds $IdleSeconds; $cpu1 = Get-CpuTimes $tree
      $classes = @{}
      foreach ($p in $tree) {
        $c = Get-Class $p $mainPid $byPid; $id = [int]$p.ProcessId
        if (-not $classes[$c]) { $classes[$c] = [ordered]@{ count = 0; wsPrivateMB = 0.0; privateMB = 0.0; idleCpuPctOfOneCore = 0.0 } }
        $classes[$c].count++
        $samples = $mem[$id]
        if ($samples) {
          $classes[$c].wsPrivateMB += [math]::Round((($samples | Where-Object wsPrivateMB -ne $null | Measure-Object wsPrivateMB -Average).Average), 1)
          $classes[$c].privateMB += [math]::Round((($samples | Measure-Object privateMB -Average).Average), 1)
        }
        if ($cpu0.ContainsKey($id) -and $cpu1.ContainsKey($id)) { $classes[$c].idleCpuPctOfOneCore += [math]::Round(100 * ($cpu1[$id] - $cpu0[$id]) / ($IdleSeconds * 1000), 2) }
      }
      $results += [pscustomobject]@{ terminals = $n; run = $run; windowMs = [math]::Round($tWindow); shellsSpawnedMs = [math]::Round($tShells); shellsSettledMs = [math]::Round($tSettled); classes = $classes }
      Write-Host ("N={0} run {1}: window {2} ms, shells {3} ms, settled {4} ms" -f $n, $run, [math]::Round($tWindow), [math]::Round($tShells), [math]::Round($tSettled))
    } finally {
      Stop-Tree $mainPid
      Start-Sleep -Seconds 2
      Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
    }
  }
}
$json = $results | ConvertTo-Json -Depth 8
if ($Out) { $json | Set-Content -Encoding utf8 $Out }
$json
