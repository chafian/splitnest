// No child_process.fork() in the PTY host.
//
// SplitNest uses the system ConPTY on Windows (see session-manager.ts for why). node-pty 1.1.0
// ends such a session with pty.kill(), which first forks `conpty_console_list_agent` to list the
// console's processes, then closes the pseudoconsole (ClosePseudoConsole), which also ends the
// console's remaining processes. A fork runs process.execPath, which in the packaged app is
// SplitNest itself with "run as Node" disabled: it would start a second SplitNest instance.
//
// This guard answers that one request in-process with the shell's PID (what node-pty itself
// uses when the agent does not answer in time) and refuses every other fork. node-pty then
// kills the shell and closes the pseudoconsole as usual. Nothing in node_modules is changed;
// tests/unit/fork-guard.test.ts checks that node-pty still asks for exactly this agent.
import { EventEmitter } from 'node:events';

// Only node-pty's own agent (node_modules/node-pty/lib/...), also when unpacked from app.asar.
const AGENT = /[\\/]node-pty[\\/]lib[\\/]conpty_console_list_agent(\.js)?$/;

interface ForkableModule {
  fork: (...args: never[]) => unknown;
}

/** A stand-in for the agent's child process: answers once, like the real agent, then "exits". */
class ConsoleListAnswer extends EventEmitter {
  readonly pid = undefined;
  connected = false;
  constructor(pids: number[]) {
    super();
    setImmediate(() => {
      this.emit('message', { consoleProcessList: pids });
      this.emit('exit', 0, null);
    });
  }
  kill(): boolean {
    return true;
  }
  send(): boolean {
    return false;
  }
  disconnect(): void {}
}

/** Replaces `childProcess.fork`; returns a function that puts the original back (tests). */
export function installForkGuard(childProcess: ForkableModule, log: (message: string) => void, answered?: () => void): () => void {
  const original = childProcess.fork;
  const guarded = (modulePath: unknown, args?: unknown): unknown => {
    if (typeof modulePath === 'string' && AGENT.test(modulePath)) {
      const pid = Number(Array.isArray(args) ? args[0] : NaN);
      answered?.();
      return new ConsoleListAnswer(Number.isInteger(pid) && pid > 0 ? [pid] : []);
    }
    log(`refused child_process.fork(${typeof modulePath === 'string' ? modulePath.split(/[\\/]/).pop() : '?'}) in the PTY host`);
    throw new Error('child_process.fork is not available in the SplitNest PTY host');
  };
  childProcess.fork = guarded as ForkableModule['fork'];
  return () => {
    childProcess.fork = original;
  };
}
