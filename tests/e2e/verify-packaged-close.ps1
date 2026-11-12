# Packaged-build check of session shutdown with the system ConPTY (no test hooks exist there).
# A temporary profile starts N PowerShell terminals; `ping -t` is typed into the active one as a
# foreground child. The window is closed and "End sessions and quit" is pressed via UI Automation,
# which ends every session through the same kill path as closing a tab. Then:
#   - every shell, the ping, and every console host must be gone (no orphans)
#   - no second SplitNest main process may have appeared at any point (no fork of the app)
# Only processes this script started are ever stopped (as a last-resort cleanup).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tests\e2e\verify-packaged-close.ps1 -Exe <splitnest.exe> [-Terminals 5]
param([Parameter(Mandatory)] [string] $Exe, [int] $Terminals = 5)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, Microsoft.VisualBasic

function New-Id { [guid]::NewGuid().ToString() }
function Get-Tree([int] $rootPid) {
  $all = Get-CimInstance Win32_Process
  $kids = @{}; foreach ($p in $all) { $kids[[int]$p.ParentProcessId] += , $p }
  $out = @(); $q = [System.Collections.Queue]::new(); $q.Enqueue($rootPid)
  while ($q.Count) { $id = $q.Dequeue(); foreach ($c in $kids[$id]) { if ($c.ProcessId -ne $id -and $c.CreationDate -ge $script:started) { $out += $c; $q.Enqueue([int]$c.ProcessId) } } }
  return $out
}

