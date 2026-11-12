// Main-process authorization (SessionBroker) wired to the real PTY host
// session manager and real PowerShell, without Electron.
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createLaunchResolver, isDirectory, ShellCache } from '../../src/main/launch-resolver';
import { runFile } from '../../src/main/exec';
import { SessionBroker } from '../../src/main/session-broker';
import { fileExists } from '../../src/main/shells';
import type { SessionEvent, Workspace } from '../../src/shared/types';
import { Harness, IS_WINDOWS, stripAnsi, waitFor } from './helpers';

const OWNER = 11;
const INTRUDER = 99;

describe.skipIf(!IS_WINDOWS)('SessionBroker with real PTY host', () => {
  let h: Harness;
  afterEach(() => h?.dispose());

  it('owner-only access, output routing and exit propagation', async () => {
    h = new Harness();
    const workspace: Workspace = { id: 'w1', name: 'tmp', rootPath: os.tmpdir(), layout: null, activePaneId: null };
    const delivered: { owner: number; event: SessionEvent }[] = [];
    const shells = new ShellCache({ env: process.env, exists: fileExists, run: runFile });
    // eslint-disable-next-line prefer-const -- referenced by the event hook before assignment
    let broker!: SessionBroker;
    // Transport: broker -> manager; manager events -> broker (as the utility process does).
    (h.manager as unknown as { emit: (e: unknown) => void }).emit = (event) => {
      h.events.push(event as never);
      broker.handleHostEvent(event as never);
    };
    broker = new SessionBroker(
      { send: (req) => setImmediate(() => h.manager.handle(req)) },
      createLaunchResolver({
        getWorkspace: (id) => (id === 'w1' ? workspace : undefined),
        getShells: () => shells.get(),
        isDirectory,
        exists: fileExists,
        run: runFile,
        env: process.env,
        homeDir: os.homedir(),
      }),
      (owner, event) => {
        delivered.push({ owner, event });
        if (event.type === 'data') broker.ack(owner, event.sessionId, event.data.length);
        return true;
      },
      { info: () => undefined, warn: () => undefined },
    );

    const created = await broker.create(OWNER, {
      workspaceId: 'w1',
      paneId: 'p1',
      profileId: 'windows-powershell',
      startIn: 'workspace-root',
      cols: 160,
      rows: 30,
    });
    expect(created).toMatchObject({ ok: true, cwdLabel: os.tmpdir(), profileLabel: 'Windows PowerShell' });
    if (!created.ok) return;
    const text = () =>
      stripAnsi(delivered.filter((d) => d.event.type === 'data').map((d) => (d.event.type === 'data' ? d.event.data : '')).join(''));
    await waitFor(() => /PS [A-Z]:\\.*>/.test(text()), 20_000, 'prompt');

    // An intruder cannot type into or close the owner's session.
    expect(broker.input(INTRUDER, created.sessionId, 'exit 9\r').ok).toBe(false);
    expect(broker.close(INTRUDER, created.sessionId).ok).toBe(false);
    expect(delivered.every((d) => d.owner === OWNER)).toBe(true);

    expect(broker.input(OWNER, created.sessionId, 'Write-Output ("OWN" + "ER-OK"); exit 5\r').ok).toBe(true);
    await waitFor(() => delivered.some((d) => d.event.type === 'exit'), 20_000, 'exit');
    expect(text()).toContain('OWNER-OK');
    expect(delivered.find((d) => d.event.type === 'exit')?.event).toMatchObject({ exitCode: 5 });
    expect(broker.liveCount()).toBe(0);
  });
});
