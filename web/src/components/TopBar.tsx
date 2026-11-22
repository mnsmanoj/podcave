import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useOutsideClick } from '../hooks';
import type { AuthEvent, ContextInfo, ThemePref } from '../types';
import { cx, displayName } from '../util';
import { BatEmblem } from './Bat';
import { Icon } from './Icons';

interface Props {
  contexts: ContextInfo[];
  current: ContextInfo | undefined;
  labels: Record<string, string>;
  armed: boolean;
  authEvents: Record<string, AuthEvent>;
  theme: ThemePref;
  forwards: ReactNode;
  onContext: (id: string) => void;
  onArm: () => void;
  onDisarm: () => void;
  onVault: () => void;
  onTheme: (t: ThemePref) => void;
}

const THEME_NEXT: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_ICON = { system: 'monitor', light: 'sun', dark: 'moon' } as const;

export function TopBar({ contexts, current, labels, armed, authEvents, theme, forwards, onContext, onArm, onDisarm, onVault, onTheme }: Props) {
  return (
    <header className="header">
      <div className="brand">
        <BatEmblem size={26} />
        <span className="brand-name">Pod Cave</span>
      </div>
      <ContextPicker contexts={contexts} current={current} labels={labels} authEvents={authEvents} onContext={onContext} />
      <div className="header-actions">
        <div className="seg" role="radiogroup" aria-label="Mode">
          <button className={cx(!armed && 'on')} onClick={() => armed && onDisarm()} role="radio" aria-checked={!armed} title="Read-only. Nothing in the cluster can be changed.">
            Night Watch
          </button>
          <button
            className={cx(armed && 'on ops')}
            onClick={() => !armed && onArm()}
            role="radio"
            aria-checked={armed}
            title="Allows deleting pods, restarting and scaling deployments, and port-forwarding."
          >
            {armed && <span className="ops-dot" />}
            Ops Mode
          </button>
        </div>
        {forwards}
        <button className="btn btn-ghost btn-icon" onClick={() => onTheme(THEME_NEXT[theme])} title={`Theme: ${theme}`}>
          <Icon name={THEME_ICON[theme]} />
        </button>
        <button className="btn" onClick={onVault} title="Manage kubeconfigs">
          Kubeconfigs
        </button>
      </div>
    </header>
  );
}

function ContextPicker({
  contexts,
  current,
  labels,
  authEvents,
  onContext,
}: {
  contexts: ContextInfo[];
  current: ContextInfo | undefined;
  labels: Record<string, string>;
  authEvents: Record<string, AuthEvent>;
  onContext: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClick(ref, () => setOpen(false), open);

  const groups = useMemo(() => {
    const f = q.trim().toLowerCase();
    const m = new Map<string, ContextInfo[]>();
    for (const c of contexts) {
      const hay = [c.name, labels[c.id] ?? '', c.cluster, c.sourceName].join(' ').toLowerCase();
      if (f && !hay.includes(f)) continue;
      m.set(c.sourceName, [...(m.get(c.sourceName) ?? []), c]);
    }
    return Array.from(m.entries());
  }, [contexts, labels, q]);

  const host = (s: string) => {
    try {
      return new URL(s).host;
    } catch {
      return s;
    }
  };

  return (
    <div className="ctx-picker" ref={ref}>
      <button className={cx('ctx-btn', open && 'open')} onClick={() => setOpen(!open)} disabled={!contexts.length} title={current ? `${current.cluster} (${current.sourceName})` : undefined}>
        <span className="ctx-btn-name">{current ? displayName(current.name, labels[current.id]) : 'No clusters'}</span>
        {current && authEvents[current.id] && <span className="alert-dot" title="Sign-in needed" />}
        <Icon name="chevronDown" size={14} />
      </button>
      {open && (
        <div className="popover ctx-menu">
          <div className="field-box">
            <Icon name="search" size={14} />
            <input autoFocus placeholder="Find a cluster" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="menu-scroll">
            {groups.map(([src, list]) => (
              <div key={src}>
                <div className="menu-group">{src}</div>
                {list.map((c) => (
                  <button
                    key={c.id}
                    className={cx('menu-item', current?.id === c.id && 'on')}
                    onClick={() => {
                      onContext(c.id);
                      setOpen(false);
                      setQ('');
                    }}
                  >
                    <span className="menu-item-title">
                      <span className="ellipsis">
                        {c.name}
                        {labels[c.id]?.trim() && <span className="label-part"> - {labels[c.id].trim()}</span>}
                      </span>
                      {authEvents[c.id] && <span className="alert-dot" />}
                      {current?.id === c.id && <Icon name="check" size={14} />}
                    </span>
                    <span className="menu-item-meta">
                      <span className="ellipsis">{host(c.server)}</span>
                      <span>{c.authType === 'kubelogin' ? `kubelogin, ${c.loginMode ?? 'default'}` : c.authType}</span>
                      {c.insecure && <span className="bad-text">TLS verify off</span>}
                    </span>
                  </button>
                ))}
              </div>
            ))}
            {groups.length === 0 && <div className="menu-empty">No matching clusters</div>}
          </div>
        </div>
      )}
    </div>
  );
}
