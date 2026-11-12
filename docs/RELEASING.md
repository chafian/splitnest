# Releasing SplitNest

Releases are built and published only by GitHub Actions ([`release.yml`](../.github/workflows/release.yml)),
from a version tag pushed to this repository. Nobody uploads files by hand.

## Steps

1. Update [`CHANGELOG.md`](../CHANGELOG.md): a section `## X.Y.Z` (it becomes the release notes).
2. Set the version: `npm version X.Y.Z --no-git-tag-version`, commit `package.json`, `package-lock.json`
   and the changelog, and push to `main`. Wait for CI to pass.
3. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`. Only repository admins can create `v*`
   tags (tag ruleset).
4. Watch **Actions → Release**:
   - **test**: the full CI suite;
   - **build**: installer and portable ZIP, checksums, binary inventory (fails on wrong file
     metadata), update-feed consistency, installer smoke test on the runner (install, no update request
     before the first-run notice, self-test, uninstall), build provenance attestation;
   - **sign**: skipped (SignPath is not configured; see [CODE_SIGNING.md](../CODE_SIGNING.md));
   - **publish**: creates a **draft** release with every file, downloads them back and verifies them,
     then publishes it as the latest release and rebuilds the website.
5. If any job fails, nothing is published (at most an unfinished draft remains, which the next run
   replaces). Fix, delete the tag (`git push --delete origin vX.Y.Z`, then locally), and tag again.

A manual run (**Actions → Release → Run workflow**) does test and build only: a dry run that publishes
nothing.

## Release files

| File | What it is |
|---|---|
| `SplitNest-win32-x64-Setup.exe` | Installer (Squirrel.Windows): per user, no admin rights, updates itself |
| `SplitNest-win32-x64-portable.zip` | Portable build: no installer, never checks for updates |
| `RELEASES`, `splitnest-X.Y.Z-full.nupkg` | The update feed that installed copies read (names as Squirrel writes them) |
| `SHA256SUMS.txt` | SHA-256 of every file above and of `BINARIES.md` |
| `BINARIES.md` | Every Windows binary shipped, ours or upstream, with hash, version info and signature |

The names of the installer and the ZIP never change, so the website's
`releases/latest/download/<name>` links always fetch the newest stable release.

## How installed copies update

SplitNest uses Electron's built-in `autoUpdater` (Squirrel.Windows) with the feed
`https://github.com/<repo>/releases/latest/download` (`<repo>` is the repository the release was built
in). Squirrel reads `RELEASES`, downloads the package it names, checks its SHA-1 and size, and installs it
next to the running version; the new version starts at the next launch, or at once with **Restart
now**. A failed or corrupted download leaves the installed version unchanged. "Latest" never includes
prereleases, so a `vX.Y.Z-beta.N` tag is published as a prerelease that stable users do not receive.

## Beta channel (later)

Not built yet. Stable users must keep reading `releases/latest/download`. A beta channel would need its
own feed (for example a small `channels/beta.json` on splitnest.dev that names the newest beta tag,
turned into `releases/download/<tag>` by the app) and a setting to opt in. Nothing in the release
workflow prevents this: prerelease tags are already supported.

## Testing the update path

[`update-test.yml`](../.github/workflows/update-test.yml) installs an older release on a runner and
checks the whole lifecycle against the repository's own releases (no request before the notice,
background download, Restart now, settings kept, notification, corrupted package refused, uninstall).
Run it in a test repository (it publishes test results there), never on the real one.

## Code signing (later)

Disabled. When the SignPath Foundation has approved the project, the `sign` job gets the signing
steps, the secrets are added, and the repository variable `SIGNPATH_ENABLED` is set to `true`. Until
the steps exist, setting the variable makes the release fail rather than publish unsigned files.
