import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, qs } from '../api';
import { buildMatcher, cx, errMsg } from '../util';
import { Icon } from './Icons';

interface Props {
  ctxId: string;
  ns: string;
  kind: 'pod' | 'deployment';
  name: string;
  mode: 'describe' | 'yaml';
  epoch: number;
}

/** Read-only text viewer for `kubectl describe` output and YAML, with find. */
export function TextView({ ctxId, ns, kind, name, mode, epoch }: Props) {
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [cur, setCur] = useState(0);
  const [copied, setCopied] = useState(false);
  const [reload, setReload] = useState(0);
  const box = useRef<HTMLPreElement>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr('');
    api<{ text: string }>(`/api/${mode}?` + qs({ ctx: ctxId, ns, kind, name }))
      .then((r) => alive && setText(r.text))
      .catch((e) => alive && setErr(errMsg(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [ctxId, ns, kind, name, mode, reload, epoch]);

  const matcher = useMemo(() => {
    const m = buildMatcher(query, false, false);
    return m instanceof RegExp ? m : null;
  }, [query]);

  const { nodes, count } = useMemo(() => {
    if (!matcher) return { nodes: text as ReactNode, count: 0 };
    const out: ReactNode[] = [];
    let last = 0;
    let n = 0;
    for (const m of text.matchAll(matcher)) {
      const s = m.index ?? 0;
      if (s > last) out.push(text.slice(last, s));
      out.push(
        <mark key={s} data-m={n}>
          {m[0]}
        </mark>,
      );
      n++;
      last = s + m[0].length;
    }
    out.push(text.slice(last));
    return { nodes: out, count: n };
  }, [text, matcher]);

  useEffect(() => setCur(0), [matcher]);

  const jump = useCallback(
    (dir: 1 | -1) => {
      if (!count) return;
      const next = (cur + dir + count) % count;
      setCur(next);
      box.current?.querySelectorAll('mark.cur').forEach((m) => m.classList.remove('cur'));
      const el = box.current?.querySelector(`mark[data-m="${next}"]`);
      el?.classList.add('cur');
      el?.scrollIntoView({ block: 'center' });
    },
    [count, cur],
  );

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        search.current?.focus();
        search.current?.select();
      }
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <div className="textview">
      <div className="lv-toolbar">
        <div className="lv-search">
          <div className="field-box">
            <Icon name="search" size={14} />
            <input
              ref={search}
              value={query}
              placeholder={`Find in ${mode === 'yaml' ? 'YAML' : 'describe'}`}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') jump(e.shiftKey ? -1 : 1);
                if (e.key === 'Escape') setQuery('');
              }}
            />
          </div>
          <span className="lv-count">{matcher ? `${count ? cur + 1 : 0} / ${count}` : ''}</span>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={() => jump(-1)} disabled={!count} title="Previous">
            <Icon name="chevronUp" size={15} />
          </button>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={() => jump(1)} disabled={!count} title="Next">
            <Icon name="chevronDown" size={15} />
          </button>
        </div>
        <div className="lv-group">
          <button className="btn btn-sm" onClick={copy} disabled={!text}>
            <Icon name={copied ? 'check' : 'copy'} size={14} />
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setReload((r) => r + 1)} title="Refresh">
            <Icon name="refresh" size={15} />
          </button>
        </div>
      </div>
      {err ? (
        <div className="panel-error">{err}</div>
      ) : (
        <pre ref={box} className={cx('tv-pre', loading && !text && 'loading')}>
          {loading && !text ? 'Loading' : nodes}
        </pre>
      )}
    </div>
  );
}
