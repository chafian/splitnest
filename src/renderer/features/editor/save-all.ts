// Saving every dirty editor before quitting (pure; testable without a DOM).

export interface Savable {
  readonly isDirty: boolean;
  save(): Promise<boolean>;
}

export interface SaveAllOutcome {
  ok: boolean;
  saved: number;
  /** Not written: write error, read-only, or the file changed on disk (conflict). */
  failed: number;
}

/**
 * Saves all dirty items and waits for every write to finish. One failure
 * does not stop the others; the caller decides (quitting only when ok).
 */
export async function saveAllDirty(items: Iterable<Savable>): Promise<SaveAllOutcome> {
  const dirty = [...items].filter((i) => i.isDirty);
  const results = await Promise.all(dirty.map((i) => i.save().catch(() => false)));
  const saved = results.filter(Boolean).length;
  return { ok: saved === dirty.length, saved, failed: dirty.length - saved };
}
