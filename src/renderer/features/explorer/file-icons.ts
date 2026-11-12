// Chooses a Material Icon Theme icon name for a file or folder name.
import map from './icon-map.json';

const fileNames = map.fileNames as Record<string, string>;
const folderNames = map.folderNames as Record<string, string>;
const extensions = map.extensions as Record<string, string>;
const patterns = (map.filePatterns as [string, string][]).map(([re, icon]) => [new RegExp(re, 'i'), icon] as const);

export const DEFAULT_FILE_ICON = map.defaultFile;
export const DEFAULT_FOLDER_ICON = map.defaultFolder;

export function fileIconName(name: string): string {
  const lower = name.toLowerCase();
  const exact = fileNames[lower];
  if (exact) return exact;
  for (const [re, icon] of patterns) if (re.test(lower)) return icon;
  const dot = lower.lastIndexOf('.');
  if (dot >= 0 && dot < lower.length - 1) {
    const byExt = extensions[lower.slice(dot + 1)];
    if (byExt) return byExt;
  }
  return DEFAULT_FILE_ICON;
}

export function folderIconName(name: string): string {
  return folderNames[name.toLowerCase()] ?? DEFAULT_FOLDER_ICON;
}

/** Every icon name the map can produce (used to check bundled assets). */
export function allIconNames(): Set<string> {
  return new Set([
    DEFAULT_FILE_ICON,
    DEFAULT_FOLDER_ICON,
    ...Object.values(fileNames),
    ...Object.values(folderNames),
    ...Object.values(extensions),
    ...patterns.map(([, icon]) => icon),
  ]);
}
