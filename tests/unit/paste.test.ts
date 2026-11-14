import { describe, expect, it } from 'vitest';
import { createPasteService, isWindowsPath, MAX_PASTE_IMAGE_BYTES, pasteFileName, quotePath, WSLPATH_SCRIPT, type PasteDeps } from '../../src/main/paste';
import type { RunResult } from '../../src/main/exec';

const DIR = 'C:\\Temp\\SplitNest\\paste';

function fake(over: Partial<PasteDeps> = {}) {
  const files = new Map<string, { data: Buffer; mtime: number }>();
  const runs: { exe: string; args: string[] }[] = [];
  let now = new Date(2026, 10, 14, 9, 5, 7).getTime();
  const runResult: { value: Partial<RunResult> } = { value: {} };
  const deps: PasteDeps = {
    dir: DIR,
    readImagePng: async () => Buffer.from('png-bytes'),
    mkdir: async () => undefined,
    writeFile: async (file, data) => {
      if (files.has(file)) throw new Error('exists');
      files.set(file, { data, mtime: now });
    },
    list: async () => [...files.keys()].map((f) => f.slice(DIR.length + 1)),
    mtimeMs: async (file) => files.get(file)?.mtime ?? null,
    remove: async (file) => {
      files.delete(file);
    },
    now: () => now,
    distroOf: async (id) => (id === 'windows-powershell' ? '' : id === 'wsl:Ubuntu' ? 'Ubuntu' : null),
    run: async (exe, args) => {
      runs.push({ exe, args });
      const linux = args.slice(args.indexOf('splitnest-paste') + 1).map((p) => '/mnt/c/' + p.slice(3).replace(/\\/g, '/'));
      return {
        code: 0,
        stdout: Buffer.from(linux.map((p) => p + '\0').join('')),
        stderr: Buffer.alloc(0),
        timedOut: false,
        notFound: false,
        ...runResult.value,
      } as RunResult;
    },
    wslExe: 'C:\\Windows\\System32\\wsl.exe',
    env: {},
    ...over,
  };
  return { svc: createPasteService(deps), files, runs, runResult, advance: (ms: number) => (now += ms) };
}

describe('pasted image file names and quoting', () => {
  it('names files by local time and a counter', () => {
    expect(pasteFileName(new Date(2026, 0, 2, 3, 4, 5), 7)).toBe('shot-20260102-030405-7.png');
  });

  it('leaves plain paths alone and quotes the rest for each shell', () => {
    expect(quotePath('C:\\Temp\\shot-1.png', false)).toBe('C:\\Temp\\shot-1.png');
    expect(quotePath('C:\\Users\\Ann Lee\\a.png', false)).toBe('"C:\\Users\\Ann Lee\\a.png"');
    // PowerShell would expand $ inside double quotes.
    expect(quotePath("C:\\a$b\\it's.png", false)).toBe("'C:\\a$b\\it''s.png'");
    expect(quotePath('/mnt/c/Temp/shot-1.png', true)).toBe('/mnt/c/Temp/shot-1.png');
    expect(quotePath("/mnt/c/Users/Ann Lee/it's.png", true)).toBe(`'/mnt/c/Users/Ann Lee/it'\\''s.png'`);
  });

  it('accepts only absolute Windows paths', () => {
    expect(isWindowsPath('C:\\a\\b.png')).toBe(true);
    expect(isWindowsPath('\\\\server\\share\\b.png')).toBe(true);
    expect(isWindowsPath('relative\\b.png')).toBe(false);
    expect(isWindowsPath('/etc/passwd')).toBe(false);
    expect(isWindowsPath('C:\\a\nb')).toBe(false);
    expect(isWindowsPath(42)).toBe(false);
  });
});

