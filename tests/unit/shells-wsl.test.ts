import { describe, expect, it } from 'vitest';
import type { RunResult, Runner } from '../../src/main/exec';
import { createLaunchResolver } from '../../src/main/launch-resolver';
import { buildLaunch, discoverShells, findPwsh } from '../../src/main/shells';
import { decodeWslOutput, discoverWsl, parseWslList, RESOLVE_SCRIPT, resolveWslDirectory } from '../../src/main/wsl';
import type { ShellProfile, Workspace } from '../../src/shared/types';

const ok = (stdout: string | Buffer, code: number | null = 0): RunResult => ({
  code,
  stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout, 'utf8'),
  stderr: Buffer.alloc(0),
  timedOut: false,
  notFound: false,
});

const LIST = '  NAME                   STATE           VERSION\r\n* Ubuntu-22.04           Running         2\r\n  docker-desktop         Stopped         2\r\n  Debian                 Stopped         2\r\n';
const WEIRD = "C:\\Users\\me\\dir with space 'quote' $HOME;&`echo x`(1)!%PATH%^ ünï⚡";

describe('WSL output decoding', () => {
  it('decodes UTF-16LE output from older wsl.exe versions', () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(LIST, 'utf16le')]);
    expect(decodeWslOutput(utf16)).toBe(LIST);
    expect(decodeWslOutput(Buffer.from(LIST, 'utf16le'))).toBe(LIST);
  });

  it('decodes UTF-8 output (WSL_UTF8=1) including non-ASCII text', () => {
    expect(decodeWslOutput(Buffer.from('ünï ⚡\n', 'utf8'))).toBe('ünï ⚡\n');
  });

  it('parses distributions and the default marker, skipping the header', () => {
    expect(parseWslList(LIST)).toEqual([
      { name: 'Ubuntu-22.04', isDefault: true, version: 2 },
      { name: 'docker-desktop', isDefault: false, version: 2 },
      { name: 'Debian', isDefault: false, version: 2 },
    ]);
  });
});

describe('WSL discovery', () => {
  it('lists distributions and hides Docker Desktop internals', async () => {
    const run: Runner = async (_f, args, opts) => {
      expect(args).toEqual(['--list', '--verbose']);
      expect(opts.env?.WSL_UTF8).toBe('1');
      return ok(LIST);
    };
    const result = await discoverWsl(run, 'C:\\Windows\\System32\\wsl.exe', {});
    expect(result.status).toEqual({ state: 'available' });
    expect(result.distros.map((d) => d.name)).toEqual(['Ubuntu-22.04', 'Debian']);
  });

  it('reports a missing wsl.exe without running anything', async () => {
    const run: Runner = async () => {
      throw new Error('should not run');
    };
    expect((await discoverWsl(run, null, {})).status.state).toBe('not-installed');
  });

  it('reports no distributions, timeouts and nonzero exit codes', async () => {
    const none: Runner = async () => ok(Buffer.from('Windows Subsystem for Linux has no installed distributions.\r\n', 'utf16le'), 4294967295);
    expect((await discoverWsl(none, 'wsl.exe', {})).status.state).toBe('no-distributions');
    const slow: Runner = async () => ({ ...ok(''), code: null, timedOut: true });
    expect((await discoverWsl(slow, 'wsl.exe', {})).status).toMatchObject({ state: 'error' });
    const broken: Runner = async () => ok('The Windows Subsystem for Linux optional component is not enabled.', 1);
    expect((await discoverWsl(broken, 'wsl.exe', {})).status).toMatchObject({ state: 'error', message: expect.stringContaining('not enabled') });
  });
});

