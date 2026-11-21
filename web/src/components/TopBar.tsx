import { useMemo, useRef, useState } from 'react';
import { useOutsideClick } from '../hooks';
import type { AuthEvent, ContextInfo } from '../types';
import { cx } from '../util';
import { BatEmblem } from './Bat';

interface Props {
  contexts: ContextInfo[];
  current: ContextInfo | undefined;
  armed: boolean;
  authEvents: Record<string, AuthEvent>;
  onContext: (id: string) => void;
  onArm: () => void;
  onDisarm: () => void;
  onVault: () => void;
}

export function TopBar({ contexts, current, armed, authEvents, onContext, onArm, onDisarm, onVault }: Props) {
  return (
    <header className={cx('topbar', armed && 'armed')}>
      <div className="brand">
        <BatEmblem size={40} />
        <div className="wordmark">
          <span className="w1">POD CAVE</span>
          <span className="w2">CAVE COMPUTER · KUBERNETES</span>
        </div>
      </div>
      <ContextPicker contexts={contexts} current={current} authEvents={authEvents} onContext={onContext} />
      <div className="top-actions">
        {armed ? (
          <button className="mode armed" onClick={onDisarm} title="Write actions are enabled. Click to return to read-only Night Watch.">
            <span className="mode-ico">⚠</span>
            <span>
              UTILITY BELT ARMED
              <small>click to disarm</small>
            </span>
          </button>
        ) : (
          <button className="mode" onClick={onArm} title="Read-only. Click to enable write actions for this session.">
            <span className="mode-ico">🛡</span>
            <span>
              NIGHT WATCH
              <small>read-only</small>
            </span>
          </button>
        )}
        <button className="vault-btn" onClick={onVault} title="Manage kubeconfigs">
          <span>🔑</span> Kubeconfigs
        </button>
      </div>
    </header>
  );
}

function ContextPicker({
  contexts,
  current,
  authEvents,
  onContext,
}: {
  contexts: ContextInfo[];
  current: ContextInfo | undefined;
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
      if (f && !c.name.toLowerCase().includes(f) && !c.cluster.toLowerCase().includes(f) && !c.sourceName.toLowerCase().includes(f)) continue;
      const key = c.sourceName;
      m.set(key, [...(m.get(key) ?? []), c]);
    }
    return Array.from(m.entries());
  }, [contexts, q]);

  const host = (s: string) => {
    try {
      return new URL(s).host;
    } catch {
      return s;
    }
  };

  return (
    <div className="ctx-picker" ref={ref}>
      <button className={cx('ctx-current', open && 'open')} onClick={() => setOpen(!open)} disabled={!contexts.length}>
        <span className="ctx-label">CLUSTER</span>
        <span className="ctx-name">{current ? current.name : 'No contexts'}</span>
        {current && authEvents[current.id] && <span className="ctx-alert" title="Sign-in needed">●</span>}
        <span className="caret">▾</span>
      </button>
      {open && (
        <div className="ctx-menu">
          <input autoFocus placeholder="Search contexts…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="ctx-groups">
            {groups.map(([src, list]) => (
              <div key={src}>
                <div className="ctx-group">{src}</div>
                {list.map((c) => (
                  <button
                    key={c.id}
                    className={cx('ctx-item', current?.id === c.id && 'on')}
                    onClick={() => {
                      onContext(c.id);
                      setOpen(false);
                      setQ('');
                    }}
                  >
                    <span className="ctx-item-name">
                      {c.name}
                      {authEvents[c.id] && <span className="ctx-alert">●</span>}
                    </span>
                    <span className="ctx-item-meta">
                      {host(c.server)} · <span className="badge">{c.authType === 'kubelogin' ? `kubelogin ${c.loginMode ?? ''}` : c.authType}</span>
                      {c.insecure && <span className="badge bad">TLS verify off</span>}
                    </span>
                  </button>
                ))}
              </div>
            ))}
            {groups.length === 0 && <div className="muted pad">No matching contexts.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
