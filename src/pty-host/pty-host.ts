// Entry point for the PTY host Electron utility process. Shell processes are
// created only here, isolated from the renderer and away from the main
// process event loop.
import { createRequire } from 'node:module';
import type { HostEvent, HostRequest } from '../shared/pty-protocol';
import { SessionManager, type PtyModule } from './session-manager';
import { installForkGuard } from './fork-guard';

interface ParentPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!parentPort) throw new Error('pty-host must run as an Electron utility process');

const post = (event: HostEvent) => parentPort.postMessage(event);

function nodePtyPath(): string {
  const prefix = '--node-pty-path=';
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : 'node-pty';
}

let manager: SessionManager | null = null;
let loadError: string | null = null;
try {
  const load = createRequire(__filename);
  // Before node-pty loads: it must never fork (a fork would start a second SplitNest).
  installForkGuard(
    load('child_process') as Parameters<typeof installForkGuard>[0],
    (message) => post({ type: 'log', level: 'warn', message }),
    () => post({ type: 'log', level: 'info', message: 'session close: console-list request answered in-process (no fork)' }),
  );
  const pty = load(nodePtyPath()) as PtyModule;
  manager = new SessionManager(pty, post);
} catch (error) {
  loadError = error instanceof Error ? error.message.split('\n')[0] ?? 'unknown' : String(error);
  post({ type: 'log', level: 'error', message: `node-pty failed to load: ${loadError}` });
}

parentPort.on('message', ({ data }) => {
  const request = data as HostRequest;
  if (!request || typeof request !== 'object' || typeof request.type !== 'string') return;
  if (!manager) {
    if (request.type === 'spawn') {
      post({ type: 'spawn-failed', sessionId: request.spec.sessionId, message: `terminal backend unavailable: ${loadError}` });
    }
    return;
  }
  manager.handle(request);
});

post({ type: 'ready' });
