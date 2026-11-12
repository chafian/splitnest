/**
 * Central product identity. Change the name here (and `productName` in
 * package.json, which Electron uses before any code runs) to rebrand.
 */
export const PRODUCT = {
  name: 'SplitNest',
  executableName: 'splitnest',
  appId: 'local.splitnest',
  stateFileName: 'workspace-state.json',
  logFileName: 'splitnest.log',
  /** Earlier names whose saved workspaces are copied over on first start. */
  legacyNames: ['Terminal Workspace'],
} as const;
