// Starts and talks to the PTY host utility process. The host is restarted on
// demand if it stops; sessions it owned are reported as ended.
import { utilityProcess, type UtilityProcess } from 'electron';
import { PRODUCT } from '../shared/product';
import type { HostEvent, HostRequest } from '../shared/pty-protocol';
import type { HostTransport } from './session-broker';
import type { Logger } from './logger';

export class PtyHostClient implements HostTransport {
  private child: UtilityProcess | null = null;
  private stopping = false;

  constructor(
    private readonly modulePath: string,
    private readonly nodePtyPath: string,
    private readonly onEvent: (event: HostEvent) => void,
    private readonly onHostExit: (reason: string) => void,
    private readonly log: Logger,
  ) {}

  private ensure(): UtilityProcess {
    if (this.child) return this.child;
    this.stopping = false;
    const child = utilityProcess.fork(this.modulePath, [`--node-pty-path=${this.nodePtyPath}`], {
      serviceName: `${PRODUCT.name} PTY Host`,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.log.warn(`pty-host stderr: ${chunk.toString('utf8').split('\n')[0]?.slice(0, 300)}`);
    });
    child.on('message', (message: HostEvent) => {
      if (message?.type === 'log') {
        this.log[message.level](`pty-host: ${message.message}`);
        return;
      }
      if (message?.type === 'ready') {
        this.log.info('pty-host ready');
        return;
      }
      this.onEvent(message);
    });
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      if (!this.stopping) this.log.error(`pty-host exited unexpectedly (code ${code})`);
      this.onHostExit(this.stopping ? 'terminal backend stopped' : 'terminal backend stopped unexpectedly');
    });
    this.child = child;
    return child;
  }

  start(): void {
    this.ensure();
  }

  send(request: HostRequest): void {
    if (!this.child && (request.type === 'kill' || request.type === 'kill-all')) return;
    this.ensure().postMessage(request);
  }

  stop(): void {
    this.stopping = true;
    this.child?.kill();
    this.child = null;
  }
}
