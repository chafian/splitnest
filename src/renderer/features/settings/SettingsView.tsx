// Settings as a page in the main area (not a modal): a section list on the left and the
// section's settings on the right, one row per setting (name and explanation, control on the
// right). Opened from the sidebar's ⚙ button, Ctrl+, or the palette; it shows up as a
// "Settings" row under the workspaces while open.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_SETTINGS, LIMITS, type AppInfo, type AppSettings, type DarkThemeId, type ShellDiscovery, type ThemeMode } from '../../../shared/types';
import { THEMES, themeById, type Theme } from '../appearance/themes';
import { api } from '../../api';
import { updateStatusText, type UpdateStatus } from '../../../shared/updates';
import { PRIVACY_URL } from '../updates/UpdateNotices';
import { releaseNotesUrl } from '../updates/whats-new';
import { bugReportUrl, DISCUSSIONS_URL, FEATURE_REQUEST_URL } from '../feedback/links';
import { Icon } from '../../components/Icon';
import { wslGuidance } from '../../components/ProfileMenu';

export type SettingsSection = 'appearance' | 'shells' | 'terminal' | 'explorer' | 'workspaces' | 'notifications' | 'about';

export const SETTINGS_SECTIONS: { id: SettingsSection; title: string }[] = [
  { id: 'appearance', title: 'Appearance' },
  { id: 'shells', title: 'Shells' },
  { id: 'terminal', title: 'Terminal' },
  { id: 'explorer', title: 'File explorer' },
  { id: 'workspaces', title: 'Workspaces' },
  { id: 'notifications', title: 'Notifications' },
  { id: 'about', title: 'About' },
];

interface Props {
  active: boolean;
  section: SettingsSection;
  onSection(section: SettingsSection): void;
  settings: AppSettings;
  /** Windows is in dark app mode (for "Match system"). */
  systemDark: boolean;
  discovery: ShellDiscovery | null;
  effectiveDefault: string | null;
  onChange(patch: Partial<AppSettings>): void;
  onRefreshShells(): void;
  /** Automatic updates (null until known). */
  updateStatus: UpdateStatus | null;
}

const MODES: { id: ThemeMode; label: string }[] = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'system', label: 'Match system' },
];

/** A small picture of the app in a theme's own colours (decorative). */
function ThemePreview({ theme }: { theme: Theme }) {
  const u = theme.ui;
  const a = theme.ansi;
  const bar = (width: string, background: string, opacity = 1) => <span className="theme-card__bar" style={{ width, background, opacity }} />;
  return (
    <span className="theme-card__preview" style={{ background: u.bg }} aria-hidden="true">
      <span className="theme-card__side" style={{ background: u.side, borderColor: u.border }}>
        {bar('80%', u.muted, 0.6)}
        {bar('60%', u.muted, 0.4)}
        {bar('70%', u.muted, 0.4)}
      </span>
      <span className="theme-card__panes">
        <span className="theme-card__pane" style={{ background: u.pane, borderColor: u.border }}>
          {bar('70%', a.blue)}
          {bar('50%', a.green)}
          {bar('80%', u.text, 0.5)}
          {bar('40%', a.yellow)}
        </span>
        <span className="theme-card__pane" style={{ background: u.pane, borderColor: u.focus }}>
          {bar('60%', a.magenta)}
          {bar('75%', u.text, 0.5)}
          <span className="theme-card__button" style={{ background: u.primary }} />
        </span>
      </span>
    </span>
  );
}

