import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, qs } from '../api';
import { cx, errMsg } from '../util';
import { Icon } from './Icons';

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
  const addValid = NS_RE.test(adding.trim().toLowerCase());

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
        <span>Namespaces</span>
        <span className="count">{all.length}</span>
        <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setReload((r) => r + 1)} title="Refresh namespaces">
          <Icon name="refresh" size={14} />
        </button>
      </div>
      <form
        className={cx('field-box', adding && !addValid && 'invalid')}
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
        title={adding && !addValid ? 'Lowercase letters, numbers and hyphens only' : 'Add a namespace you can access but cannot list'}
      >
        <Icon name="plus" size={14} />
        <input value={adding} placeholder="Add namespace" onChange={(e) => setAdding(e.target.value)} spellCheck={false} />
        {adding && addValid && (
          <button type="submit" className="btn btn-ghost btn-sm">
            Add
          </button>
        )}
      </form>
      <div className="field-box">
        <Icon name="search" size={14} />
        <input value={filter} placeholder="Filter" onChange={(e) => setFilter(e.target.value)} spellCheck={false} />
      </div>
      {err && <div className={cx('side-msg', err.auth ? 'bad' : 'warn')}>{err.auth ? 'Sign-in needed. Use the banner at the top.' : err.text}</div>}
      {restricted && msg && <div className="side-msg">{msg}</div>}
      <ul className="ns-list">
        {loading && items.length === 0 && (
          <li className="side-loading">
            <span className="spinner" /> Loading
          </li>
        )}
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
                  <Icon name="x" size={12} />
                </span>
              )}
            </button>
          </li>
        ))}
        {!loading && shown.length === 0 && filter && <li className="side-loading">No match</li>}
      </ul>
    </nav>
  );
}
