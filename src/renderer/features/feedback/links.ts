// Where users report bugs, suggest features and ask questions: the GitHub issue forms in
// .github/ISSUE_TEMPLATE and the repository's Discussions. Opening a link sends nothing by itself;
// the bug form only arrives with the app version filled in (a URL parameter the user sees and can
// change before submitting anything).

export const REPO_URL = 'https://github.com/chafian/splitnest';

/** Bug report form, with its `version` field prefilled when the version looks like a version. */
export function bugReportUrl(version?: string): string {
  const url = new URL(`${REPO_URL}/issues/new`);
  url.searchParams.set('template', 'bug_report.yml');
  if (version && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) url.searchParams.set('version', version);
  return url.toString();
}

export const FEATURE_REQUEST_URL = `${REPO_URL}/issues/new?template=feature_request.yml`;
export const DISCUSSIONS_URL = `${REPO_URL}/discussions`;
