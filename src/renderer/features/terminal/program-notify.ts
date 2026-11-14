// Notifications a program asks the terminal for, with the escape codes other terminals know:
//   OSC 777 ; notify ; <title> ; <body>      (urxvt, Ghostty, WezTerm; `splitnest notify` sends this)
//   OSC 9 ; <message>                        (iTerm2: Codex, Claude Code's "iterm2" channel)
//   OSC 99 ; <metadata> ; <payload>          (kitty: title and body, plain or base64, in chunks)
// OSC 9 followed by a number and `;` (or nothing) is ConEmu's family of commands, not a message:
// Windows Terminal's progress bar (9;4) and current folder (9;9) must never notify.
// The text is the program's: the caller cleans it (plainText) and shows it only when allowed.

export interface ProgramNotice {
  title: string | null;
  body: string | null;
}

const MAX_FIELD = 1024;
const cut = (s: string): string | null => (s.length ? s.slice(0, MAX_FIELD) : null);

/** OSC 9: an iTerm2 message, or null for ConEmu commands (`9;4;…` progress, `9;9;…` folder). */
export function parseOsc9(data: string): ProgramNotice | null {
  if (/^\d+(;|$)/.test(data)) return null;
  const body = cut(data);
  return body ? { title: null, body } : null;
}

/** OSC 777: only `notify;<title>;<body>` (the body may contain `;`). */
export function parseOsc777(data: string): ProgramNotice | null {
  const parts = data.split(';');
  if (parts[0] !== 'notify') return null;
  const title = cut(parts[1] ?? '');
  const body = cut(parts.slice(2).join(';'));
  return title || body ? { title, body } : null;
}

function decodeBase64(s: string): string | null {
  try {
    const bin = atob(s);
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/**
 * OSC 99 (kitty desktop notifications), the basic part: `i=` id, `d=0` more chunks follow,
 * `p=title|body` (default title), `e=1` base64. A notice is complete at the first chunk without
 * `d=0`. Other payload types (buttons, icons, close, queries) are ignored.
 */
export class KittyNotices {
  private readonly open = new Map<string, ProgramNotice>();

  feed(data: string): ProgramNotice | null {
    const sep = data.indexOf(';');
    const meta = sep < 0 ? data : data.slice(0, sep);
    let payload = sep < 0 ? '' : data.slice(sep + 1);
    const keys = new Map<string, string>();
    for (const kv of meta.split(':')) {
      const eq = kv.indexOf('=');
      if (eq > 0) keys.set(kv.slice(0, eq), kv.slice(eq + 1));
    }
    const id = (keys.get('i') ?? '').slice(0, 64);
    const part = keys.get('p') ?? 'title';
    if (part !== 'title' && part !== 'body') return null;
    if (keys.get('e') === '1') payload = decodeBase64(payload) ?? '';
    const n = this.open.get(id) ?? { title: null, body: null };
    const joined = ((n[part] ?? '') + payload).slice(0, MAX_FIELD);
    n[part] = joined.length ? joined : null;
    if (keys.get('d') === '0') {
      if (this.open.size >= 8 && !this.open.has(id)) this.open.clear(); // never grows without bound
      this.open.set(id, n);
      return null;
    }
    this.open.delete(id);
    return n.title || n.body ? n : null;
  }
}
