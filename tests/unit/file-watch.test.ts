// Real file-system events (Windows ReadDirectoryChangesW via fs.watch) in a temp folder.
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { contentHash, readTextFile, statTextFile, writeTextFile } from '../../src/main/file-editor';
import { OpenFileWatcher, type WatchTarget } from '../../src/main/file-watch';

let root: string;
let watcher: OpenFileWatcher;
let events: WatchTarget[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitForEvents(n: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (events.length < n) {
    if (Date.now() > deadline) throw new Error(`expected ${n} watch event(s), got ${events.length}`);
    await sleep(20);
  }
}

const target = (rel: string, ownerId = 1): WatchTarget => ({
  ownerId,
  workspaceId: 'w',
  relativePath: rel,
  absolutePath: path.join(root, ...rel.split('/')),
});

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'tw-watch-'));
  mkdirSync(path.join(root, 'src'));
});
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
afterEach(() => {
  watcher?.dispose();
  events = [];
});

function start(debounceMs = 80) {
  watcher = new OpenFileWatcher((t) => events.push(t), { debounceMs });
}

describe('open-file watcher', () => {
  it('reports ordinary writes, coalescing bursts into one notification', async () => {
    writeFileSync(path.join(root, 'src', 'a.ts'), 'one');
    start();
    expect(watcher.watch(target('src/a.ts'))).toBe(true);
    for (let i = 0; i < 5; i++) writeFileSync(path.join(root, 'src', 'a.ts'), `burst ${i}`);
    await waitForEvents(1);
    await sleep(300);
    expect(events).toHaveLength(1);
    expect(events[0]!.relativePath).toBe('src/a.ts');
  });

  it('keeps working through atomic replacement (temp file renamed over the original) and delete + re-create', async () => {
    const file = path.join(root, 'src', 'b.ts');
    writeFileSync(file, 'original');
    start();
    watcher.watch(target('src/b.ts'));
    writeFileSync(path.join(root, 'src', 'b.ts.tmp'), 'replaced');
    renameSync(path.join(root, 'src', 'b.ts.tmp'), file);
    await waitForEvents(1);
    unlinkSync(file);
    await waitForEvents(2);
    writeFileSync(file, 'back again');
    await waitForEvents(3);
    expect(events.every((e) => e.relativePath === 'src/b.ts')).toBe(true);
  });

  it('ignores other files in the folder and stops after unwatch / owner cleanup', async () => {
    writeFileSync(path.join(root, 'src', 'c.ts'), 'c');
    writeFileSync(path.join(root, 'src', 'other.ts'), 'o');
    start();
    watcher.watch(target('src/c.ts', 1));
    watcher.watch(target('src/c.ts', 2));
    expect(watcher.size).toBe(2);
    writeFileSync(path.join(root, 'src', 'other.ts'), 'changed');
    await sleep(400);
    expect(events).toHaveLength(0);
    watcher.unwatch(target('src/c.ts', 1));
    watcher.unwatchOwner(2);
    expect(watcher.size).toBe(0);
    writeFileSync(path.join(root, 'src', 'c.ts'), 'changed');
    await sleep(400);
    expect(events).toHaveLength(0);
  });

  it('enforces the watch limit', () => {
    watcher = new OpenFileWatcher(() => undefined, { maxFiles: 2 });
    for (const n of ['x1', 'x2', 'x3']) writeFileSync(path.join(root, `${n}.txt`), n);
    expect(watcher.watch(target('x1.txt'))).toBe(true);
    expect(watcher.watch(target('x2.txt'))).toBe(true);
    expect(watcher.watch(target('x3.txt'))).toBe(false);
  });
});

describe('content versions for conflict checks', () => {
  it('detects a change even when the timestamp is restored (not mtime-only)', async () => {
    const file = path.join(root, 'same-time.txt');
    writeFileSync(file, 'version one');
    const opened = await readTextFile(root, 'same-time.txt');
    if (!opened.ok) throw new Error('read failed');
    const when = new Date(opened.mtimeMs);
    writeFileSync(file, 'version TWO');
    utimesSync(file, when, when); // e.g. a tool that preserves timestamps
    const stat = await statTextFile(root, 'same-time.txt');
    // Within the old ±1 ms mtime tolerance, i.e. a timestamp check would have called this unchanged.
    expect(stat.ok && Math.abs(stat.mtimeMs - opened.mtimeMs)).toBeLessThan(1);
    expect(stat.ok && stat.hash).not.toBe(opened.hash);
    const save = await writeTextFile(root, { path: 'same-time.txt', content: 'mine', encoding: 'utf8', expectedHash: opened.hash });
    expect(save).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });

  it("recognises the app's own save: the saved hash equals what is on disk", async () => {
    const file = path.join(root, 'own.txt');
    writeFileSync(file, 'start');
    const opened = await readTextFile(root, 'own.txt');
    if (!opened.ok) throw new Error('read failed');
    const saved = await writeTextFile(root, { path: 'own.txt', content: 'saved by SplitNest', encoding: 'utf8', expectedHash: opened.hash });
    const stat = await statTextFile(root, 'own.txt');
    expect(saved.ok && stat.ok && saved.hash === stat.hash).toBe(true);
    expect(saved.ok && saved.hash).toBe(contentHash(Buffer.from('saved by SplitNest')));
  });
});
