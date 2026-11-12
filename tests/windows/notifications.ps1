# Windows side of the packaged notification check (tests/windows/packaged-notify.mjs).
#
# Privacy rules, enforced here and by tests/unit/windows-notifications-scope.test.ts:
# - Notification history is asked for SplitNest's app id only (GetHistory(AppId)), never for all apps.
# - Within it, an entry is picked by tag and group alone: its tag must start with this run's token
#   (SplitNest is started with --tw-notify-id=<token>) and its group must be one SplitNest uses.
#   Only then is its Content (the text) read. Other SplitNest notifications are never read.
# - Output is the test id, delivery status and pass/fail of text checks; never notification text.
# - Removal uses the same selection, so it removes only this run's entries.
# - No UI Automation of Notification Center or banners (it can't be scoped to one app before
#   reading element names): clicking a banner is done by the person running the check.
# - Window helpers read only windows of the given SplitNest process id.
param(
  [ValidateSet('lib', 'history', 'remove', 'minimize', 'state', 'close-window', 'snapshot', 'restore')][string]$Action = 'lib',
  [string]$RunId = '',
  [int]$ProcessId = 0,
  [string]$ExpectTitle = '',
  [string]$ExpectBody = '',
  [string]$Absent = '',
  [string]$Exe = '',
  [string]$File = ''
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$AppId = 'electron.app.SplitNest'
$Groups = @('agents', 'test')

function Test-RunTag([string]$Tag, [string]$RunId) {
  return ($RunId -cmatch '^[a-z0-9]{4,8}$') -and ($null -ne $Tag) -and $Tag.StartsWith("$RunId-", [StringComparison]::Ordinal)
}

# This run's entries, chosen by Tag and Group only. Content is not touched here.
function Select-RunToasts($Toasts, [string]$RunId) {
  foreach ($t in @($Toasts)) {
    if ($null -ne $t -and (Test-RunTag $t.Tag $RunId) -and ($Groups -contains $t.Group)) { $t }
  }
}

function Get-ToastTexts($Toast) {
  $xml = $Toast.Content.GetXml()
  return @([regex]::Matches($xml, '<text[^>]*>([^<]*)</text>') | ForEach-Object { [Net.WebUtility]::HtmlDecode($_.Groups[1].Value) })
}

# One row per entry of this run: id, delivered, and (when expectations are given) pass/fail only.
function Get-RunReport($History, [string]$RunId, [string]$ExpectTitle = '', [string]$ExpectBody = '', [string]$Absent = '') {
  foreach ($t in @(Select-RunToasts $History.GetHistory($AppId) $RunId)) {
    $row = [ordered]@{ id = [string]$t.Tag; delivered = $true }
    if ($ExpectTitle -or $ExpectBody -or $Absent) {
      $texts = Get-ToastTexts $t
      if ($ExpectTitle) { $row.titleOk = ($texts.Count -ge 1 -and $texts[0] -ceq $ExpectTitle) }
      if ($ExpectBody) { $row.bodyOk = ($texts.Count -ge 2 -and $texts[1] -ceq $ExpectBody) }
      if ($Absent) { $row.absentOk = -not (($texts -join "`n").Contains($Absent)) }
    }
    [pscustomobject]$row
  }
}

function Remove-RunToasts($History, [string]$RunId) {
  foreach ($t in @(Select-RunToasts $History.GetHistory($AppId) $RunId)) {
    $History.Remove([string]$t.Tag, [string]$t.Group, $AppId)
    [string]$t.Tag
  }
}

# SplitNest's own Windows registrations: the Start menu shortcut Electron creates, the COM
# activators that point at a splitnest.exe, and the per-app notification settings key.
$Shortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\SplitNest.lnk'
$SettingsKey = 'HKCU\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\electron.app.SplitNest'
function Get-Activators {
  $out = [ordered]@{}
  foreach ($k in Get-ChildItem 'HKCU:\Software\Classes\CLSID' -ErrorAction SilentlyContinue) {
    $ls = Join-Path $k.PSPath 'LocalServer32'
    if (-not (Test-Path $ls)) { continue }
    $v = (Get-ItemProperty $ls -ErrorAction SilentlyContinue).'(default)'
    if ($v -and ($v -replace '"', '') -match '\\splitnest\.exe(\s|$)') { $out[$k.PSChildName] = [string]$v }
  }
  return $out
}

if ($Action -eq 'lib') { return }

if ($Action -in 'history', 'remove') {
  $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $history = [Windows.UI.Notifications.ToastNotificationManager]::History
  if ($Action -eq 'history') { ConvertTo-Json -InputObject @(Get-RunReport $history $RunId $ExpectTitle $ExpectBody $Absent) -Compress }
  else { ConvertTo-Json -InputObject @(Remove-RunToasts $history $RunId) -Compress }
  return
}

if ($Action -eq 'snapshot') {
  # Saved before the first notification so 'restore' can put back exactly what was there.
  $snap = [ordered]@{ shortcut = $null; shortcutTarget = $null; activators = Get-Activators; settingsKey = $false; settingsExport = $null }
  if (Test-Path $Shortcut) {
    $snap.shortcut = [Convert]::ToBase64String([IO.File]::ReadAllBytes($Shortcut))
    $snap.shortcutTarget = (New-Object -ComObject WScript.Shell).CreateShortcut($Shortcut).TargetPath
  }
  if (Test-Path "Registry::$SettingsKey") {
    $snap.settingsKey = $true
    $snap.settingsExport = "$File.settings.reg"
    & reg.exe export $SettingsKey $snap.settingsExport /y | Out-Null
  }
  ConvertTo-Json -InputObject $snap -Depth 4 | Set-Content -Encoding UTF8 $File
  [pscustomobject]@{ shortcut = [bool]$snap.shortcut; shortcutTarget = $snap.shortcutTarget; activators = @($snap.activators.Values); settingsKey = $snap.settingsKey } | ConvertTo-Json -Compress
  return
}

if ($Action -eq 'restore') {
  # Undo only what the test build changed (whatever points at -Exe), back to the snapshot.
  $snap = Get-Content -Raw $File | ConvertFrom-Json
  $exeFull = [IO.Path]::GetFullPath($Exe)
  $done = @()
  if (Test-Path $Shortcut) {
    $target = (New-Object -ComObject WScript.Shell).CreateShortcut($Shortcut).TargetPath
    if ($target -and [IO.Path]::GetFullPath($target) -ieq $exeFull) {
      if ($snap.shortcut) { [IO.File]::WriteAllBytes($Shortcut, [Convert]::FromBase64String($snap.shortcut)); $done += 'shortcut restored' }
      else { Remove-Item $Shortcut; $done += 'shortcut removed (created by the test)' }
    }
  } elseif ($snap.shortcut) { [IO.File]::WriteAllBytes($Shortcut, [Convert]::FromBase64String($snap.shortcut)); $done += 'shortcut restored' }
  $before = @{}; if ($snap.activators) { $snap.activators.PSObject.Properties | ForEach-Object { $before[$_.Name] = $_.Value } }
  $now = Get-Activators
  foreach ($id in @($now.Keys)) {
    if (-not ($now[$id] -replace '"', '').StartsWith($exeFull, [StringComparison]::OrdinalIgnoreCase)) { continue }
    $key = "HKCU:\Software\Classes\CLSID\$id"
    if ($before.ContainsKey($id)) { Set-ItemProperty (Join-Path $key 'LocalServer32') -Name '(default)' -Value $before[$id]; $done += "activator $id restored" }
    else { Remove-Item $key -Recurse; $done += "activator $id removed (created by the test)" }
  }
  if (-not $snap.settingsKey) {
    if (Test-Path "Registry::$SettingsKey") { Remove-Item "Registry::$SettingsKey" -Recurse; $done += 'notification settings key removed (created by the test)' }
  } elseif ($snap.settingsExport -and (Test-Path $snap.settingsExport)) {
    & reg.exe import $snap.settingsExport 2>$null | Out-Null; $done += 'notification settings key restored'
  }
  ConvertTo-Json -InputObject @($done) -Compress
  return
}

# Window helpers: only windows that belong to -ProcessId are looked at.
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class SNWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static IntPtr AppWindow(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid || found != IntPtr.Zero || !IsWindowVisible(h)) return true;
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      var t = new StringBuilder(512); GetWindowText(h, t, 512);
      if (c.ToString() == "Chrome_WidgetWin_1" && t.ToString().EndsWith("SplitNest")) found = h;
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
$h = [SNWin]::AppWindow([uint32]$ProcessId)
if ($h -eq [IntPtr]::Zero) { throw 'SplitNest main window not found' }
switch ($Action) {
  'minimize' { [void][SNWin]::ShowWindow($h, 6); 'ok' }
  'close-window' { [void][SNWin]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero); 'ok' }
  'state' {
    $fg = [SNWin]::GetForegroundWindow(); $fp = 0; [void][SNWin]::GetWindowThreadProcessId($fg, [ref]$fp)
    [pscustomobject]@{ minimized = [SNWin]::IsIconic($h); foreground = ($fp -eq $ProcessId) } | ConvertTo-Json -Compress
  }
}
