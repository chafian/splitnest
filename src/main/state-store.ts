// Versioned JSON persistence with atomic, debounced writes and recovery from
// malformed files (the original is preserved for troubleshooting).
import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { emptyState, LIMITS, type LoadStateResult, type PersistedState, type Workspace } from '../shared/types';
import { parsePersistedState } from '../shared/validation';
import type { Logger } from './logger';

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Antivirus or indexers can briefly lock the destination on Windows.
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}

export class StateStore {
  private current: PersistedState = emptyState();
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    readonly filePath: string,
    private readonly log?: Logger,
    private readonly debounceMs = 300,
  ) {}

  get state(): PersistedState {
    return this.current;
  }

  getWorkspace(id: string): Workspace | undefined {
    return this.current.workspaces.find((w) => w.id === id);
  }

  async load(): Promise<LoadStateResult> {
    let text: string;
    try {
      const info = await stat(this.filePath);
      if (info.size > LIMITS.maxStateBytes) return this.recover('file is larger than the allowed size');
      text = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.current = emptyState();
        return { state: this.current, notice: null, stateFilePath: this.filePath };
      }
      return this.recover('file could not be read');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text.replace(/^﻿/, ''));
    } catch {
      return this.recover('file is not valid JSON');
    }
    const parsed = parsePersistedState(raw);
    if (parsed.ok) {
      this.current = parsed.state;
      return { state: this.current, notice: null, stateFilePath: this.filePath };
    }
    if (parsed.unsupportedVersion !== undefined) {
      const backupPath = await this.preserve('unsupported');
      this.current = emptyState();
      this.log?.warn(`state file has unsupported schema version; preserved as ${path.basename(backupPath)}`);
      return {
        state: this.current,
        notice: { kind: 'unsupported-version', backupPath, version: parsed.unsupportedVersion },
        stateFilePath: this.filePath,
      };
    }
    return this.recover(parsed.reason);
  }

  private async recover(reason: string): Promise<LoadStateResult> {
    const backupPath = await this.preserve('corrupt');
    this.current = emptyState();
    this.log?.warn(`state file unusable (${reason}); preserved as ${path.basename(backupPath)}`);
    return {
      state: this.current,
      notice: { kind: 'recovered-corrupt', backupPath, reason },
      stateFilePath: this.filePath,
    };
  }

  private async preserve(tag: string): Promise<string> {
    const parsed = path.parse(this.filePath);
    const backupPath = path.join(parsed.dir, `${parsed.name}.${tag}-${timestamp()}${parsed.ext}`);
    try {
      await renameWithRetry(this.filePath, backupPath);
    } catch (error) {
      this.log?.error(`could not preserve state file: ${(error as Error).message}`);
    }
    return backupPath;
  }

  /** Replaces the in-memory state immediately and schedules a debounced write. */
  update(state: PersistedState): void {
    this.current = state;
    this.dirty = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.debounceMs);
  }

  /** Writes pending changes now. Safe to call repeatedly. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return this.chain;
    this.dirty = false;
    const json = JSON.stringify(this.current, null, 2);
    this.chain = this.chain.then(() => this.writeAtomic(json)).catch((error) => {
      this.log?.error(`state write failed: ${(error as Error).message}`);
    });
    return this.chain;
  }

  private async writeAtomic(json: string): Promise<void> {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    const handle = await open(tmp, 'w');
    try {
      await handle.writeFile(json, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await renameWithRetry(tmp, this.filePath);
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
  }
}
