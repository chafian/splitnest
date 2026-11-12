// Real WSL checks. They run only when an installed distribution is found and
// are reported as skipped otherwise (for example on hosted CI runners).
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runFile } from '../../src/main/exec';
import { buildLaunch } from '../../src/main/shells';
import { decodeWslOutput, discoverWsl, resolveWslDirectory, wslEnv } from '../../src/main/wsl';
import { Harness, IS_WINDOWS, waitFor } from '../pty/helpers';

const WSL_EXE = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\wsl.exe`;
const discovery = IS_WINDOWS ? await discoverWsl(runFile, WSL_EXE, process.env) : null;
const distro = discovery?.distros.find((d) => d.isDefault)?.name ?? discovery?.distros[0]?.name;
if (!distro) console.warn(`[wsl] SKIPPED: no usable WSL distribution (${JSON.stringify(discovery?.status ?? 'not Windows')})`);

describe.skipIf(!distro)(`WSL (${distro ?? 'none'})`, () => {
  let base: string;
  let weird: string;
  let h: Harness;

  beforeAll(() => {
    base = mkdtempSync(path.join(tmpdir(), 'tw-wsl-'));
    weird = path.join(base, "dir with space 'quote' $HOME;&`echo x`(1)!%PATH%^ ünï⚡");
    mkdirSync(weird);
  });
  afterAll(async () => {
    if (h) {
      h.dispose();
      await waitFor(() => h.manager.size === 0, 15_000, 'sessions to end');
    }
    rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  it('discovers the distribution as available', () => {
    expect(discovery?.status.state).toBe('available');
  });

  it('maps a Windows folder with special characters to its Linux path', async () => {
    const result = await resolveWslDirectory(runFile, WSL_EXE, distro!, weird, process.env);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.linuxPath.endsWith("/dir with space 'quote' $HOME;&`echo x`(1)!%PATH%^ ünï⚡")).toBe(true);
  });

  it('reports unmapped folders instead of starting elsewhere', async () => {
    const result = await resolveWslDirectory(runFile, WSL_EXE, distro!, 'Z:\\definitely\\missing', process.env);
    expect(result).toMatchObject({ ok: false, error: { code: 'WSL_PATH_UNMAPPED', fallback: 'start-in-home' } });
  });

  it('starts an interactive WSL pane in the mapped directory and handles Ctrl+C', async () => {
    const resolved = await resolveWslDirectory(runFile, WSL_EXE, distro!, weird, process.env);
    if (!resolved.ok) throw new Error(resolved.error.message);
    const launch = buildLaunch({
      profile: { id: `wsl:${distro}`, kind: 'wsl', label: distro!, distro },
      executable: WSL_EXE,
      workspaceRoot: weird,
      startIn: 'workspace-root',
      homeDir: process.env.USERPROFILE!,
      linuxPath: resolved.linuxPath,
    });
    h = new Harness();
    h.spawn('w1', { file: launch.file, args: launch.args, cwd: launch.cwd, cols: 400 });
    await new Promise((r) => setTimeout(r, 1500));
    h.manager.write('w1', `printf 'PWD=[%s]\\n' "$PWD"\r`);
    await h.waitForOutput('w1', `PWD=[${resolved.linuxPath}]`, 30_000);
    h.manager.write('w1', 'sleep 30\r');
    await new Promise((r) => setTimeout(r, 800));
    const started = Date.now();
    h.manager.write('w1', '\x03');
    h.manager.write('w1', `echo AFTER-$((40+2))\r`);
    await h.waitForOutput('w1', 'AFTER-42', 10_000);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('short prompt: PROMPT_DIRTRIM reaches bash and trims \\w to the last folder', async () => {
    const deep = path.join(base, 'a', 'b', 'c', 'car-rental');
    mkdirSync(deep, { recursive: true });
    const resolved = await resolveWslDirectory(runFile, WSL_EXE, distro!, deep, process.env);
    if (!resolved.ok) throw new Error(resolved.error.message);
    const launch = buildLaunch({
      profile: { id: `wsl:${distro}`, kind: 'wsl', label: distro!, distro },
      executable: WSL_EXE,
      workspaceRoot: deep,
      startIn: 'workspace-root',
      homeDir: process.env.USERPROFILE!,
      linuxPath: resolved.linuxPath,
      shortPrompt: true,
    });
    expect(launch.env).toEqual({ PROMPT_DIRTRIM: '1', WSLENV: 'PROMPT_DIRTRIM/u' });
    h ??= new Harness();
    h.spawn('trim', { file: launch.file, args: launch.args, cwd: launch.cwd, env: launch.env, cols: 400 });
    await new Promise((r) => setTimeout(r, 1500));
    h.manager.write('trim', 'echo "DIRTRIM=[$PROMPT_DIRTRIM]"\r');
    await h.waitForOutput('trim', 'DIRTRIM=[1]', 30_000);
    // Ubuntu's default PS1 uses \w, which PROMPT_DIRTRIM=1 shortens to `.../car-rental`.
    // (A distribution whose ~/.bashrc sets its own PS1 without \w would be unaffected.)
    await h.waitForOutput('trim', /\.\.\.\/car-rental\$ /, 10_000);
    expect(h.output('trim')).not.toContain(`${resolved.linuxPath}$ `);
    // Only the prompt is shortened: command output keeps the full path.
    h.manager.write('trim', 'echo "PWD=[$(pwd)]"; ls -d "$PWD/../car-rental"\r');
    await h.waitForOutput('trim', `PWD=[${resolved.linuxPath}]`, 10_000);
    await h.waitForOutput('trim', `${resolved.linuxPath}/../car-rental`, 10_000);
  });

  it('closing one WSL pane does not stop another pane or the distribution', async () => {
    h ??= new Harness();
    const args = ['--distribution', distro!, '--cd', '~'];
    h.spawn('a', { file: WSL_EXE, args, cols: 200 });
    h.spawn('b', { file: WSL_EXE, args, cols: 200 });
    await new Promise((r) => setTimeout(r, 2000));
    h.manager.write('a', 'sleep 307 &\r');
    h.manager.write('a', 'echo A-READY\r');
    await h.waitForOutput('a', 'A-READY', 30_000);
    h.manager.kill('a');
    await h.waitForExit('a');
    h.manager.write('b', 'echo B-$((1+1))\r');
    await h.waitForOutput('b', 'B-2', 15_000);
    const list = await runFile(WSL_EXE, ['--list', '--verbose'], { timeoutMs: 10_000, env: wslEnv(process.env) });
    expect(decodeWslOutput(list.stdout)).toMatch(new RegExp(`${distro!.replace(/[.]/g, '\\.')}\\s+Running`));
    // Best effort: the closed session's foreground shell is gone. Background jobs
    // that ignore SIGHUP may survive; that is documented, not asserted.
    await waitFor(() => !!h.exit('a'), 5000, 'session a exit');
  });
});
