import { describe, expect, it } from 'vitest';
import { bugReportUrl, DISCUSSIONS_URL, FEATURE_REQUEST_URL } from '../../src/renderer/features/feedback/links';
import { isAllowedExternalUrl } from '../../src/shared/validation';

describe('feedback links', () => {
  it('opens the bug form with the version filled in', () => {
    const url = new URL(bugReportUrl('0.2.0'));
    expect(url.origin + url.pathname).toBe('https://github.com/chafian/splitnest/issues/new');
    expect(url.searchParams.get('template')).toBe('bug_report.yml');
    expect(url.searchParams.get('version')).toBe('0.2.0');
    expect(new URL(bugReportUrl('0.3.0-beta.1')).searchParams.get('version')).toBe('0.3.0-beta.1');
  });

  it('leaves the version out when it is missing or not a version', () => {
    for (const v of [undefined, '', 'abc', '1.2', '1.2.3 & x=y', '1.2.3\nmore']) {
      const url = new URL(bugReportUrl(v));
      expect(url.searchParams.has('version')).toBe(false);
      expect(url.searchParams.get('template')).toBe('bug_report.yml');
    }
  });

  it('only uses links the main process allows', () => {
    for (const u of [bugReportUrl('0.2.0'), FEATURE_REQUEST_URL, DISCUSSIONS_URL]) {
      expect(isAllowedExternalUrl(u)).toBe(true);
      expect(u.startsWith('https://github.com/chafian/splitnest/')).toBe(true);
    }
  });
});
