// Real PowerShell: the short-prompt option replaces only the built-in prompt.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildLaunch, SHORT_PROMPT_POWERSHELL } from '../../src/main/shells';
import { Harness, IS_WINDOWS, waitFor, WINDOWS_POWERSHELL } from './helpers';

describe.skipIf(!IS_WINDOWS)('short prompt paths (Windows PowerShell)', () => {
  let base: string;
  let deep: string;
  const h = new Harness();

  beforeAll(() => {
    base = mkdtempSync(path.join(tmpdir(), 'tw-prompt-'));
    deep = path.join(base, 'some', 'very long', 'nested folder', 'car-rental');
    mkdirSync(deep, { recursive: true });
  });
  afterAll(async () => {
    h.dispose();
    await waitFor(() => h.manager.size === 0, 15_000, 'sessions to end');
    rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  const launch = (shortPrompt: boolean) =>
    buildLaunch({
      profile: { id: 'windows-powershell', kind: 'windows-powershell', label: 'Windows PowerShell' },
      executable: WINDOWS_POWERSHELL,
      workspaceRoot: deep,
      startIn: 'workspace-root',
      homeDir: process.env.USERPROFILE!,
      shortPrompt,
    });

  it('shows only the current folder, follows cd, and uses ~ for home', async () => {
    const l = launch(true);
    // -NoProfile keeps the test independent of this machine's $PROFILE.
    h.spawn('short', { file: l.file, args: ['-NoProfile', ...l.args], cwd: l.cwd });
    await h.waitForOutput('short', 'PS car-rental> ');
    expect(h.output('short')).not.toContain(`PS ${deep}>`);
    h.manager.write('short', 'cd ..\r');
    await h.waitForOutput('short', 'PS nested folder> ');
    h.manager.write('short', 'cd ~\r');
    await h.waitForOutput('short', 'PS ~> ');
    h.manager.write('short', 'Write-Output ("OK-" + (6*7))\r');
    await h.waitForOutput('short', 'OK-42');
    // The setup command is entry 1 of the session's Get-History (not PSReadLine's
    // up-arrow history); then the three commands typed above.
    h.manager.write('short', 'Write-Output ("HIST=" + (Get-History).Count + " FIRST=" + ((Get-History)[0].CommandLine -like "*CurrentLocation*"))\r');
    await h.waitForOutput('short', 'HIST=4 FIRST=True');
  });

  it('only the prompt is short: Get-Location, paths in output and errors stay complete', async () => {
    const l = launch(true);
    h.spawn('out', { file: l.file, args: ['-NoProfile', ...l.args], cwd: l.cwd, cols: 400 });
    await h.waitForOutput('out', 'PS car-rental> ');
    h.manager.write('out', 'Write-Output ("LOC=[" + (Get-Location).Path + "]")\r');
    await h.waitForOutput('out', `LOC=[${deep}]`);
    const mark = h.output('out').length;
    h.manager.write('out', 'Get-Location | Format-Table -HideTableHeaders\r');
    // The full path in this command's output (the system ConPTY may position rows with cursor
    // moves instead of line breaks, so compare without them).
    await waitFor(() => h.output('out').slice(mark).replace(/\r?\n/g, '').split('Format-Table -HideTableHeaders')[1]?.includes(deep) ?? false, 15_000, 'full path in Get-Location output');
    h.manager.write('out', `Get-Item -LiteralPath '${deep}\\missing.txt'\r`);
    await h.waitForOutput('out', 'missing.txt');
    // The error message names the full path (ConPTY may wrap it, so compare without line breaks).
    await waitFor(() => h.output('out').replace(/\r?\n/g, '').includes(`${deep}\\missing.txt`), 10_000, 'full path in error');
  });

  it('leaves a custom prompt (from a profile) untouched', async () => {
    h.spawn('custom', {
      file: WINDOWS_POWERSHELL,
      args: ['-NoProfile', '-NoLogo', '-NoExit', '-Command', `function global:prompt { 'MINE> ' }; ${SHORT_PROMPT_POWERSHELL}`],
      cwd: deep,
    });
    await h.waitForOutput('custom', 'MINE> ');
    expect(h.output('custom')).not.toContain('PS car-rental>');
  });

  it('keeps the full path when the option is off', async () => {
    const l = launch(false);
    expect(l.args).toEqual(['-NoLogo']);
    // Wide enough that the long full-path prompt is not wrapped by the console.
    h.spawn('full', { file: l.file, args: ['-NoProfile', ...l.args], cwd: l.cwd, cols: 300 });
    await h.waitForOutput('full', `PS ${deep}> `);
  });
});
