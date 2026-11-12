/// <reference types="vite/client" />
// Bundled SVG URLs for the icon subset copied by `npm run icons`.
import { DEFAULT_FILE_ICON, DEFAULT_FOLDER_ICON, fileIconName, folderIconName } from './file-icons';

const modules = import.meta.glob('../../assets/file-icons/*.svg', { eager: true, query: '?url', import: 'default' }) as Record<
  string,
  string
>;
const urls = new Map(Object.entries(modules).map(([file, url]) => [file.slice(file.lastIndexOf('/') + 1, -4), url]));

export function iconUrl(kind: 'file' | 'directory', name: string): string {
  const icon = kind === 'directory' ? folderIconName(name) : fileIconName(name);
  return urls.get(icon) ?? urls.get(kind === 'directory' ? DEFAULT_FOLDER_ICON : DEFAULT_FILE_ICON) ?? '';
}
