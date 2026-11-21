import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { qs, sleep, stream } from '../api';
import type { LogPrefs, Pod, StreamStatus } from '../types';
import { buildMatcher, cx, formatTs } from '../util';

interface Line {
  t: string;
  ft: string;
  m: string;
  lvl: 0 | 1 | 2;
}

const MAX_LINES = 50_000;
const ROW_H = 19;
const WRAP_RENDER_MAX = 3_000;
const TAILS = [100, 500, 1000, 5000, 10000, 50000];
const ERR_RE = /\b(error|err|fatal|panic|exception|critical|crit)\b|\blevel=(error|fatal)\b|"level":"(error|fatal)"/i;
const WARN_RE = /\b(warn|warning)\b|\blevel=warn|"level":"warn/i;

function level(m: string): 0 | 1 | 2 {
  if (ERR_RE.test(m)) return 2;
  if (WARN_RE.test(m)) return 1;
  return 0;
}

const STATUS_LABEL: Record<string, string> = {
  connecting: 'CONNECTING',
  live: 'LIVE',
  'live-resumed': 'LIVE',
  reconnecting: 'RECONNECTING',
  waiting: 'WAITING',
  auth: 'SIGNAL LOST',
  ended: 'ENDED',
  error: 'ERROR',
};

interface Props {
  ctxId: string;
  ns: string;
  pod: Pod;
  prefs: LogPrefs;
  onPrefs: (p: LogPrefs) => void;
  epoch: number;
}