describe('Windows to WSL path resolution', () => {
  it('passes the folder as a separate argument, never inside the script', async () => {
    let seen: string[] = [];
    const run: Runner = async (_f, args) => {
      seen = args;
      return ok("/mnt/c/Users/me/dir with space 'quote' $HOME;&`echo x`(1)!%PATH%^ ünï⚡");
    };
    const result = await resolveWslDirectory(run, 'wsl.exe', 'Ubuntu-22.04', WEIRD, {});
    expect(result).toEqual({ ok: true, linuxPath: "/mnt/c/Users/me/dir with space 'quote' $HOME;&`echo x`(1)!%PATH%^ ünï⚡" });
    expect(seen).toEqual(['--distribution', 'Ubuntu-22.04', '--exec', 'sh', '-c', RESOLVE_SCRIPT, 'wsl-path-check', WEIRD]);
    expect(RESOLVE_SCRIPT).not.toContain(WEIRD);
  });

  it('maps failures to errors that offer an explicit home-directory fallback', async () => {
    const unmapped: Runner = async () => ({ ...ok('', 3), stderr: Buffer.from('wslpath: Z:\\nope\n') });
    expect(await resolveWslDirectory(unmapped, 'wsl.exe', 'Ubuntu', 'Z:\\nope', {})).toMatchObject({
      ok: false,
      error: { code: 'WSL_PATH_UNMAPPED', fallback: 'start-in-home', detail: 'wslpath: Z:\\nope' },
    });
    const inaccessible: Runner = async () => ok('', 4);
    expect(await resolveWslDirectory(inaccessible, 'wsl.exe', 'Ubuntu', 'C:\\x', {})).toMatchObject({
      ok: false,
      error: { code: 'WSL_PATH_UNMAPPED', message: expect.stringContaining('not accessible') },
    });
    const slow: Runner = async () => ({ ...ok(''), code: null, timedOut: true });
    expect(await resolveWslDirectory(slow, 'wsl.exe', 'Ubuntu', 'C:\\x', {}, 1000)).toMatchObject({
      ok: false,
      error: { code: 'WSL_TIMEOUT', fallback: 'start-in-home' },
    });
    const garbage: Runner = async () => ok('not-a-path\n');
    expect(await resolveWslDirectory(garbage, 'wsl.exe', 'Ubuntu', 'C:\\x', {})).toMatchObject({ ok: false });
  });
});

