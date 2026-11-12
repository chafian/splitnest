// The version as Squirrel.Windows writes it. electron-winstaller (convertVersion) drops the dots in
// a prerelease part, because NuGet's older version rules don't allow them: 0.2.0 stays 0.2.0, and
// 0.2.0-beta.1 becomes 0.2.0-beta1. That form names the update package
// (splitnest-<v>-full.nupkg), the install folder (app-<v>) and the installed-apps entry's version.
export function squirrelVersion(version) {
  const parts = version.split('+')[0].split('-');
  const main = parts.shift();
  return parts.length > 0 ? [main, parts.join('-').replace(/\./g, '')].join('-') : main;
}