export function LogViewer({ ctxId, ns, pod, prefs, onPrefs, epoch }: Props) {
  const tail = prefs.tail ?? 1000;
  const timestamps = prefs.timestamps ?? false;
  const wrap = prefs.wrap ?? false;

  const [container, setContainer] = useState(pod.containers[0] ?? '');
  const [previous, setPrevious] = useState(false);
  const [restartKey, setRestartKey] = useState(0);
  const [status, setStatus] = useState<StreamStatus>({ state: 'connecting' });
  const [ver, setVer] = useState(0);
  const buf = useRef<Line[]>([]);
  const dropped = useRef(0);

  const [paused, setPaused] = useState(false);
  const frozenAbs = useRef(0);
  const [follow, setFollow] = useState(true);

  const [query, setQuery] = useState('');
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [filterOnly, setFilterOnly] = useState(false);
  const [cur, setCur] = useState(-1);

  const scroller = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);

  const allContainers = useMemo(
    () => [...(pod.initContainers ?? []).map((c) => ({ name: c, init: true })), ...pod.containers.map((c) => ({ name: c, init: false }))],
    [pod.containers, pod.initContainers],
  );

  useEffect(() => {
    if (!allContainers.some((c) => c.name === container) && pod.containers[0]) setContainer(pod.containers[0]);
  }, [allContainers, container, pod.containers]);

  // Stream logs. The server resumes dropped cluster streams without duplicates;
  // if the local connection itself drops we start clean to stay accurate.
  useEffect(() => {
    buf.current = [];
    dropped.current = 0;
    frozenAbs.current = 0;
    setVer((v) => v + 1);
    setFollow(true);
    setPaused(false);
    if (!container) return;
    const ac = new AbortController();
    let dirty = false;
    let last = '';
    const flush = setInterval(() => {
      if (dirty) {
        dirty = false;
        setVer((v) => v + 1);
      }
    }, 120);
    const path = '/api/logs?' + qs({ ctx: ctxId, ns, pod: pod.name, container, tail, previous: previous || undefined });
    (async () => {
      while (!ac.signal.aborted) {
        try {
          await stream(
            path,
            (e) => {
              if (e.type === 'lines') {
                const b = buf.current;
                for (const l of e.lines as { t?: string; m: string }[]) {
                  b.push({ t: l.t ?? '', ft: l.t ? formatTs(l.t) : '', m: l.m, lvl: level(l.m) });
                }
                if (b.length > MAX_LINES) {
                  const cut = b.length - MAX_LINES + Math.floor(MAX_LINES / 10);
                  b.splice(0, cut);
                  dropped.current += cut;
                }
                dirty = true;
              } else if (e.type === 'status') {
                last = e.state;
                setStatus({ state: e.state, message: e.message });
              }
            },
            ac.signal,
          );
        } catch (err) {
          if (ac.signal.aborted) return;
          setStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) });
          if (err instanceof Error && 'status' in err && (err as { status: number }).status < 500) return;
        }
        if (ac.signal.aborted || last === 'ended' || last === 'error') return;
        setStatus({ state: 'reconnecting', message: 'Connection to Pod Cave interrupted; restarting stream…' });
        await sleep(1500, ac.signal);
        buf.current = [];
        dropped.current = 0;
        dirty = true;
      }
    })();
    return () => {
      ac.abort();
      clearInterval(flush);
    };
  }, [ctxId, ns, pod.name, container, previous, tail, restartKey, epoch]);

  const all = buf.current;
  const viewLen = paused ? Math.max(0, Math.min(all.length, frozenAbs.current - dropped.current)) : all.length;
  const pendingNew = paused ? all.length - viewLen : 0;

  const matcher = useMemo(() => buildMatcher(query, regex, caseSensitive), [query, regex, caseSensitive]);
  const matcherErr = matcher instanceof Error ? matcher.message : '';
  const activeMatcher = matcher instanceof RegExp ? matcher : null;

  const matches = useMemo(() => {
    if (!activeMatcher) return [] as number[];
    const test = new RegExp(activeMatcher.source, activeMatcher.flags.replace('g', ''));
    const out: number[] = [];
    for (let i = 0; i < viewLen; i++) if (test.test(all[i].m)) out.push(i);
    return out;
  }, [activeMatcher, viewLen, ver]);

  useEffect(() => setCur(-1), [activeMatcher]);

  const rows: number[] | null = filterOnly && activeMatcher ? matches : null;
  const rowCount = rows ? rows.length : viewLen;
  const rowLine = (r: number) => (rows ? rows[r] : r);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && follow && !paused) el.scrollTop = el.scrollHeight;
  }, [ver, follow, paused, rowCount, wrap]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - ROW_H * 2;
    setFollow(atBottom);
  }, []);

  const jump = useCallback(
    (dir: 1 | -1) => {
      if (!matches.length) return;
      const next = cur < 0 ? (dir === 1 ? 0 : matches.length - 1) : (cur + dir + matches.length) % matches.length;
      setCur(next);
      setFollow(false);
      const row = rows ? next : matches[next];
      const el = scroller.current;
      if (!el) return;
      if (wrap) {
        requestAnimationFrame(() => el.querySelector(`[data-row="${row}"]`)?.scrollIntoView({ block: 'center' }));
      } else {
        el.scrollTop = Math.max(0, row * ROW_H - el.clientHeight / 2);
      }
    },
    [matches, cur, rows, wrap],
  );

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, []);

  const togglePause = () => {
    if (!paused) frozenAbs.current = dropped.current + all.length;
    setPaused(!paused);
    if (paused) setFollow(true);
  };

  const download = () => {
    const text = all
      .slice(0, viewLen)
      .map((l) => (timestamps && l.t ? l.t + ' ' : '') + l.m)
      .join('\n');
    const url = URL.createObjectURL(new Blob([text + '\n'], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${pod.name}_${container}${previous ? '_previous' : ''}.log`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const curLine = cur >= 0 && matches[cur] !== undefined ? matches[cur] : -1;

  const renderRow = (r: number, absolute: boolean) => {
    const i = rowLine(r);
    const l = all[i];
    if (!l) return null;
    return (
      <div
        key={dropped.current + i}
        data-row={r}
        className={cx('log-line', l.lvl === 2 && 'lvl-err', l.lvl === 1 && 'lvl-warn', i === curLine && 'cur-match', wrap && 'wrap')}
        style={absolute ? { top: r * ROW_H } : undefined}
      >
        {timestamps && <span className="log-ts">{l.ft || '—'}</span>}
        <span className="log-msg">{highlight(l.m, activeMatcher)}</span>
      </div>
    );
  };

  let body: ReactNode;
  if (wrap) {
    const start = Math.max(0, rowCount - WRAP_RENDER_MAX);
    const list: ReactNode[] = [];
    for (let r = start; r < rowCount; r++) list.push(renderRow(r, false));
    body = (
      <>
        {start > 0 && <div className="log-note">Wrap mode shows the latest {WRAP_RENDER_MAX.toLocaleString()} lines. Turn wrap off to scroll all {rowCount.toLocaleString()}.</div>}
        {list}
      </>
    );
  } else {
    const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 30);
    const last = Math.min(rowCount, first + Math.ceil(viewH / ROW_H) + 60);
    const list: ReactNode[] = [];
    for (let r = first; r < last; r++) list.push(renderRow(r, true));
    body = (
      <div className="log-canvas" style={{ height: rowCount * ROW_H }}>
        {list}
      </div>
    );
  }

  const st = status.state;
  return (
    <div className="logviewer">
      <div className="log-toolbar">
        <div className="tb-group">
          <select value={container} onChange={(e) => setContainer(e.target.value)} title="Container">
            {allContainers.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
                {c.init ? ' (init)' : ''}
              </option>
            ))}
          </select>
          <select value={tail} onChange={(e) => onPrefs({ ...prefs, tail: Number(e.target.value) })} title="Lines to load initially">
            {TAILS.map((t) => (
              <option key={t} value={t}>
                {t === 50000 ? 'Last 50k (max)' : `Last ${t.toLocaleString()}`}
              </option>
            ))}
          </select>
          <label className="chk" title="Logs of the previous (crashed/restarted) container instance">
            <input type="checkbox" checked={previous} onChange={(e) => setPrevious(e.target.checked)} /> Previous
          </label>
        </div>

        <div className="tb-group search">
          <div className={cx('searchbox', matcherErr && 'invalid')}>
            <input
              ref={searchRef}
              value={query}
              placeholder="Find in logs (Ctrl+F)"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') jump(e.shiftKey ? -1 : 1);
                if (e.key === 'Escape') setQuery('');
              }}
              title={matcherErr || undefined}
            />
            <button className={cx('tgl', caseSensitive && 'on')} onClick={() => setCaseSensitive(!caseSensitive)} title="Match case">
              Aa
            </button>
            <button className={cx('tgl', regex && 'on')} onClick={() => setRegex(!regex)} title="Regular expression">
              .*
            </button>
            <button className={cx('tgl', filterOnly && 'on')} onClick={() => setFilterOnly(!filterOnly)} title="Show only matching lines">
              ⧩
            </button>
          </div>
          <span className="match-count">
            {matcherErr ? 'bad regex' : activeMatcher ? `${matches.length ? (cur >= 0 ? cur + 1 : 0) : 0}/${matches.length.toLocaleString()}` : ''}
          </span>
          <button className="icon" onClick={() => jump(-1)} disabled={!matches.length} title="Previous match (Shift+Enter)">
            ↑
          </button>
          <button className="icon" onClick={() => jump(1)} disabled={!matches.length} title="Next match (Enter)">
            ↓
          </button>
        </div>

        <div className="tb-group">
          <button className={cx('tgl', timestamps && 'on')} onClick={() => onPrefs({ ...prefs, timestamps: !timestamps })} title="Show timestamps">
            🕒
          </button>
          <button className={cx('tgl', wrap && 'on')} onClick={() => onPrefs({ ...prefs, wrap: !wrap })} title="Wrap long lines">
            ↩
          </button>
          <button className={cx('tgl', paused && 'on warn')} onClick={togglePause} title={paused ? 'Resume' : 'Pause view (keeps buffering)'}>
            {paused ? '▶' : '❚❚'}
          </button>
          <button className="icon" onClick={download} title="Download visible logs">
            ⤓
          </button>
          <button className="icon" onClick={() => setRestartKey((k) => k + 1)} title="Clear and reload">
            ⟳
          </button>
        </div>
      </div>

      <div className="log-statusbar">
        <span className={cx('pill', `st-${st}`)}>
          <i />
          {STATUS_LABEL[st] ?? st.toUpperCase()}
        </span>
        <span className="muted">
          {viewLen.toLocaleString()} lines{dropped.current ? ` · ${dropped.current.toLocaleString()} older dropped` : ''}
          {pendingNew > 0 && <b className="new"> · +{pendingNew.toLocaleString()} new while paused</b>}
        </span>
        {status.message && st !== 'live' && <span className="status-msg">{status.message}</span>}
      </div>

      <div className={cx('log-scroll', wrap && 'wrap')} ref={scroller} onScroll={onScroll} tabIndex={0}>
        {rowCount === 0 ? (
          <div className="log-empty">
            {st === 'connecting' || st === 'live' || st === 'live-resumed' ? (
              <>
                <span className="radar" /> Listening on the wire… no log lines yet.
              </>
            ) : filterOnly && activeMatcher ? (
              'No lines match.'
            ) : (
              status.message || 'No logs.'
            )}
          </div>
        ) : (
          body
        )}
      </div>

      {!follow && !paused && rowCount > 0 && (
        <button
          className="follow-btn"
          onClick={() => {
            setFollow(true);
            const el = scroller.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          ⤓ Follow live
        </button>
      )}
    </div>
  );
}

function highlight(text: string, re: RegExp | null): ReactNode {
  if (!re) return text;
  const out: ReactNode[] = [];
  let last = 0;
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) {
    const s = m.index ?? 0;
    if (m[0].length === 0) continue;
    if (s > last) out.push(text.slice(last, s));
    out.push(<mark key={s}>{m[0]}</mark>);
    last = s + m[0].length;
  }
  if (!out.length) return text;
  if (last < text.length) out.push(text.slice(last));
  return out;
}