function AppearanceSection({ settings, systemDark, onChange }: Pick<Props, 'settings' | 'systemDark' | 'onChange'>) {
  const mode = settings.themeMode;
  const selected: Theme['id'] = mode === 'light' ? 'light' : settings.darkTheme;
  const night = themeById(settings.darkTheme).name;
  const hint =
    mode === 'system'
      ? `Follows Windows: Silver Light by day, ${night} at night${systemDark ? ' (now: night)' : ' (now: day)'}`
      : 'Choose light or dark, or follow your system';
  const pick = (t: Theme) => (t.dark ? onChange({ themeMode: 'dark', darkTheme: t.id as DarkThemeId }) : onChange({ themeMode: 'light' }));
  const isDefault = mode === DEFAULT_SETTINGS.themeMode && settings.darkTheme === DEFAULT_SETTINGS.darkTheme;
  return (
    <>
      <p className="settings-page__lead">Pick a theme. Changes apply instantly.</p>
      <section className="settings-group">
        <Row
          title="Mode"
          hint={hint}
          control={
            <div className="segmented" role="radiogroup" aria-label="Mode">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={mode === m.id}
                  className={`segmented__item${mode === m.id ? ' segmented__item--on' : ''}`}
                  onClick={() => onChange({ themeMode: m.id })}
                >
                  {m.label}
                </button>
              ))}
            </div>
          }
        />
      </section>
      <section className="settings-block">
        <h2 className="settings-block__title" id="theme-heading">
          Theme
        </h2>
        <div className="theme-grid" role="radiogroup" aria-labelledby="theme-heading">
          {THEMES.map((t) => {
            const on = t.id === selected;
            return (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={on}
                data-theme-id={t.id}
                className={`theme-card${on ? ' theme-card--on' : ''}`}
                style={on ? { borderColor: t.ui.focus, boxShadow: `0 0 0 3px ${t.ui.focus}33` } : undefined}
                onClick={() => pick(t)}
              >
                <ThemePreview theme={t} />
                <span className="theme-card__meta">
                  <span className="theme-card__text">
                    <span className="theme-card__name">{t.name}</span>
                    <span className="theme-card__desc">{t.desc}</span>
                  </span>
                  {on && (
                    <span className="theme-card__check" style={{ background: t.ui.focus, color: t.dark ? t.ui.bg : '#ffffff' }}>
                      <Icon name="check" size={12} />
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
        <div className="settings-block__actions">
          <button
            type="button"
            className="button"
            disabled={isDefault}
            onClick={() => onChange({ themeMode: DEFAULT_SETTINGS.themeMode, darkTheme: DEFAULT_SETTINGS.darkTheme })}
          >
            Reset to default
          </button>
        </div>
      </section>
    </>
  );
}

/** On/off switch (a checkbox with role="switch", so it stays keyboard and screen reader friendly). */
function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange(v: boolean): void; label: string; disabled?: boolean }) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" checked={checked} aria-label={label} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch__track" aria-hidden="true">
        <span className="switch__thumb" />
      </span>
    </label>
  );
}

/** Settings › Notifications: agent events, where they show, and a test. */
function NotificationsSection({ settings, onChange }: { settings: AppSettings; onChange(patch: Partial<AppSettings>): void }) {
  const [test, setTest] = useState<{ busy: boolean; result: { ok: boolean; detail: string } | null }>({ busy: false, result: null });
  const runTest = () => {
    setTest({ busy: true, result: null });
    void api
      .testNotification()
      .catch(() => ({ ok: false, detail: 'The test could not be sent.' }))
      .then((result) => setTest({ busy: false, result }));
  };
  const toggle = (key: keyof AppSettings, title: string, hint: ReactNode) => (
    <Row title={title} hint={hint} control={<Switch label={title} checked={settings[key] === true} onChange={(v) => onChange({ [key]: v })} />} />
  );
  return (
    <section className="settings-group">
      {toggle(
        'notifyNeedsYou',
        'Notify when an agent needs you',
        'Claude Code, Codex and other agents that report their state: a permission request, a question, a sign-in, or anything else they wait for. The notification goes away when the agent continues or you open the tab.',
      )}
      {toggle('notifyFinished', 'Notify when an agent finishes', 'When the agent reports that it finished. Not sent if it starts working again within a second and a half.')}
      {toggle('notifyErrors', 'Notify when an agent stops with an error', 'When the agent reports an error.')}
      {toggle(
        'notifyWindows',
        'Windows notifications while SplitNest is in the background',
        <>
          When SplitNest is minimized or another program is in front. Clicking one brings SplitNest back and shows the tab. When this is off, or SplitNest is in front
          with another tab, workspace or Settings shown, a notice with a Show button appears in SplitNest instead. Nothing is shown for the tab you are looking at.
          Windows notifications only come from agents SplitNest found running in the tab (PowerShell tabs); in WSL tabs the agent&apos;s own report is enough.
          Windows lists SplitNest in the Start menu the first time it shows a notification (Windows needs that entry); it opens the copy of SplitNest that last showed
          one.
        </>,
      )}
      {toggle('notifyFlash', 'Flash the taskbar button', 'When an agent needs you while SplitNest is in the background. A dot stays on the taskbar button until you have seen the tab.')}
      {toggle('notifySound', 'Play the notification sound', "Windows' notification sound, for Windows notifications.")}
      {toggle(
        'notifyDetails',
        'Include what the agent wrote',
        "Off by default. Notifications then name the agent, the workspace and the tab's own name only, never the agent's session title or message: both can contain your prompt, file paths or commands, and Windows keeps notifications in Notification Center and may show them on the lock screen.",
      )}
      {toggle('notifyEstimated', 'Also notify for estimated states', 'A terminal bell from an agent that does not report its state ("may need you").')}
      <Row
        title="Test"
        hint={
          <span role="status" aria-live="polite" data-testid="notification-test-result">
            {test.busy
              ? 'Sending…'
              : test.result
                ? test.result.detail
                : 'Sends a Windows notification now, whatever the settings above. Clicking it brings you back here.'}
          </span>
        }
        control={
          <button type="button" className="button button--small" disabled={test.busy} onClick={runTest}>
            Send a test notification
          </button>
        }
      />
    </section>
  );
}

