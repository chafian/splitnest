import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateStore } from '../../src/main/state-store';
import { emptyState, type PersistedState } from '../../src/shared/types';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tw-state-'));
  file = path.join(dir, 'workspace-state.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sample = (): PersistedState => ({
  ...emptyState(),
  workspaces: [
    {
      id: 'w1',
      name: "Café 'app'",
      rootPath: 'C:\\code\\café app',
      layout: {
        type: 'split',
        id: 's1',
        direction: 'row',
        children: [
          { type: 'pane', id: 'p1', tabs: [{ id: 't1', profileId: 'pwsh' }, { id: 't1b', profileId: 'windows-powershell' }], activeTabId: 't1b' },
          { type: 'pane', id: 'p2', tabs: [{ id: 't2', profileId: 'wsl:Ubuntu-22.04' }], activeTabId: 't2' },
        ],
        sizes: [0.3, 0.7],
      },
      activePaneId: 'p2',
    },
  ],
  activeWorkspaceId: 'w1',
});

describe('StateStore', () => {
  it('starts empty without a file and without a notice', async () => {
    const result = await new StateStore(file).load();
    expect(result.notice).toBeNull();
    expect(result.state.workspaces).toEqual([]);
  });

  it('round-trips workspaces, layout proportions, profiles and active ids', async () => {
    const store = new StateStore(file, undefined, 10);
    store.update(sample());
    await store.flush();
    const loaded = await new StateStore(file).load();
    expect(loaded.notice).toBeNull();
    expect(loaded.state).toEqual(sample());
  });

  it('debounces writes and leaves no temp files behind', async () => {
    const store = new StateStore(file, undefined, 50);
    for (let i = 0; i < 20; i++) store.update({ ...sample(), settings: { ...sample().settings, fontSize: 10 + (i % 10) } });
    await store.flush();
    expect(JSON.parse(readFileSync(file, 'utf8')).settings.fontSize).toBe(19);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('preserves a malformed file and recovers to an empty state', async () => {
    writeFileSync(file, '{ "schemaVersion": 1, "workspaces": [ oops');
    const result = await new StateStore(file).load();
    expect(result.state.workspaces).toEqual([]);
    expect(result.notice?.kind).toBe('recovered-corrupt');
    const backups = readdirSync(dir).filter((f) => f.includes('.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(dir, backups[0]!), 'utf8')).toContain('oops');
  });

  it('preserves a structurally invalid file', async () => {
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, workspaces: [{ id: 'x' }] }));
    const result = await new StateStore(file).load();
    expect(result.notice?.kind).toBe('recovered-corrupt');
  });

  it('preserves a file from an unsupported future version', async () => {
    writeFileSync(file, JSON.stringify({ schemaVersion: 7, workspaces: [] }));
    const result = await new StateStore(file).load();
    expect(result.notice).toMatchObject({ kind: 'unsupported-version', version: 7 });
    expect(readdirSync(dir).some((f) => f.includes('.unsupported-'))).toBe(true);
  });

  it('never persists anything beyond the documented schema', async () => {
    const store = new StateStore(file, undefined, 10);
    store.update(sample());
    await store.flush();
    const keys = Object.keys(JSON.parse(readFileSync(file, 'utf8'))).sort();
    expect(keys).toEqual(['activeWorkspaceId', 'schemaVersion', 'settings', 'workspaces']);
  });
});
