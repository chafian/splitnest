// Release workflow: the tag must name exactly the version in package.json.
//   node scripts/release/check-version.mjs v0.2.0
// Prints `version=…` and `prerelease=true|false` (GitHub Actions output format) on success.
import { readFileSync } from 'node:fs';

const tag = process.argv[2] ?? '';
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const m = /^v(\d+\.\d+\.\d+)(-([0-9A-Za-z.-]+))?$/.exec(tag);
if (!m) {
  console.error(`"${tag}" is not a release tag (vX.Y.Z or vX.Y.Z-beta.N).`);
  process.exit(1);
}
const version = tag.slice(1);
if (version !== pkg.version) {
  console.error(`Tag ${tag} does not match package.json version ${pkg.version}. Bump the version and commit it before tagging.`);
  process.exit(1);
}
console.log(`version=${version}`);
console.log(`prerelease=${m[2] ? 'true' : 'false'}`);
