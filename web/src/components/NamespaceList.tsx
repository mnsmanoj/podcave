import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, qs } from '../api';
import { cx, errMsg } from '../util';

interface Props {
  ctxId: string;
  selected: string;
  extra: string[];
  epoch: number;
  onSelect: (ns: string) => void;
  onExtra: (list: string[]) => void;
}

const NS_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

export function NamespaceList({ ctxId, selected, extra, epoch, onSelect, onExtra }: Props) {
  const [items, setItems] = useState<string[]>([]);
  const [restricted, setRestricted] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState<{ text: string; auth: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [adding, setAdding] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    api<{ items: string[]; restricted: boolean; message?: string }>('/api/namespaces?' + qs({ ctx: ctxId }))
      .then((r) => {
        if (!alive) return;
        setItems(r.items ?? []);
        setRestricted(r.restricted);
        setMsg(r.message ?? '');
      })
      .catch((e) => alive && setErr({ text: errMsg(e), auth: e instanceof ApiError && !!e.clusterAuth }))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [ctxId, reload, epoch]);

  const all = useMemo(() => Array.from(new Set([...items, ...extra, selected].filter(Boolean))).sort(), [items, extra, selected]);
  const shown = all.filter((n) => n.includes(filter.trim().toLowerCase()));

  const add = () => {
    const n = adding.trim().toLowerCase();
    if (!NS_RE.test(n)) return;
    if (!extra.includes(n)) onExtra([...extra, n]);
    setAdding('');
    onSelect(n);
  };

  return (
    <nav className="sidebar">
      <div className="side-head">
        <span>NAMESPACES</span>
        <span className="count">{all.length}</span>
        <button className="icon" onClick={() => setReload((r) => r + 1)} title="Refresh namespaces">
          ⟳
        </button>
      </div>
      <input className="side-filter" value={filter} placeholder="Filter namespaces" onChange={(e) => setFilter(e.target.value)} />
      {err && <div className={cx('side-msg', err.auth ? 'bad' : 'warn')}>{err.auth ? 'Signal lost — sign in again (see banner).' : err.text}</div>}
      {restricted && msg && <div className="side-msg info">{msg}</div>}
      <ul className="ns-list">
        {loading && items.length === 0 && <li className="muted pad">Scanning the city…</li>}
        {shown.map((n) => (
          <li key={n}>
            <button className={cx('ns', n === selected && 'on')} onClick={() => onSelect(n)}>
              <span className="ns-name">{n}</span>
              {extra.includes(n) && !items.includes(n) && (
                <span
                  className="ns-x"
                  title="Remove from list"
                  onClick={(e) => {
                    e.stopPropagation();
                    onExtra(extra.filter((x) => x !== n));
                  }}
                >
                  ✕
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      <div className="ns-add">
        <input
          value={adding}
          placeholder="+ add namespace"
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          className={cx(adding && !NS_RE.test(adding.trim().toLowerCase()) && 'invalid')}
        />
      </div>
      <div className="skyline" aria-hidden />
    </nav>
  );
}