describe('paste service', () => {
  it('saves the clipboard image and returns its Windows path for PowerShell', async () => {
    const { svc, files, runs } = fake();
    const r = await svc.pasteImage('windows-powershell');
    expect(r).toEqual({ ok: true, text: `${DIR}\\shot-20261114-090507-1.png` });
    expect(files.get(`${DIR}\\shot-20261114-090507-1.png`)?.data.toString()).toBe('png-bytes');
    expect(runs).toHaveLength(0);
    // A second paste in the same second gets its own file.
    expect(await svc.pasteImage('windows-powershell')).toEqual({ ok: true, text: `${DIR}\\shot-20261114-090507-2.png` });
  });

  it('converts to a Linux path with wslpath in that distribution, passing the path as an argument', async () => {
    const { svc, runs } = fake();
    const r = await svc.pasteImage('wsl:Ubuntu');
    expect(r).toEqual({ ok: true, text: '/mnt/c/Temp/SplitNest/paste/shot-20261114-090507-1.png' });
    expect(runs[0]!.args).toEqual(['--distribution', 'Ubuntu', '--exec', 'sh', '-c', WSLPATH_SCRIPT, 'splitnest-paste', `${DIR}\\shot-20261114-090507-1.png`]);
  });

  it('reports a failed conversion instead of typing a wrong path', async () => {
    const { svc, runResult } = fake();
    runResult.value = { code: 3, stdout: Buffer.alloc(0), stderr: Buffer.from('wslpath: bad path') };
    const r = await svc.pasteImage('wsl:Ubuntu');
    expect(r).toMatchObject({ ok: false, reason: 'failed', detail: 'wslpath: bad path' });
    runResult.value = { timedOut: true, code: null as unknown as number };
    expect(await svc.pasteImage('wsl:Ubuntu')).toMatchObject({ ok: false, message: 'Ubuntu did not respond in time.' });
  });

  it('says when there is no image, refuses a too-large one and an unknown shell', async () => {
    expect(await fake({ readImagePng: async () => null }).svc.pasteImage('windows-powershell')).toMatchObject({ ok: false, reason: 'no-image' });
    expect(await fake({ readImagePng: async () => 'too-large' }).svc.pasteImage('windows-powershell')).toMatchObject({ ok: false, reason: 'too-large' });
    expect(await fake({ readImagePng: async () => Buffer.alloc(MAX_PASTE_IMAGE_BYTES + 1) }).svc.pasteImage('windows-powershell')).toMatchObject({
      ok: false,
      reason: 'too-large',
    });
    const { svc, files } = fake();
    expect(await svc.pasteImage('wsl:Gone')).toMatchObject({ ok: false, reason: 'failed' });
    expect(files.size).toBe(0); // nothing is written for a shell that doesn't exist
  });

  it('types the paths of dropped files, quoted, and validates them', async () => {
    const { svc, runs } = fake();
    expect(await svc.filePaths('windows-powershell', ['C:\\code\\a.png', 'C:\\My Pics\\b.jpg'])).toEqual({ ok: true, text: 'C:\\code\\a.png "C:\\My Pics\\b.jpg"' });
    expect(await svc.filePaths('wsl:Ubuntu', ['C:\\code\\a.png', 'C:\\x\\y z.txt'])).toEqual({ ok: true, text: "/mnt/c/code/a.png '/mnt/c/x/y z.txt'" });
    expect(runs[0]!.args.slice(-2)).toEqual(['C:\\code\\a.png', 'C:\\x\\y z.txt']);
    expect(await svc.filePaths('windows-powershell', [])).toMatchObject({ ok: false });
    expect(await svc.filePaths('windows-powershell', ['notabs'])).toMatchObject({ ok: false });
    expect(await svc.filePaths('windows-powershell', 'C:\\a')).toMatchObject({ ok: false });
    expect(await svc.filePaths('windows-powershell', Array(65).fill('C:\\a'))).toMatchObject({ ok: false });
  });

  it('cleans up only its own files once they are old enough', async () => {
    const { svc, files, advance } = fake();
    await svc.pasteImage('windows-powershell');
    files.set(`${DIR}\\notes.txt`, { data: Buffer.alloc(0), mtime: 0 });
    expect(await svc.cleanup(60_000)).toBe(0);
    advance(61_000);
    expect(await svc.cleanup(60_000)).toBe(1);
    expect([...files.keys()]).toEqual([`${DIR}\\notes.txt`]);
    await svc.pasteImage('windows-powershell');
    expect(await svc.cleanup(0)).toBe(1); // at quit: every pasted image
  });
});