describe('shell discovery and launch arguments', () => {
  const env = { Path: 'C:\\Windows\\System32;C:\\Tools', SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' };

  it('prefers pwsh on PATH, then the standard install folder', async () => {
    expect(await findPwsh(env, async (f) => f === 'C:\\Tools\\pwsh.exe')).toBe('C:\\Tools\\pwsh.exe');
    expect(await findPwsh(env, async (f) => f === 'C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe(
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    );
    expect(await findPwsh(env, async () => false)).toBeNull();
  });

  it('falls back to Windows PowerShell when PowerShell 7 is missing', async () => {
    const exists = async (f: string) => f.endsWith('powershell.exe') || f.endsWith('wsl.exe');
    const { discovery, executables } = await discoverShells({ env, exists, run: async () => ok(LIST) });
    expect(discovery.profiles.map((p) => p.id)).toEqual(['windows-powershell', 'wsl:Ubuntu-22.04', 'wsl:Debian']);
    expect(discovery.fallbackProfileId).toBe('windows-powershell');
    expect(executables.get('wsl:Debian')).toBe('C:\\Windows\\System32\\wsl.exe');
  });

  it('keeps PowerShell usable when WSL is unavailable', async () => {
    const exists = async (f: string) => f.endsWith('powershell.exe');
    const { discovery } = await discoverShells({ env, exists, run: async () => ok('') });
    expect(discovery.profiles.map((p) => p.id)).toEqual(['windows-powershell']);
    expect(discovery.wsl.state).toBe('not-installed');
  });

  const wsl: ShellProfile = { id: 'wsl:Ubuntu-22.04', kind: 'wsl', label: 'Ubuntu-22.04', distro: 'Ubuntu-22.04' };
  const ps: ShellProfile = { id: 'pwsh', kind: 'pwsh', label: 'PowerShell 7' };

  it('starts PowerShell in the workspace folder via the cwd option, not a command string', () => {
    const launch = buildLaunch({ profile: ps, executable: 'C:\\pwsh.exe', workspaceRoot: WEIRD, startIn: 'workspace-root', homeDir: 'C:\\Users\\me' });
    expect(launch).toEqual({ file: 'C:\\pwsh.exe', args: ['-NoLogo'], cwd: WEIRD, cwdLabel: WEIRD });
  });

  it('starts WSL with structured --distribution/--cd arguments', () => {
    const linuxPath = "/mnt/c/dir with 'quote' $x;&";
    const launch = buildLaunch({ profile: wsl, executable: 'wsl.exe', workspaceRoot: WEIRD, startIn: 'workspace-root', homeDir: 'C:\\Users\\me', linuxPath });
    expect(launch.args).toEqual(['--distribution', 'Ubuntu-22.04', '--cd', linuxPath]);
    const home = buildLaunch({ profile: wsl, executable: 'wsl.exe', workspaceRoot: WEIRD, startIn: 'home', homeDir: 'C:\\Users\\me' });
    expect(home.args).toEqual(['--distribution', 'Ubuntu-22.04', '--cd', '~']);
    expect(home.cwdLabel).toContain('home');
    expect(() => buildLaunch({ profile: wsl, executable: 'wsl.exe', workspaceRoot: WEIRD, startIn: 'workspace-root', homeDir: 'C:\\' })).toThrow();
  });
});

describe('launch resolver', () => {
  const workspace: Workspace = { id: 'w1', name: 'x', rootPath: WEIRD, layout: null, activePaneId: null };
  const shells = async () => ({
    discovery: {
      profiles: [
        { id: 'windows-powershell', kind: 'windows-powershell' as const, label: 'Windows PowerShell' },
        { id: 'wsl:Ubuntu-22.04', kind: 'wsl' as const, label: 'Ubuntu-22.04', distro: 'Ubuntu-22.04' },
      ],
      wsl: { state: 'available' as const },
      fallbackProfileId: 'windows-powershell',
    },
    executables: new Map([
      ['windows-powershell', 'C:\\ps.exe'],
      ['wsl:Ubuntu-22.04', 'C:\\wsl.exe'],
    ]),
  });
  const base = {
    getWorkspace: (id: string) => (id === 'w1' ? workspace : undefined),
    getShells: shells,
    isDirectory: async () => true,
    exists: async () => true,
    run: (async () => ok('/mnt/c/x')) as Runner,
    env: {},
    homeDir: 'C:\\Users\\me',
  };
  const req = (over: object = {}) => ({ workspaceId: 'w1', paneId: 'p1', profileId: 'windows-powershell', startIn: 'workspace-root' as const, cols: 80, rows: 24, ...over });

  it('reports a missing workspace folder with a home fallback instead of silently starting elsewhere', async () => {
    const resolve = createLaunchResolver({ ...base, isDirectory: async (p) => p !== WEIRD });
    expect(await resolve(req())).toMatchObject({ ok: false, error: { code: 'FOLDER_MISSING', fallback: 'start-in-home' } });
    expect(await resolve(req({ startIn: 'home' }))).toMatchObject({ ok: true, launch: { cwd: 'C:\\Users\\me' } });
  });

  it('rejects unknown profiles, unknown workspaces and missing executables', async () => {
    expect(await createLaunchResolver(base)(req({ profileId: 'pwsh' }))).toMatchObject({ ok: false, error: { code: 'UNKNOWN_PROFILE' } });
    expect(await createLaunchResolver(base)(req({ workspaceId: 'nope' }))).toMatchObject({ ok: false, error: { code: 'WORKSPACE_NOT_FOUND' } });
    expect(await createLaunchResolver({ ...base, exists: async () => false })(req())).toMatchObject({ ok: false, error: { code: 'SHELL_NOT_FOUND' } });
  });

  it('resolves the WSL directory before launching', async () => {
    const resolve = createLaunchResolver(base);
    expect(await resolve(req({ profileId: 'wsl:Ubuntu-22.04' }))).toMatchObject({
      ok: true,
      launch: { file: 'C:\\wsl.exe', args: ['--distribution', 'Ubuntu-22.04', '--cd', '/mnt/c/x'] },
    });
    const failing = createLaunchResolver({ ...base, run: async () => ok('', 3) });
    expect(await failing(req({ profileId: 'wsl:Ubuntu-22.04' }))).toMatchObject({ ok: false, error: { code: 'WSL_PATH_UNMAPPED' } });
  });
});