/** Settings › About › Feedback: opens the GitHub issue forms and Discussions in the browser. */
function FeedbackBlock({ version }: { version?: string }) {
  const open = (url: string) => void api.openExternal(url);
  const link = (label: string, url: string, testId: string) => (
    <button type="button" className="button button--small" data-testid={testId} onClick={() => open(url)}>
      {label}
    </button>
  );
  return (
    <section className="settings-block" aria-labelledby="feedback-heading">
      <h2 className="settings-block__title" id="feedback-heading">
        Feedback
      </h2>
      <div className="settings-group">
        <Row
          title="Report a bug"
          hint="Opens the bug report form on GitHub in your browser, with your SplitNest version filled in. Nothing is sent until you submit it. Don't paste tokens, passwords or private terminal output."
          control={link('Report a bug', bugReportUrl(version), 'feedback-bug')}
        />
        <Row
          title="Suggest a feature"
          hint="Opens the feature request form on GitHub. Describe what you're trying to do; the solution can come later."
          control={link('Suggest a feature', FEATURE_REQUEST_URL, 'feedback-feature')}
        />
        <Row
          title="Questions and ideas"
          hint="GitHub Discussions: ask a question, share how you use SplitNest, or talk through an idea before opening an issue."
          control={link('Open Discussions', DISCUSSIONS_URL, 'feedback-discussions')}
        />
      </div>
    </section>
  );
}

function Row({ title, hint, control, id }: { title: string; hint?: ReactNode; control: ReactNode; id?: string }) {
  return (
    <div className="setting" id={id}>
      <div className="setting__text">
        <span className="setting__title">{title}</span>
        {hint && <span className="setting__hint">{hint}</span>}
      </div>
      <div className="setting__control">{control}</div>
    </div>
  );
}

