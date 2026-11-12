// Real PowerShell sessions through real node-pty (ConPTY). No mocks.
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FLOW } from '../../src/shared/pty-protocol';
import { childPids, consoleHostPids, Harness, IS_WINDOWS, isAlive, ready, refusedForks, waitFor, longTempDir, whenTyped } from './helpers';

let h: Harness;
afterEach(() => h?.dispose());

describe.skipIf(!IS_WINDOWS)('PowerShell sessions (real ConPTY)', () => {
  it('creates a session, round-trips input/output and detects exit codes', async () => {
    h = new Harness();
    h.spawn('s1');
    expect(h.events[0]).toMatchObject({ type: 'spawned', sessionId: 's1' });
    await ready(h, 's1');
    h.manager.write('s1', 'Write-Output ("MARK-" + (6*7))\r');
    await h.waitForOutput('s1', 'MARK-42');
    h.manager.write('s1', 'exit 7\r');
    const exit = await h.waitForExit('s1');
    expect(exit.exitCode).toBe(7);
    expect(h.manager.size).toBe(0);
  });

  it('applies resize requests to the pseudoconsole', async () => {
    h = new Harness();
    h.spawn('s1', { cols: 90, rows: 24 });
    await ready(h, 's1');
    h.manager.write('s1', 'Write-Output ("W=" + $Host.UI.RawUI.WindowSize.Width + "x" + $Host.UI.RawUI.WindowSize.Height)\r');
    await h.waitForOutput('s1', 'W=90x24');
    h.manager.resize('s1', 132, 41);
    await new Promise((r) => setTimeout(r, 300));
    h.manager.write('s1', 'Write-Output ("W=" + $Host.UI.RawUI.WindowSize.Width + "x" + $Host.UI.RawUI.WindowSize.Height)\r');
    await h.waitForOutput('s1', 'W=132x41');
  });

  it('holds a quick second resize until the console has redrawn for the first, keeping only the newest size', async () => {
    h = new Harness();
    h.spawn('s1', { cols: 90, rows: 24 });
    await ready(h, 's1');
    expect(h.events[0]).toMatchObject({ type: 'spawned', repaintsOnResize: true });
    const from = h.events.length;
    const t0 = Date.now();
    h.manager.resize('s1', 60, 24);
    h.manager.resize('s1', 70, 24); // held
    h.manager.resize('s1', 80, 24); // replaces the held 70
    await waitFor(() => h.events.slice(from).filter((e) => e.type === 'resized').length >= 2, 3_000, 'two confirmations');
    // Released once the redraw has arrived and gone quiet, well before the 250 ms cap (the redraw
    // can arrive within the same millisecond as the resize; that must count).
    expect(Date.now() - t0).toBeLessThan(200);
    await new Promise((r) => setTimeout(r, 400));
    const after = h.events.slice(from);
    const confirmed = after.filter((e) => e.type === 'resized').map((e) => (e.type === 'resized' ? `${e.cols}x${e.rows}` : ''));
    expect(confirmed).toEqual(['60x24', '80x24']);
    // The console's redraw for 60 columns was delivered before 80 columns was applied.
    const second = after.findIndex((e, i) => e.type === 'resized' && i > after.findIndex((x) => x.type === 'resized'));
    const first = after.findIndex((e) => e.type === 'resized');
    expect(after.slice(first + 1, second).some((e) => e.type === 'data')).toBe(true);
    h.manager.write('s1', 'Write-Output ("W=" + $Host.UI.RawUI.WindowSize.Width + "x" + $Host.UI.RawUI.WindowSize.Height)\r');
    await h.waitForOutput('s1', 'W=80x24');
  });

  it('Ctrl+C interrupts a foreground command without ending the shell', async () => {
    h = new Harness();
    h.spawn('s1');
    await ready(h, 's1');
    h.manager.write('s1', 'ping -n 60 127.0.0.1\r');
    await h.waitForOutput('s1', /Reply from 127\.0\.0\.1/);
    const shellPid = h.pid('s1');
    const children = await childPids(shellPid);
    expect(children.length).toBeGreaterThan(0);
    const started = Date.now();
    h.manager.write('s1', '\x03');
    await h.waitForOutput('s1', /Control-C/);
    expect(Date.now() - started).toBeLessThan(5000);
    await waitFor(() => children.every((pid) => !isAlive(pid)), 5000, 'ping to stop');
    expect(h.exit('s1')).toBeUndefined();
    // The prompt can take a moment to come back after the interrupt on a slow machine.
    await whenTyped(h, 's1', 'Write-Output ("STILL-" + "ALIVE")', 'STILL-ALIVE');
  });

  it('starts in folders with spaces, unicode, apostrophes and shell metacharacters', async () => {
    const base = longTempDir('tw-pty-');
    const weird = path.join(base, "dir with space 'quote' $HOME;&`echo x`(1)!%PATH%^ ünï⚡");
    mkdirSync(weird);
    try {
      h = new Harness();
      h.spawn('s1', { cwd: weird, cols: 400 });
      await ready(h, 's1');
      h.manager.write('s1', '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output ("CWD=[" + (Get-Location).Path + "]")\r');
      await h.waitForOutput('s1', `CWD=[${weird}]`);
      h.manager.write('s1', 'exit\r');
      await h.waitForExit('s1');
    } finally {
      // The ended shell's console can hold its folder for a moment.
      rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  });

  it('renders unicode and ANSI colour output', async () => {
    h = new Harness();
    h.spawn('s1');
    await ready(h, 's1');
    h.manager.write('s1', 'Write-Host "ünïcödé ⚡ 中文 ok" -ForegroundColor Green\r');
    await h.waitForOutput('s1', 'ünïcödé ⚡ 中文 ok');
    const raw = h.events
      .filter((e) => e.type === 'data' && e.sessionId === 's1')
      .map((e) => (e.type === 'data' ? e.data : ''))
      .join('');
    expect(raw).toMatch(/\x1b\[[0-9;]*m/);
  });

  it('killing a session ends the shell and its foreground child processes', async () => {
    h = new Harness();
    h.spawn('s1');
    await ready(h, 's1');
    h.manager.write('s1', 'ping -n 120 127.0.0.1\r');
    await h.waitForOutput('s1', /Reply from/);
    const shellPid = h.pid('s1');
    const children = await childPids(shellPid);
    expect(children.length).toBeGreaterThan(0);
    h.manager.kill('s1');
    await h.waitForExit('s1');
    await waitFor(() => !isAlive(shellPid) && children.every((p) => !isAlive(p)), 8000, 'shell and child to exit');
  });

  it('closing one session leaves other sessions running', async () => {
    h = new Harness();
    h.spawn('a');
    h.spawn('b');
    await ready(h, 'a');
    await ready(h, 'b');
    h.manager.kill('a');
    await h.waitForExit('a');
    h.manager.write('b', 'Write-Output ("B-" + "OK")\r');
    await h.waitForOutput('b', 'B-OK');
    expect(isAlive(h.pid('b'))).toBe(true);
  });

  it('repeated creation and closure leaves no sessions or processes behind', async () => {
    h = new Harness();
    const pids: number[] = [];
    for (let i = 0; i < 10; i++) {
      const id = `loop-${i}`;
      h.spawn(id, { args: ['-NoLogo', '-NoProfile', '-NoExit', '-Command', 'Write-Output READY'] });
      pids.push(h.pid(id));
      await h.waitForOutput(id, 'READY');
      h.manager.kill(id);
      await h.waitForExit(id);
    }
    expect(h.manager.size).toBe(0);
    await waitFor(() => pids.every((p) => !isAlive(p)), 8000, 'all shells to exit');
  });

  it('closing sessions also ends their console hosts, and never forks a helper process', async () => {
    h = new Harness();
    const before = new Set(await consoleHostPids());
    const shells: number[] = [];
    for (let i = 0; i < 5; i++) {
      const id = `host-${i}`;
      h.spawn(id);
      shells.push(h.pid(id));
      await ready(h, id);
      h.manager.write(id, 'ping -n 120 127.0.0.1\r');
    }
    for (let i = 0; i < 5; i++) await h.waitForOutput(`host-${i}`, /Reply from/);
    const children = (await Promise.all(shells.map((s) => childPids(s)))).flat();
    const hosts = (await consoleHostPids()).filter((p) => !before.has(p));
    expect(hosts.length).toBeGreaterThanOrEqual(5); // one console host per session
    for (let i = 0; i < 5; i++) h.manager.kill(`host-${i}`);
    for (let i = 0; i < 5; i++) await h.waitForExit(`host-${i}`);
    await waitFor(() => [...shells, ...children, ...hosts].every((p) => !isAlive(p)), 10_000, 'shells, foreground children and console hosts to exit');
    // node-pty's kill path asked for its console-list helper; the guard answered it, nothing else forked.
    expect(refusedForks).toEqual([]);
  });

  it('pauses output when the renderer stops acknowledging, then delivers every line', async () => {
    h = new Harness();
    h.autoAck = false;
    h.spawn('s1', { cols: 120 });
    await waitFor(() => h.rawLength('s1') > 0, 20_000, 'first output');
    h.manager.ack('s1', h.rawLength('s1'));
    await ready(h, 's1');
    let acked = h.rawLength('s1');
    h.manager.ack('s1', acked);
    const count = 30_000;
    // ~2.4 MB of output, well above the high watermark.
    h.manager.write('s1', `$pad = 'x' * 70; 1..${count} | ForEach-Object { "L$_ $pad" }; Write-Output ("END" + "-OF-STREAM")\r`);
    // Without acknowledgements the PTY is paused near the high watermark.
    await waitFor(() => h.rawLength('s1') - acked >= FLOW.highWatermark, 30_000, 'reaching the high watermark');
    await new Promise((r) => setTimeout(r, 1500));
    const stalled = h.rawLength('s1') - acked;
    await new Promise((r) => setTimeout(r, 1000));
    expect(h.rawLength('s1') - acked).toBe(stalled);
    expect(stalled).toBeLessThan(FLOW.highWatermark + 4 * FLOW.maxBatchChars);
    // Resume by acknowledging, as the renderer does after xterm parses data.
    h.autoAck = true;
    h.manager.ack('s1', h.rawLength('s1') - acked);
    acked = h.rawLength('s1');
    await h.waitForOutput('s1', 'END-OF-STREAM', 120_000);
    const text = h.output('s1');
    const seen = new Set(text.match(/\bL\d+\b/g));
    const missing: number[] = [];
    for (let i = 1; i <= count; i++) if (!seen.has(`L${i}`)) missing.push(i);
    expect(missing.slice(0, 10)).toEqual([]);
  }, 180_000);
});
