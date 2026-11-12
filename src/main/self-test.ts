// `--self-test-output=<file>`: verifies, without opening a window, that the
// PTY host can load node-pty from this build, run Windows PowerShell, read
// its output and terminate a running session. Used for packaging checks.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { HostEvent } from '../shared/pty-protocol';
import type { Logger } from './logger';
import { PtyHostClient } from './pty-host-client';

interface Outcome {
  ok: boolean;
  steps: Record<string, unknown>;
  error?: string;
}

export async function runSelfTest(outputFile: string, nodePtyPath: string, hostModule: string, log: Logger): Promise<number> {
  const outcome: Outcome = { ok: false, steps: { nodePtyPath, resourcesPath: process.resourcesPath } };
  const listeners = new Set<(e: HostEvent) => void>();
  const host = new PtyHostClient(hostModule, nodePtyPath, (e) => listeners.forEach((l) => l(e)), () => undefined, log);
  const wait = <T>(predicate: (e: HostEvent) => T | undefined, ms: number, what: string) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(listener);
        reject(new Error(`timed out waiting for ${what}`));
      }, ms);
      const listener = (e: HostEvent) => {
        const value = predicate(e);
        if (value !== undefined) {
          clearTimeout(timer);
          listeners.delete(listener);
          resolve(value);
        }
      };
      listeners.add(listener);
    });

  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const started = Date.now();
  try {
    let output = '';
    const collect = (e: HostEvent) => {
      if (e.type === 'data' && e.sessionId === 'selftest-echo') output += e.data;
      return undefined;
    };
    listeners.add(collect);
    host.send({
      type: 'spawn',
      spec: {
        sessionId: 'selftest-echo',
        file: powershell,
        args: ['-NoLogo', '-NoProfile', '-Command', 'Write-Output ("SELF" + "TEST-OK")'],
        cwd: process.env.USERPROFILE ?? systemRoot,
        cols: 80,
        rows: 24,
      },
    });
    const spawned = await wait(
      (e) => ((e.type === 'spawned' || e.type === 'spawn-failed') && e.sessionId === 'selftest-echo' ? e : undefined),
      20000,
      'spawn',
    );
    if (spawned.type === 'spawn-failed') throw new Error(`spawn failed: ${spawned.message}`);
    const exit = await wait((e) => (e.type === 'exit' && e.sessionId === 'selftest-echo' ? e : undefined), 20000, 'exit');
    listeners.delete(collect);
    outcome.steps.echo = { exitCode: exit.exitCode, sawMarker: output.includes('SELFTEST-OK'), ms: Date.now() - started };
    if (!output.includes('SELFTEST-OK')) throw new Error('marker not found in terminal output');

    const killStart = Date.now();
    host.send({
      type: 'spawn',
      spec: {
        sessionId: 'selftest-kill',
        file: powershell,
        args: ['-NoLogo', '-NoProfile', '-Command', 'Start-Sleep -Seconds 60'],
        cwd: process.env.USERPROFILE ?? systemRoot,
        cols: 80,
        rows: 24,
      },
    });
    await wait((e) => (e.type === 'spawned' && e.sessionId === 'selftest-kill' ? e : undefined), 20000, 'spawn for kill');
    host.send({ type: 'kill', sessionId: 'selftest-kill' });
    await wait((e) => (e.type === 'exit' && e.sessionId === 'selftest-kill' ? e : undefined), 10000, 'kill exit');
    outcome.steps.kill = { ms: Date.now() - killStart };
    outcome.ok = true;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    host.stop();
  }
  writeFileSync(outputFile, JSON.stringify(outcome, null, 2), 'utf8');
  return outcome.ok ? 0 : 1;
}
