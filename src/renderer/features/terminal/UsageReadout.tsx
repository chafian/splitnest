// The agent session's tokens, context, time and API-equivalent cost in a pane's header, with the
// details in a panel (see main/agent-usage.ts for where the numbers come from).
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PRICES_AS_OF } from '../../../shared/agent-prices';
import { RESUME_LABEL } from '../../../shared/agent-resume';
import { contextPercent, formatCost, formatDuration, formatTokens, USAGE_COST_NOTE, usageSummary, type AgentUsage } from '../../../shared/agent-usage';

/** Context use from this share on is shown as nearly full. */
const CONTEXT_WARN = 80;

const time = (t: number) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function UsageReadout({ usage, withCost }: { usage: AgentUsage; withCost: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const pct = contextPercent(usage);
  const summary = usageSummary(usage, withCost);
  const agent = RESUME_LABEL[usage.agent];
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`usage-chip${usage.live ? '' : ' usage-chip--ended'}${pct !== null && pct >= CONTEXT_WARN ? ' usage-chip--full' : ''}`}
        data-testid="usage-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${agent} session usage: ${summary}${usage.live ? '' : ' (session ended)'}. Show details`}
        title={`${agent} session${usage.live ? '' : ' (ended)'}: ${summary}\nClick for details.`}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => setOpen((v) => !v)}
      >
        {pct !== null && (
          <span className="usage-chip__meter" aria-hidden="true">
            <span style={{ width: `${Math.max(4, pct)}%` }} />
          </span>
        )}
        <span className="usage-chip__text">
          {pct !== null ? `${pct}%` : `${formatTokens(usage.tokens)}`}
          {withCost && usage.costUsd !== null && <span className="usage-chip__cost"> · {formatCost(usage.costUsd)}</span>}
        </span>
      </button>
      {open && <UsagePanel usage={usage} withCost={withCost} anchor={ref.current} onClose={() => setOpen(false)} />}
    </>
  );
}

function UsagePanel({ usage, withCost, anchor, onClose }: { usage: AgentUsage; withCost: boolean; anchor: HTMLElement | null; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    const a = anchor?.getBoundingClientRect();
    if (!el || !a) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(a.right - r.width, window.innerWidth - r.width - 8)), y: Math.min(a.bottom + 4, window.innerHeight - r.height - 8) });
    el.focus();
  }, [anchor]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('blur', onClose);
    };
  }, [anchor, onClose]);
  const pct = contextPercent(usage);
  const agent = RESUME_LABEL[usage.agent];
  return createPortal(
    <div
      ref={ref}
      className="usage-panel"
      role="dialog"
      aria-label={`${agent} session usage`}
      data-testid="usage-panel"
      tabIndex={-1}
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
          anchor?.focus();
        }
      }}
    >
      <div className="usage-panel__head">
        <strong>{agent} session</strong>
        <span className="usage-panel__state">{usage.live ? 'running' : 'ended'}</span>
      </div>

      {usage.context && (
        <section className="usage-panel__section">
          <h3>Context</h3>
          {pct !== null && (
            <div className={`usage-panel__bar${pct >= CONTEXT_WARN ? ' usage-panel__bar--full' : ''}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Context used">
              <span style={{ width: `${Math.max(1, pct)}%` }} />
            </div>
          )}
          <p>
            {formatTokens(usage.context.used)} tokens in the last request
            {usage.context.limit ? ` of ${formatTokens(usage.context.limit)} (${pct}%)` : ' (the model’s window isn’t known)'}
          </p>
        </section>
      )}

      <section className="usage-panel__section">
        <h3>Tokens · {formatTokens(usage.tokens)}</h3>
        <table className="usage-panel__table">
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col" title="Input not read from a cache">Input</th>
              <th scope="col">Cache read</th>
              <th scope="col">Cache write</th>
              <th scope="col" title="Reasoning included">Output</th>
              {withCost && <th scope="col">Cost</th>}
            </tr>
          </thead>
          <tbody>
            {usage.models.map((m) => (
              <tr key={m.model}>
                <th scope="row" title={`${m.requests} ${m.requests === 1 ? 'reply' : 'replies'}${m.reasoning ? `, ${formatTokens(m.reasoning)} reasoning tokens` : ''}`}>
                  {m.model}
                </th>
                <td>{formatTokens(m.input)}</td>
                <td>{formatTokens(m.cacheRead)}</td>
                <td>{formatTokens(m.cacheWrite)}</td>
                <td>{formatTokens(m.output)}</td>
                {withCost && <td>{m.costUsd === null ? 'unknown' : formatCost(m.costUsd)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
        {usage.subagents > 0 && (
          <p className="usage-panel__note">
            Includes {usage.subagents} {usage.subagents === 1 ? 'subagent' : 'subagents'}.
          </p>
        )}
      </section>

      <section className="usage-panel__section">
        <h3>Time</h3>
        <p>
          {usage.workingMs !== null && <>Working {formatDuration(usage.workingMs)} · </>}
          {usage.startedAt !== null ? `Started ${time(usage.startedAt)}` : 'Start time unknown'}
          {usage.lastAt !== null && ` · Last activity ${time(usage.lastAt)}`}
        </p>
        {usage.workingMs === null && (
          <p className="usage-panel__note">{usage.agent === 'gemini' ? 'Gemini CLI doesn’t record how long its turns take.' : `${agent} hasn’t recorded a finished turn yet.`}</p>
        )}
      </section>

      {withCost && (
        <section className="usage-panel__section">
          <h3>API-equivalent cost</h3>
          <p className="usage-panel__cost">
            {usage.costUsd === null ? 'Unknown: no price for these models.' : `≈ ${formatCost(usage.costUsd)}${usage.costPartial ? ', plus models without a known price' : ''}`}
          </p>
          <p className="usage-panel__note">
            {USAGE_COST_NOTE} Prices as of {PRICES_AS_OF}. Requests the agent doesn’t save in its session file (such as summaries when it compacts) aren’t counted.
          </p>
        </section>
      )}
      <p className="usage-panel__note usage-panel__privacy">Read from {agent}’s own session file on this PC. Only numbers, model names and times are kept; nothing is sent anywhere.</p>
    </div>,
    document.body,
  );
}