$work = Join-Path $env:TEMP ('tw-close-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$proj = Join-Path $work 'close-check'; $ud = Join-Path $work 'ud'
New-Item -ItemType Directory -Force $proj, $ud | Out-Null
$panes = @(1..$Terminals | ForEach-Object { $t = New-Id; @{ type = 'pane'; id = (New-Id); tabs = @(@{ id = $t; kind = 'terminal'; profileId = 'windows-powershell' }); activeTabId = $t } })
$layout = if ($Terminals -eq 1) { $panes[0] } else { @{ type = 'split'; id = (New-Id); direction = 'row'; children = $panes; sizes = @($panes | ForEach-Object { 1 / $Terminals }) } }
$ws = New-Id
$state = @{ schemaVersion = 3; activeWorkspaceId = $ws; workspaces = @(@{ id = $ws; name = 'close-check'; rootPath = $proj; layout = $layout; activePaneId = $panes[0].id }); settings = @{ startShellsOnRestore = $true } }
[IO.File]::WriteAllText((Join-Path $ud 'workspace-state.json'), ($state | ConvertTo-Json -Depth 30))

$script:started = Get-Date
$app = Start-Process -FilePath $Exe -ArgumentList "--tw-user-data=`"$ud`"" -PassThru
$main = $app.Id
$result = [ordered]@{ exe = $Exe; terminals = $Terminals }
try {
  # Wait for the shells.
  $deadline = (Get-Date).AddSeconds(60)
  do { Start-Sleep -Milliseconds 300; $tree = Get-Tree $main; $shells = @($tree | Where-Object { $_.Name -eq 'powershell.exe' -and [int]$_.ParentProcessId -ne $main }) } while ($shells.Count -lt $Terminals -and (Get-Date) -lt $deadline)
  if ($shells.Count -lt $Terminals) { throw "only $($shells.Count) shells started" }
  Start-Sleep -Seconds 3
  # A foreground child in the active terminal.
  [Microsoft.VisualBasic.Interaction]::AppActivate($main) | Out-Null
  Start-Sleep -Milliseconds 500
  $shell = New-Object -ComObject WScript.Shell
  $shell.SendKeys('ping -t 127.0.0.1{ENTER}')
  $deadline = (Get-Date).AddSeconds(15)
  do { Start-Sleep -Milliseconds 300; $tree = Get-Tree $main } while (-not ($tree | Where-Object Name -eq 'PING.EXE') -and (Get-Date) -lt $deadline)
  $tree = Get-Tree $main
  $watched = @($tree | Where-Object { $_.Name -in 'powershell.exe', 'PING.EXE', 'conhost.exe', 'OpenConsole.exe' -and [int]$_.ParentProcessId -ne $main })
  $result.before = ($watched | Group-Object Name | ForEach-Object { "$($_.Name) x$($_.Count)" }) -join ', '
  if (-not ($watched | Where-Object Name -eq 'PING.EXE')) { $result.note = 'ping was not started (keystrokes did not reach the terminal)' }

  # Watch for any additional SplitNest main process while quitting.
  $mainsBefore = @(Get-CimInstance Win32_Process -Filter "Name='splitnest.exe'" | Where-Object { [string]$_.CommandLine -notmatch '--type=' } | ForEach-Object { [int]$_.ProcessId })
  $extraMains = @{}
  $script:unreadable = 0
  [void]$app.CloseMainWindow()
  # The native quit confirmation: press "End sessions and quit".
  $deadline = (Get-Date).AddSeconds(15); $pressed = $false
  while (-not $pressed -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 300
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $main)
    # The message box is owned by the app window; its buttons are CCPushButton elements (shown as panes).
    $isButton = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'CCPushButton')
    foreach ($w in [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
      foreach ($btn in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $isButton)) {
        if ($btn.Current.Name -notmatch 'End sessions and quit') { continue }
        $pattern = $null
        if ($btn.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $pattern.Invoke() }
        else { $btn.SetFocus(); Start-Sleep -Milliseconds 150; (New-Object -ComObject WScript.Shell).SendKeys('{ENTER}') }
        $pressed = $true; break
      }
      if ($pressed) { break }
    }
  }
  $result.dialogPressed = $pressed
  # Until the app has exited, sample for extra SplitNest main processes (a forked second instance).
  $deadline = (Get-Date).AddSeconds(20)
  while (-not $app.HasExited -and (Get-Date) -lt $deadline) {
    foreach ($p in Get-CimInstance Win32_Process -Filter "Name='splitnest.exe'") {
      # Exiting processes report no command line: those are our own child processes tearing down.
      if (-not $p.CommandLine) { $script:unreadable++; continue }
      if ([string]$p.CommandLine -notmatch '--type=' -and $mainsBefore -notcontains [int]$p.ProcessId) {
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" -ErrorAction SilentlyContinue
        $extraMains[[int]$p.ProcessId] = "parent $($p.ParentProcessId) ($($parent.Name) $(([string]$parent.CommandLine -replace '.*(--type=\S+).*','$1'))), args: $(([string]$p.CommandLine).Substring(0, [Math]::Min(160, ([string]$p.CommandLine).Length)))"
      }
    }
    Start-Sleep -Milliseconds 100
  }
  $result.appExited = $app.HasExited
  Start-Sleep -Seconds 3
  foreach ($p in Get-CimInstance Win32_Process -Filter "Name='splitnest.exe'") { if ($p.CommandLine -and [string]$p.CommandLine -notmatch '--type=' -and $mainsBefore -notcontains [int]$p.ProcessId) { $extraMains[[int]$p.ProcessId] = "after exit: $($p.CommandLine)" } }
  $result.secondInstanceSeen = $extraMains.Count -gt 0
  $result.exitingSamplesWithoutCommandLine = $script:unreadable
  if ($extraMains.Count) { $result.secondInstances = @($extraMains.Values) }
  $alive = @($watched | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
  $result.leftOver = ($alive | ForEach-Object { "$($_.Name) $($_.ProcessId)" }) -join ', '
  # Proof the kill path really went through the fork guard (it was reached, not skipped).
  $logFile = Join-Path $ud 'logs\splitnest.log'
  $result.guardAnswered = if (Test-Path $logFile) { @(Select-String -Path $logFile -Pattern 'console-list request answered in-process').Count } else { -1 }
  $result.ok = $pressed -and $app.HasExited -and -not $result.secondInstanceSeen -and $alive.Count -eq 0 -and -not $result.note -and $result.guardAnswered -ge $Terminals
} finally {
  if (-not $app.HasExited) { & taskkill.exe /T /F /PID $main 2>$null | Out-Null }
  foreach ($p in $watched) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
$result | ConvertTo-Json
