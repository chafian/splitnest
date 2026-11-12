// Regression test for the packaged notification check's privacy scoping (tests/windows/notifications.ps1).
// A diagnostic once matched too loosely and printed another app's notification. Here the helper's
// real functions run against a synthetic history whose entries count every read of their text
// (Content): entries that aren't this run's must never be read, reported or removed.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const helper = path.resolve(__dirname, '../windows/notifications.ps1');

function runPs(body: string): unknown {
  const script = `
$ErrorActionPreference = 'Stop'
. '${helper.replace(/'/g, "''")}' -Action lib
$global:reads = [System.Collections.Generic.List[string]]::new()
$global:removed = [System.Collections.Generic.List[string]]::new()
$global:asked = [System.Collections.Generic.List[string]]::new()
function New-Toast([string]$tag, [string]$group, [string[]]$texts) {
  $t = [pscustomobject]@{ Tag = $tag; Group = $group; _xml = '<toast><visual><binding template="ToastGeneric">' + (($texts | ForEach-Object { "<text>$_</text>" }) -join '') + '</binding></visual></toast>' }
  $t | Add-Member -MemberType ScriptProperty -Name Content -Value {
    $global:reads.Add($this.Tag)
    $x = $this._xml
    $c = [pscustomobject]@{ x = $x }
    $c | Add-Member -MemberType ScriptMethod -Name GetXml -Value { $this.x } -PassThru
  }
  $t
}
$toasts = @(
  (New-Toast 'mail-1' 'inbox' @('Other app', 'UNRELATED-PRIVATE-TEXT')),
  (New-Toast 'n1' 'agents' @('Claude Code finished', 'my-real-project · Backend')),
  (New-Toast 'zz99-n1' 'agents' @('Claude Code finished', 'another run')),
  (New-Toast 'k3f9a2-n7' 'unrelated-group' @('Lookalike', 'UNRELATED-PRIVATE-TEXT')),
  (New-Toast 'xk3f9a2-n1' 'agents' @('Lookalike', 'UNRELATED-PRIVATE-TEXT')),
  (New-Toast 'k3f9a2-n1' 'agents' @('Claude Code needs permission', 'Notification Test · Backend'))
)
$history = [pscustomobject]@{ list = $toasts }
$history | Add-Member -MemberType ScriptMethod -Name GetHistory -Value { param($appId) $global:asked.Add($appId); if ($appId -ceq 'electron.app.SplitNest') { $this.list } else { @() } }
$history | Add-Member -MemberType ScriptMethod -Name Remove -Value { param($tag, $group, $appId) $global:removed.Add("$tag|$group|$appId") }
${body}
`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', timeout: 30_000 });
  return JSON.parse(out.trim());
}

describe.skipIf(process.platform !== 'win32')('packaged notification check: Windows lookups are scoped to the test run', () => {
  it("reads the text of this run's notification only; the unrelated entries' text is never read", () => {
    const r = runPs(`
$report = @(Get-RunReport $history 'k3f9a2' 'Claude Code needs permission' 'Notification Test · Backend' 'violet-heron-417')
@{ report = $report; reads = @($global:reads); asked = @($global:asked) } | ConvertTo-Json -Depth 4 -Compress
`) as { report: Record<string, unknown>[]; reads: string[]; asked: string[] };
    expect(r.asked).toEqual(['electron.app.SplitNest']);
    expect(r.reads).toEqual(['k3f9a2-n1']);
    // Output: the test id, delivery, pass/fail; no notification text.
    expect(r.report).toEqual([{ id: 'k3f9a2-n1', delivered: true, titleOk: true, bodyOk: true, absentOk: true }]);
    expect(JSON.stringify(r)).not.toContain('UNRELATED-PRIVATE-TEXT');
  });

  it('a delivery check without text expectations reads no text at all', () => {
    const r = runPs(`
$report = @(Get-RunReport $history 'k3f9a2')
@{ report = $report; reads = @($global:reads) } | ConvertTo-Json -Depth 4 -Compress
`) as { report: Record<string, unknown>[]; reads: string[] };
    expect(r.reads).toEqual([]);
    expect(r.report).toEqual([{ id: 'k3f9a2-n1', delivered: true }]);
  });

  it("cleanup removes only this run's entries, by exact tag, group and app id, without reading any text", () => {
    const r = runPs(`
$ids = @(Remove-RunToasts $history 'k3f9a2')
@{ ids = $ids; removed = @($global:removed); reads = @($global:reads) } | ConvertTo-Json -Compress
`) as { ids: string[]; removed: string[]; reads: string[] };
    expect(r.removed).toEqual(['k3f9a2-n1|agents|electron.app.SplitNest']);
    expect(r.ids).toEqual(['k3f9a2-n1']);
    expect(r.reads).toEqual([]);
  });

  it('a missing or malformed run token selects nothing', () => {
    const r = runPs(`
$sel = foreach ($id in @('', 'k3', 'K3F9A2', 'k3f9a2-', '*', '.*')) { @(Select-RunToasts $history.list $id).Count }
@{ counts = @($sel); reads = @($global:reads) } | ConvertTo-Json -Compress
`) as { counts: number[]; reads: string[] };
    expect(r.counts).toEqual([0, 0, 0, 0, 0, 0]);
    expect(r.reads).toEqual([]);
  });
});