function NumberSetting(props: { value: number; min: number; max: number; step?: number; label: string; onCommit(v: number): void }) {
  const [raw, setRaw] = useState(String(props.value));
  useEffect(() => setRaw(String(props.value)), [props.value]);
  const commit = () => {
    const n = Math.round(Number(raw));
    const v = Number.isFinite(n) ? Math.min(props.max, Math.max(props.min, n)) : props.value;
    setRaw(String(v));
    if (v !== props.value) props.onCommit(v);
  };
  return (
    <input
      className="input setting__number"
      type="number"
      aria-label={props.label}
      min={props.min}
      max={props.max}
      step={props.step}
      value={raw}
      onChange={(e) => setRaw(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  );
}

export function SettingsView({ active, section, onSection, settings, systemDark, discovery, effectiveDefault, onChange, onRefreshShells, updateStatus }: Props) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const navRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    void api.getAppInfo().then(setInfo);
    // Keyboard users land on the section list when the page opens.
    requestAnimationFrame(() => navRef.current?.querySelector<HTMLButtonElement>('[aria-current="page"]')?.focus());
  }, [active]);

  const guidance = wslGuidance(discovery);
  const wslNames = (discovery?.profiles ?? []).filter((p) => p.kind === 'wsl').map((p) => p.label);
  const title = SETTINGS_SECTIONS.find((s) => s.id === section)?.title ?? 'Settings';

  return (
    <div className="settings-view" hidden={!active} role="region" aria-label="Settings">
      <div className="settings-nav" ref={navRef} role="navigation" aria-label="Settings sections">
        {SETTINGS_SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`settings-nav__item${s.id === section ? ' settings-nav__item--active' : ''}`}
            aria-current={s.id === section ? 'page' : undefined}
            onClick={() => onSection(s.id)}
            onKeyDown={(e) => {
              // Up/Down move between sections, like a list.
              if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
              e.preventDefault();
              const i = SETTINGS_SECTIONS.findIndex((x) => x.id === section);
              const next = SETTINGS_SECTIONS[(i + (e.key === 'ArrowDown' ? 1 : SETTINGS_SECTIONS.length - 1)) % SETTINGS_SECTIONS.length]!;
              onSection(next.id);
              requestAnimationFrame(() => navRef.current?.querySelector<HTMLButtonElement>('[aria-current="page"]')?.focus());
            }}
          >
            {s.title}
          </button>
        ))}
      </div>

      <div className="settings-page">
        <div className="settings-page__inner">
          <h1 className="settings-page__title">{title}</h1>

          {section === 'appearance' && <AppearanceSection settings={settings} systemDark={systemDark} onChange={onChange} />}

          {section === 'shells' && (
            <section className="settings-group">
              <Row
                title="Default shell for new terminals"
                hint="Used by New terminal, splits and new tabs unless you pick another shell from the menu."
                control={
                  <select
                    className="select"
                    aria-label="Default shell for new terminals"
                    value={effectiveDefault ?? ''}
                    onChange={(e) => onChange({ defaultProfileId: e.target.value || null })}
                  >
                    {(discovery?.profiles ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.kind === 'wsl' ? `WSL · ${p.label}${p.isDefaultDistro ? ' (WSL default)' : ''}` : p.label}
                      </option>
                    ))}
                  </select>
                }
              />
              <Row
                title="Shell list"
                hint={
                  guidance ? (
                    <>
                      <span className="setting__warn">
                        <Icon name="warning" size={14} /> {guidance}
                      </span>{' '}
                      PowerShell terminals keep working without WSL. To use Linux terminals, install WSL and a distribution yourself (for example
                      by running <code>wsl --install</code> from an administrator terminal, as described in Microsoft’s WSL documentation), then
                      choose Refresh. This app never installs or configures WSL.
                    </>
                  ) : (
                    <>WSL distributions found: {wslNames.join(', ') || 'none'}.</>
                  )
                }
                control={
                  <button type="button" className="button button--small" onClick={onRefreshShells}>
                    <Icon name="restart" size={13} /> Refresh
                  </button>
                }
              />
            </section>
          )}

          {section === 'terminal' && (
            <section className="settings-group">
              <Row
                title="Font size"
                hint={`${LIMITS.fontSize.min}–${LIMITS.fontSize.max} px. Applies to all terminals and editors right away.`}
                control={<NumberSetting label="Font size" value={settings.fontSize} min={LIMITS.fontSize.min} max={LIMITS.fontSize.max} onCommit={(fontSize) => onChange({ fontSize })} />}
              />
              <Row
                title="Scrollback lines"
                hint={`${LIMITS.scrollback.min.toLocaleString()}–${LIMITS.scrollback.max.toLocaleString()} lines kept per terminal, in memory only.`}
                control={
                  <NumberSetting
                    label="Scrollback lines"
                    value={settings.scrollback}
                    min={LIMITS.scrollback.min}
                    max={LIMITS.scrollback.max}
                    step={500}
                    onCommit={(scrollback) => onChange({ scrollback })}
                  />
                }
              />
              <Row
                title="Short folder names in prompts"
                hint={
                  <>
                    PowerShell shows <code>PS car-rental&gt;</code> instead of the full path, and WSL bash shows <code>.../car-rental</code> (via{' '}
                    <code>PROMPT_DIRTRIM=1</code>). Only the built-in prompts change; prompts from your profile, oh-my-posh or Starship are left as
                    they are. Applies to shells started afterwards.
                  </>
                }
                control={<Switch label="Short folder names in prompts" checked={settings.shortPromptPaths} onChange={(v) => onChange({ shortPromptPaths: v })} />}
              />
            </section>
          )}

          {section === 'explorer' && (
            <section className="settings-group">
              <Row
                title="Compact folders"
                hint={
                  <>
                    Folders that only contain one other folder are shown as one row, such as <code>src/main/java</code>. Only the display changes;
                    nothing is renamed or moved. Right-click a part of the row to act on that folder.
                  </>
                }
                control={<Switch label="Compact folders" checked={settings.compactFolders} onChange={(v) => onChange({ compactFolders: v })} />}
              />
            </section>
          )}

          {section === 'workspaces' && (
            <section className="settings-group">
              <Row
                title="Show Git status in the sidebar"
                hint={
                  'Branch of each workspace folder that is in a Git repository, and the lines added and removed since the last commit ' +
                  '(a dot when files changed without changed lines, e.g. a rename). Read-only: SplitNest never changes the repository, and ' +
                  "does not start programs a repository's own Git settings name (then only the branch is shown). Changes inside submodules are not counted. " +
                  'Checked when you select a workspace, come back to SplitNest, save a file, or after terminal output settles. ' +
                  'Needs Git for Windows (git.exe on PATH). A folder that is not a repository itself is not matched with a repository ' +
                  'at your user folder or a drive root. Folders on a Windows drive work whatever the terminal runs, WSL included; ' +
                  'workspaces whose folder is inside WSL (\\\\wsl$\\… or \\\\wsl.localhost\\…) show no Git status in this version.'
                }
                control={<Switch label="Show Git status in the sidebar" checked={settings.showGitStatus} onChange={(v) => onChange({ showGitStatus: v })} />}
              />
              <Row
                title="Show conversation titles for Resume"
                hint={
                  'A terminal where Claude Code, Codex or Gemini CLI was running offers Resume after a restart. With this on, it also shows the ' +
                  "conversation's title (the agent's own name for it), which is saved with the terminal in the state file. A title can " +
                  'contain words from your prompt. Turning this off removes the titles already saved.'
                }
                control={<Switch label="Show conversation titles for Resume" checked={settings.resumeTitles} onChange={(v) => onChange({ resumeTitles: v })} />}
              />
              <Row
                title="Resume agents automatically when the app opens"
                hint={
                  'Off by default: a terminal where Claude Code, Codex or Gemini CLI was running offers Resume after a restart. When on, those ' +
                  'terminals resume their conversation as soon as their workspace is shown: a new shell in the agent\'s folder with ' +
                  'the resume command typed at its prompt. Resuming sends nothing to the agent, but it does start it. In WSL terminals, ' +
                  "and wherever the exact conversation isn't known, the agent's own list of conversations opens instead."
                }
                control={<Switch label="Resume agents automatically when the app opens" checked={settings.resumeAutomatically} onChange={(v) => onChange({ resumeAutomatically: v })} />}
              />
              <Row
                title="Start fresh shells automatically when the app opens"
                hint="Off by default: restored panes show a Start button. When on, a new shell starts in each restored pane, which runs its profile scripts. Previous processes, output and commands are never resumed or replayed."
                control={
                  <Switch
                    label="Start fresh shells automatically when the app opens"
                    checked={settings.startShellsOnRestore}
                    onChange={(v) => onChange({ startShellsOnRestore: v })}
                  />
                }
              />
            </section>
          )}

          {section === 'notifications' && <NotificationsSection settings={settings} onChange={onChange} />}

          {section === 'about' && (
            <section className="settings-group">
              <Row
                title="Check for updates automatically"
                hint={
                  <>
                    SplitNest asks GitHub for new releases shortly after starting and then every few hours,
                    sending only the app version, platform and architecture (plus your IP address, as any web request does). Updates download in the background and
                    are installed when SplitNest restarts. The portable version never checks.{' '}
                    <a href={PRIVACY_URL} onClick={(e) => (e.preventDefault(), void api.openExternal(PRIVACY_URL))}>
                      Privacy policy
                    </a>
                  </>
                }
                control={
                  <Switch
                    label="Check for updates automatically"
                    checked={settings.updateCheck}
                    disabled={updateStatus?.phase === 'unavailable'}
                    onChange={(v) => onChange({ updateCheck: v })}
                  />
                }
              />
              {updateStatus && updateStatus.phase !== 'unavailable' && (
                <Row
                  title="Updates"
                  hint={<span data-testid="update-status">{updateStatusText(updateStatus)}</span>}
                  control={
                    updateStatus.phase === 'ready' ? (
                      <button type="button" className="button button--small button--primary" onClick={() => void api.restartToUpdate()}>
                        Restart now
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="button button--small"
                        data-testid="update-check-now"
                        disabled={updateStatus.phase === 'checking' || updateStatus.phase === 'downloading'}
                        onClick={() => void api.checkForUpdates()}
                      >
                        Check now
                      </button>
                    )
                  }
                />
              )}
              {info && (
                <>
                  <Row
                    title="Version"
                    hint={`${info.productName} ${info.version} (Electron ${info.electron})${info.isPackaged ? '' : ' — development build'}`}
                    control={
                      <button type="button" className="button button--small" data-testid="release-notes" onClick={() => void api.openExternal(releaseNotesUrl(info.version))}>
                        Release notes
                      </button>
                    }
                  />
                  <Row
                    title="Saved state"
                    hint={<code>{info.stateFilePath}</code>}
                    control={
                      <button type="button" className="button button--small" onClick={() => void api.revealStateFile()}>
                        Show in folder
                      </button>
                    }
                  />
                  <Row title="Log file" hint={<code>{info.logFilePath}</code>} control={null} />
                </>
              )}
            </section>
          )}

          {section === 'about' && <FeedbackBlock version={info?.version} />}
        </div>
      </div>
    </div>
  );
}
