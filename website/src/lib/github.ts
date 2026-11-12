import { DOWNLOADS } from '../config/site';

export interface Release {
  tag: string;
  name: string;
  url: string;
  date: string;
  prerelease: boolean;
  body: string;
}

export interface ReleaseInfo {
  /** Version of the latest published release, only when one exists. */
  version: string | null;
  releases: Release[];
}

async function api(url: string): Promise<unknown | null> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'splitnest-website-build',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      console.warn(`[github] ${url} -> HTTP ${res.status}; continuing without release data`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`[github] ${url} failed (${(err as Error).message}); continuing without release data`);
    return null;
  }
}

let cached: Promise<ReleaseInfo> | null = null;

/** Fetched once per build. Never throws: no releases, 404 and rate limits all give an empty result. */
export function getReleaseInfo(): Promise<ReleaseInfo> {
  cached ??= load();
  return cached;
}

async function load(): Promise<ReleaseInfo> {
  const [latest, list] = await Promise.all([api(DOWNLOADS.latestApi), api(`${DOWNLOADS.releasesApi}?per_page=30`)]);

  const releases: Release[] = Array.isArray(list)
    ? list
        .filter((r) => r && !r.draft && typeof r.tag_name === 'string')
        .map((r) => ({
          tag: String(r.tag_name),
          name: String(r.name || r.tag_name),
          url: String(r.html_url),
          date: String(r.published_at || r.created_at || ''),
          prerelease: Boolean(r.prerelease),
          body: String(r.body || ''),
        }))
    : [];

  const tag =
    latest && typeof latest === 'object' && 'tag_name' in latest ? String((latest as { tag_name: unknown }).tag_name) : null;
  const version = tag ? tag.replace(/^v/i, '') : null;
  return { version, releases };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener">$1</a>');
}

/** Minimal, escaping-first renderer for release notes (headings, lists, paragraphs, bold, code, links). */
export function renderNotes(md: string): string {
  const out: string[] = [];
  let list = false;
  const close = () => {
    if (list) {
      out.push('</ul>');
      list = false;
    }
  };
  for (const raw of md.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (h) {
      close();
      const level = Math.min(6, h[1].length + 2);
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
    } else if (li) {
      if (!list) {
        out.push('<ul>');
        list = true;
      }
      out.push(`<li>${inline(li[1])}</li>`);
    } else if (line.trim() === '') {
      close();
    } else {
      close();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  close();
  return out.join('\n');
}
