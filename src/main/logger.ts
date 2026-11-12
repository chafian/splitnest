// Lifecycle and error log. Never receives terminal input/output, environment
// variables or credentials; callers pass short, already-redacted messages.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 1024 * 1024;

export interface Logger {
  readonly filePath: string;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function createLogger(filePath: string, mirrorToConsole: boolean): Logger {
  let ready = false;
  const write = (level: string, message: string) => {
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${message.replace(/[\r\n]+/g, ' ').slice(0, 1000)}\n`;
    if (mirrorToConsole) process.stdout.write(line);
    try {
      if (!ready) {
        mkdirSync(path.dirname(filePath), { recursive: true });
        ready = true;
      }
      try {
        if (statSync(filePath).size > MAX_BYTES) renameSync(filePath, `${filePath}.1`);
      } catch {
        // File does not exist yet.
      }
      appendFileSync(filePath, line, 'utf8');
    } catch {
      // Logging must never break the app.
    }
  };
  return {
    filePath,
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
  };
}
