import { execFile, type ExecFileException } from 'node:child_process';

export interface RunResult {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  notFound: boolean;
  /** Output went past `maxBuffer` (1 MB): the program was stopped and the output is cut off. */
  overflow?: boolean;
}

export interface RunOptions {
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  /** Written to the program's standard input, which is then closed (otherwise it stays open). */
  input?: string;
}

export type Runner = (file: string, args: string[], options: RunOptions) => Promise<RunResult>;

/** Runs an executable with structured arguments (no shell) and never rejects. */
export const runFile: Runner = (file, args, options) =>
  new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      {
        encoding: 'buffer',
        timeout: options.timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: options.env,
        shell: false,
      },
      (error, stdout, stderr) => {
        const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '');
        const err = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? '');
        if (!error) {
          resolve({ code: 0, stdout: out, stderr: err, timedOut: false, notFound: false });
          return;
        }
        const e = error as ExecFileException;
        resolve({
          code: typeof e.code === 'number' ? e.code : null,
          stdout: out,
          stderr: err,
          timedOut: e.killed === true && e.signal === 'SIGTERM' && e.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          notFound: e.code === 'ENOENT',
          overflow: e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        });
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
