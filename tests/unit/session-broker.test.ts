import { describe, expect, it, vi } from 'vitest';
import { SessionBroker, type HostTransport, type LaunchResolver } from '../../src/main/session-broker';
import type { HostRequest } from '../../src/shared/pty-protocol';
import type { SessionEvent } from '../../src/shared/types';

const OWNER = 1;
const OTHER = 2;
const request = (paneId = 'p1') => ({ workspaceId: 'w1', paneId, profileId: 'pwsh', startIn: 'workspace-root', cols: 80, rows: 24 });

function setup(options: { autoSpawn?: boolean; resolver?: LaunchResolver } = {}) {
  const sent: HostRequest[] = [];
  const delivered: { owner: number; event: SessionEvent }[] = [];
  // eslint-disable-next-line prefer-const -- referenced by the transport before assignment
  let broker: SessionBroker;
  let n = 0;
  const transport: HostTransport = {
    send(req) {
      sent.push(req);
      if (req.type === 'spawn' && options.autoSpawn !== false) {
        queueMicrotask(() => broker.handleHostEvent({ type: 'spawned', sessionId: req.spec.sessionId, pid: 1000, repaintsOnResize: true }));
      }
    },
  };
  const resolver: LaunchResolver =
    options.resolver ??
    (async () => ({ ok: true, launch: { file: 'C:\\pwsh.exe', args: ['-NoLogo'], cwd: 'C:\\code', cwdLabel: 'C:\\code' }, profileLabel: 'PowerShell 7' }));
  broker = new SessionBroker(
    transport,
    resolver,
    (owner, event) => {
      delivered.push({ owner, event });
      return true;
    },
    { info: () => undefined, warn: () => undefined },
    { spawnTimeoutMs: 200, idFactory: () => `session-${++n}` },
  );
  return { broker, sent, delivered };
}

describe('SessionBroker', () => {
  it('creates a session with structured launch arguments', async () => {
    const { broker, sent } = setup();
    const result = await broker.create(OWNER, request());
    expect(result).toMatchObject({ ok: true, sessionId: 'session-1', cwdLabel: 'C:\\code' });
    expect(sent[0]).toMatchObject({ type: 'spawn', spec: { file: 'C:\\pwsh.exe', args: ['-NoLogo'], cols: 80, rows: 24 } });
    expect(broker.liveCount(OWNER)).toBe(1);
  });

  it('rejects malformed requests before resolving anything', async () => {
    const resolver = vi.fn();
    const { broker } = setup({ resolver });
    const result = await broker.create(OWNER, { ...request(), cols: -1 });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('passes through structured resolver errors such as unknown profiles', async () => {
    const { broker } = setup({
      resolver: async () => ({ ok: false, error: { code: 'UNKNOWN_PROFILE', message: 'not available' } }),
    });
    expect(await broker.create(OWNER, request())).toMatchObject({ ok: false, error: { code: 'UNKNOWN_PROFILE' } });
  });

  it('enforces session ownership for input, resize, ack and close', async () => {
    const { broker, sent } = setup();
    const created = await broker.create(OWNER, request());
    if (!created.ok) throw new Error('create failed');
    const before = sent.length;
    expect(broker.input(OTHER, created.sessionId, 'whoami\r')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(broker.resize(OTHER, created.sessionId, 100, 30)).toMatchObject({ ok: false });
    expect(broker.ack(OTHER, created.sessionId, 10)).toMatchObject({ ok: false });
    expect(broker.close(OTHER, created.sessionId)).toMatchObject({ ok: false });
    expect(sent.length).toBe(before);
    expect(broker.input(OWNER, created.sessionId, 'whoami\r')).toEqual({ ok: true });
    expect(sent.at(-1)).toEqual({ type: 'input', sessionId: created.sessionId, data: 'whoami\r' });
  });

  it('rejects stale or invented session ids and invalid payloads', async () => {
    const { broker } = setup();
    expect(broker.input(OWNER, 'does-not-exist', 'x')).toMatchObject({ ok: false });
    expect(broker.input(OWNER, { id: 1 }, 'x')).toMatchObject({ ok: false });
    const created = await broker.create(OWNER, request());
    if (!created.ok) throw new Error('create failed');
    expect(broker.input(OWNER, created.sessionId, 'x'.repeat(70_000))).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(broker.input(OWNER, created.sessionId, 42)).toMatchObject({ ok: false });
    expect(broker.resize(OWNER, created.sessionId, 0, 10)).toMatchObject({ ok: false });
    expect(broker.resize(OWNER, created.sessionId, 80, 1e6)).toMatchObject({ ok: false });
    broker.handleHostEvent({ type: 'exit', sessionId: created.sessionId, exitCode: 0 });
    expect(broker.input(OWNER, created.sessionId, 'x')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });

  it('refuses a second concurrent session for the same pane (React double-invocation guard)', async () => {
    const { broker } = setup();
    const [a, b] = await Promise.all([broker.create(OWNER, request()), broker.create(OWNER, request())]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(broker.liveCount()).toBe(1);
  });

  it('routes output only to the owner and drops output for closing sessions', async () => {
    const { broker, delivered } = setup();
    const created = await broker.create(OWNER, request());
    if (!created.ok) throw new Error('create failed');
    broker.handleHostEvent({ type: 'data', sessionId: created.sessionId, data: 'hello' });
    expect(delivered).toEqual([{ owner: OWNER, event: { type: 'data', sessionId: created.sessionId, data: 'hello' } }]);
    broker.close(OWNER, created.sessionId);
    broker.handleHostEvent({ type: 'data', sessionId: created.sessionId, data: 'late' });
    expect(delivered).toHaveLength(1);
    broker.handleHostEvent({ type: 'exit', sessionId: created.sessionId, exitCode: 1 });
    expect(delivered.at(-1)).toMatchObject({ event: { type: 'exit', exitCode: 1 } });
    expect(broker.liveCount()).toBe(0);
  });

  it('reports spawn failures and backend timeouts as structured errors', async () => {
    const { broker } = setup({ autoSpawn: false });
    const result = await broker.create(OWNER, request());
    expect(result).toMatchObject({ ok: false, error: { code: 'SPAWN_FAILED' } });
    expect(broker.liveCount()).toBe(0);
  });

  it('ends every session when the PTY host stops', async () => {
    const { broker, delivered } = setup();
    await broker.create(OWNER, request('p1'));
    await broker.create(OWNER, request('p2'));
    broker.handleHostExit('terminal backend stopped unexpectedly');
    expect(broker.liveCount()).toBe(0);
    expect(delivered.filter((d) => d.event.type === 'exit')).toHaveLength(2);
  });

  it('closes everything owned by a renderer that went away, but nothing else', async () => {
    const { broker, sent } = setup();
    const mine = await broker.create(OWNER, request('p1'));
    const theirs = await broker.create(OTHER, request('p2'));
    if (!mine.ok || !theirs.ok) throw new Error('create failed');
    broker.closeAllForOwner(OWNER);
    const kills = sent.filter((r) => r.type === 'kill').map((r) => (r as { sessionId: string }).sessionId);
    expect(kills).toEqual([mine.sessionId]);
  });

  it('shutdown waits for exits but is bounded', async () => {
    const { broker } = setup();
    await broker.create(OWNER, request());
    const started = Date.now();
    await broker.shutdown(150);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
