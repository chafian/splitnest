import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { installForkGuard } from '../../src/pty-host/fork-guard';

const require = createRequire(import.meta.url);
const ptyDir = path.dirname(require.resolve('node-pty/package.json'));

describe('PTY host fork guard', () => {
  it("answers node-pty's console-list request in-process with the shell PID", async () => {
    const cp = { fork: (() => {
      throw new Error('real fork called');
    }) as (...args: never[]) => unknown };
    installForkGuard(cp, () => undefined);
    const child = (cp.fork as unknown as (p: string, a: string[]) => NodeJS.EventEmitter)(path.join(ptyDir, 'lib', 'conpty_console_list_agent'), ['4321']);
    const message = await new Promise((resolve) => child.on('message', resolve));
    expect(message).toEqual({ consoleProcessList: [4321] });
  });

  it('refuses every other fork, so nothing can start a second SplitNest', () => {
    const logs: string[] = [];
    const cp = { fork: (() => 'real') as (...args: never[]) => unknown };
    const restore = installForkGuard(cp, (m) => logs.push(m));
    expect(() => (cp.fork as unknown as (p: string) => unknown)('C:\\x\\something-else.js')).toThrow(/not available/);
    expect(logs[0]).toMatch(/refused child_process\.fork\(something-else\.js\)/);
    restore();
    expect((cp.fork as unknown as () => unknown)()).toBe('real');
  });

  it("matches only node-pty's own agent path; look-alikes and non-string paths are refused", () => {
    const logs: string[] = [];
    let real = 0;
    const cp = { fork: (() => {
      real++;
      return 'real';
    }) as (...args: never[]) => unknown };
    installForkGuard(cp, (m) => logs.push(m));
    const fork = cp.fork as unknown as (p: unknown, a?: unknown) => unknown;
    expect(() => fork('C:\\elsewhere\\conpty_console_list_agent', ['1'])).toThrow(/not available/);
    expect(() => fork('C:\\x\\node-pty\\lib\\conpty_console_list_agent.evil.js', ['1'])).toThrow(/not available/);
    expect(() => fork(undefined)).toThrow(/not available/);
    expect(logs).toHaveLength(3);
    expect(logs[2]).toContain('fork(?)');
    // The packaged path (unpacked from app.asar) is recognised.
    expect(fork('C:\\App\\resources\\app.asar.unpacked\\node_modules\\node-pty\\lib\\conpty_console_list_agent', ['77'])).toBeTruthy();
    expect(real).toBe(0);
  });

  it('answers with an empty list when the PID argument is not a number (node-pty then just closes the console)', async () => {
    const cp = { fork: (() => 'real') as (...args: never[]) => unknown };
    installForkGuard(cp, () => undefined);
    const child = (cp.fork as unknown as (p: string, a: string[]) => NodeJS.EventEmitter)(path.join(ptyDir, 'lib', 'conpty_console_list_agent'), ['oops']);
    expect(await new Promise((resolve) => child.on('message', resolve))).toEqual({ consoleProcessList: [] });
  });

  it('node-pty still forks exactly that agent when killing a system-ConPTY session (re-check on upgrades)', () => {
    // If this fails after a node-pty upgrade, re-verify fork-guard.ts against the new kill path.
    expect(JSON.parse(readFileSync(path.join(ptyDir, 'package.json'), 'utf8')).version).toBe('1.1.0');
    const agentJs = readFileSync(path.join(ptyDir, 'lib', 'windowsPtyAgent.js'), 'utf8');
    expect(agentJs).toContain("child_process_1.fork(path.join(__dirname, 'conpty_console_list_agent'), [_this._innerPid.toString()])");
    // The pseudoconsole is still closed natively after the list request.
    expect(agentJs).toContain('this._ptyNative.kill(this._pty, this._useConptyDll)');
  });
});
