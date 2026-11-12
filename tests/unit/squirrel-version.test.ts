import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { squirrelVersion } from '../../scripts/release/squirrel-version.mjs';

const require = createRequire(import.meta.url);
const { convertVersion } = require('electron-winstaller') as { convertVersion: (v: string) => string };

describe('squirrelVersion (release scripts)', () => {
  it.each([
    ['0.2.0', '0.2.0'],
    ['1.10.3', '1.10.3'],
    ['0.2.0-beta.1', '0.2.0-beta1'],
    ['0.2.0-beta.12', '0.2.0-beta12'],
    ['1.0.0-rc.2', '1.0.0-rc2'],
    ['1.0.0-rc.2+build.5', '1.0.0-rc2'],
    ['2.0.0-alpha', '2.0.0-alpha'],
  ])('%s -> %s', (input, expected) => {
    expect(squirrelVersion(input)).toBe(expected);
  });

  it('matches the conversion electron-winstaller uses to name the package and folders', () => {
    for (const v of ['0.2.0', '0.2.0-beta.1', '1.0.0-rc.2', '1.0.0-rc.2+build.5', '3.1.4-beta.1.2']) {
      expect(squirrelVersion(v)).toBe(convertVersion(v));
    }
  });
});
