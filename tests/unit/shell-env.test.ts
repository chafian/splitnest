import { describe, expect, it } from 'vitest';
import { buildShellEnv, mergeSessionEnv } from '../../src/pty-host/session-manager';

describe('shell environment', () => {
  // Names as found in a process started from inside Claude Code (values are dummies).
  const launchedFromAgent = {
    Path: 'C:\\Windows\\System32',
    USERPROFILE: 'C:\\Users\\me',
    CLAUDECODE: '1',
    CLAUDE_PID: '1234',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_SESSION_ID: 'x',
    CLAUDE_CODE_SESSION_ATTENDED: '1',
    CLAUDE_CODE_MESSAGING_SOCKET: '\\\\.\\pipe\\x',
    CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
    CLAUDE_CODE_TUI_JUST_SWITCHED: '1',
    AI_AGENT: 'claude-code',
    WARP_CLI_AGENT_PROTOCOL_VERSION: '1',
    TERM_PROGRAM: 'vscode',
    TERM_PROGRAM_VERSION: '1.99',
    TW_E2E: '1',
    TW_E2E_PICK_FOLDER: 'C:\\tmp',
    ELECTRON_RUN_AS_NODE: '1',
  };

  it("drops the launching session's markers, sockets and tokens", () => {
    const env = buildShellEnv(launchedFromAgent);
    for (const k of Object.keys(launchedFromAgent)) {
      if (k === 'Path' || k === 'USERPROFILE' || k === 'TERM_PROGRAM') continue;
      expect(env, k).not.toHaveProperty(k);
    }
    expect(env.Path).toBe('C:\\Windows\\System32');
    expect(env.TERM_PROGRAM).toBe('SplitNest');
    expect(env.COLORTERM).toBe('truecolor');
  });

  it("keeps the user's own configuration and keys, including CLAUDE_CODE_* settings", () => {
    const env = buildShellEnv({ CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8000', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', CODEX_HOME: 'C:\\codex', GIT_ASKPASS: 'C:\\my\\askpass.exe' });
    expect(Object.keys(env)).toEqual(expect.arrayContaining(['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_HOME', 'GIT_ASKPASS']));
  });

  it("drops VS Code's terminal hooks and its GIT_ASKPASS, matched case-insensitively", () => {
    const env = buildShellEnv({ vscode_git_askpass_main: 'x', Git_AskPass: 'C:\\vscode\\askpass.sh', VSCODE_GIT_IPC_HANDLE: 'p', WT_SESSION: 'g', Path: 'p' });
    expect(Object.keys(env).sort()).toEqual(['COLORTERM', 'Path', 'TERM_PROGRAM']);
  });

  it('per-session variables are still added on top', () => {
    const env = mergeSessionEnv(buildShellEnv({ Path: 'p', WSLENV: 'A' }), { WSLENV: 'B/u' });
    expect(env.WSLENV).toBe('A:B/u');
  });
});
