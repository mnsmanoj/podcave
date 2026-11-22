import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, qs, sleep, stream } from '../api';
import type { LogPrefs, Pod, StreamStatus } from '../types';
import { buildMatcher, cx, formatTs, tsMillis } from '../util';
import { Icon } from './Icons';

interface Line {
  t: string;
  ft: string;
  m: string;
  lvl: 0 | 1 | 2;
}

const MAX_LINES = 50_000;
const ROW_H = 20;
const OVERSCAN = 600;
const TAILS = [100, 500, 1000, 5000, 10000, 50000];
const ERR_RE = /\b(error|err|fatal|panic|exception|critical|crit)\b|\blevel=(error|fatal)\b|"level":"(error|fatal)"/i;
const WARN_RE = /\b(warn|warning)\b|\blevel=warn|"level":"warn/i;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

type RangeKey = 'all' | '5m' | '15m' | '1h' | '6h' | '24h' | 'custom';
const RANGES: { key: RangeKey; label: string; ms: number }[] = [
  { key: 'all', label: 'All time', ms: 0 },
  { key: '5m', label: 'Last 5 min', ms: 5 * 60_000 },
  { key: '15m', label: 'Last 15 min', ms: 15 * 60_000 },
  { key: '1h', label: 'Last hour', ms: 3_600_000 },
  { key: '6h', label: 'Last 6 hours', ms: 6 * 3_600_000 },
  { key: '24h', label: 'Last 24 hours', ms: 24 * 3_600_000 },
  { key: 'custom', label: 'Custom range', ms: 0 },
];

interface Range {
  key: RangeKey;
  from?: number;
  to?: number;
}

function level(m: string): 0 | 1 | 2 {
  if (ERR_RE.test(m)) return 2;
  if (WARN_RE.test(m)) return 1;
  return 0;
}

function clean(m: string): string {
  return m.replace(ANSI_RE, '').replace(/\t/g, '    ').replace(/\r$/, '');
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Value for <input type="datetime-local"> in local time. */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function shortTime(ms: number): string {
  const d = new Date(ms);
  const sameDay = new Date().toDateString() === d.toDateString();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return sameDay ? hm : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

/** Largest r with o[r] <= y (clamped to a valid row). */
function rowAt(o: Float64Array, y: number): number {
  let lo = 0;
  let hi = o.length - 2;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (o[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const STATUS_LABEL: Record<string, string> = {
  connecting: 'Connecting',
  live: 'Live',
  'live-resumed': 'Live',
  reconnecting: 'Reconnecting',
  waiting: 'Waiting for container',
  auth: 'Sign-in needed',
  ended: 'Ended',
  error: 'Error',
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
  const wrap = prefs.wrap ?? true;

  const [container, setContainer] = useState(pod.containers[0] ?? '');
  const [previous, setPrevious] = useState(false);
  const [restartKey, setRestartKey] = useState(0);
  const [status, setStatus] = useState<StreamStatus>({ state: 'connecting' });
  const [ver, setVer] = useState(0);
  const buf = useRef<Line[]>([]);
  const dropped = useRef(0);
  const gen = useRef(0);

  const [pick, setPick] = useState<RangeKey>('all');
  const [range, setRange] = useState<Range>({ key: 'all' });
  const [draftFrom, setDraftFrom] = useState(() => toLocalInput(Date.now() - 3_600_000));
  const [draftTo, setDraftTo] = useState('');

  const [paused, setPaused] = useState(false);
  const frozenAbs = useRef(0);
  const [follow, setFollow] = useState(true);

  const [query, setQuery] = useState('');
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [flash, setFlash] = useState(-1);
  const pendingJump = useRef<number | null>(null);

  const scroller = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const probeMsg = useRef<HTMLSpanElement>(null);
  const probeChars = useRef<HTMLSpanElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  const [cols, setCols] = useState(0);
  const corr = useRef(new Map<number, number>());
  const corrKey = useRef('');
  const [corrVer, setCorrVer] = useState(0);
  const offsetsRef = useRef(new Float64Array(1));
  const topRow = useRef(0);
  const prevCols = useRef(0);

  const allContainers = useMemo(
    () => [...(pod.initContainers ?? []).map((c) => ({ name: c, init: true })), ...pod.containers.map((c) => ({ name: c, init: false }))],
    [pod.containers, pod.initContainers],
  );

  useEffect(() => {
    if (!allContainers.some((c) => c.name === container) && pod.containers[0]) setContainer(pod.containers[0]);
  }, [allContainers, container, pod.containers]);

  // The server resumes dropped cluster streams without duplicates. If the
  // connection to Pod Cave itself drops we start clean to stay accurate.
  useEffect(() => {
    buf.current = [];
    dropped.current = 0;
    frozenAbs.current = 0;
    gen.current++;
    corr.current.clear();
    setVer((v) => v + 1);
    setFollow(true);
    setPaused(false);
    setStatus({ state: 'connecting' });
    if (!container) return;

    let since: string | undefined;
    let until = Infinity;
    let follow = true;
    let tailN = tail;
    const preset = RANGES.find((r) => r.key === range.key)?.ms ?? 0;
    if (preset) {
      since = new Date(Date.now() - preset).toISOString();
      tailN = MAX_LINES;
    } else if (range.key === 'custom' && range.from !== undefined) {
      since = new Date(range.from).toISOString();
      tailN = 0;
      if (range.to !== undefined) {
        until = range.to;
        follow = until > Date.now();
      }
    }

    const ac = new AbortController();
    let dirty = false;
    let last = '';
    const flush = setInterval(() => {
      if (dirty) {
        dirty = false;
        setVer((v) => v + 1);
      }
    }, 120);
    const path =
      '/api/logs?' +
      qs({ ctx: ctxId, ns, pod: pod.name, container, tail: tailN, since, follow: follow ? undefined : 'false', previous: previous || undefined });

    (async () => {
      while (!ac.signal.aborted) {
        const done = new AbortController();
        let pastEnd = false;
        try {
          await stream(
            path,
            (e) => {
              if (pastEnd) return;
              if (e.type === 'lines') {
                const b = buf.current;
                for (const l of e.lines as { t?: string; m: string }[]) {
                  const t = l.t ?? '';
                  if (t && tsMillis(t) > until) {
                    pastEnd = true;
                    done.abort();
                    break;
                  }
                  const m = clean(l.m);
                  b.push({ t, ft: t ? formatTs(t) : '', m, lvl: level(m) });
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
            AbortSignal.any([ac.signal, done.signal]),
          );
        } catch (err) {
          if (ac.signal.aborted) return;
          setStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) });
          if (err instanceof ApiError && err.status < 500) return;
        }
        if (ac.signal.aborted) return;
        if (pastEnd) {
          setStatus({ state: 'ended', message: 'End of the selected time range' });
          return;
        }
        if (last === 'ended' || last === 'error') return;
        setStatus({ state: 'reconnecting', message: 'Lost the connection to Pod Cave. Restarting the stream.' });
        await sleep(1500, ac.signal);
        buf.current = [];
        dropped.current = 0;
        gen.current++;
        dirty = true;
      }
    })();
    return () => {
      ac.abort();
      clearInterval(flush);
    };
  }, [ctxId, ns, pod.name, container, previous, tail, range, restartKey, epoch]);

  const all = buf.current;
  const viewLen = paused ? Math.max(0, Math.min(all.length, frozenAbs.current - dropped.current)) : all.length;
  const pendingNew = paused ? all.length - viewLen : 0;

  const matcher = useMemo(() => buildMatcher(query, regex, caseSensitive), [query, regex, caseSensitive]);
  const matcherErr = matcher instanceof Error ? matcher.message : '';
  const activeMatcher = matcher instanceof RegExp ? matcher : null;

  // Matching lines are tracked by absolute index and scanned incrementally,
  // so filtering a busy stream only tests the lines that just arrived.
  const filt = useRef<{ re: RegExp; test: RegExp; gen: number; abs: number[]; scanned: number } | null>(null);
  const rows = useMemo(() => {
    if (!activeMatcher) {
      filt.current = null;
      return null;
    }
    const d = dropped.current;
    let f = filt.current;
    if (!f || f.re !== activeMatcher || f.gen !== gen.current) {
      f = { re: activeMatcher, test: new RegExp(activeMatcher.source, activeMatcher.flags.replace('g', '')), gen: gen.current, abs: [], scanned: d };
      filt.current = f;
    }
    let head = 0;
    while (head < f.abs.length && f.abs[head] < d) head++;
    if (head) f.abs.splice(0, head);
    if (f.scanned < d) f.scanned = d;
    const end = d + viewLen;
    for (let a = f.scanned; a < end; a++) if (f.test.test(all[a - d].m)) f.abs.push(a);
    if (end > f.scanned) f.scanned = end;
    const out: number[] = [];
    for (const a of f.abs) {
      if (a >= end) break;
      out.push(a - d);
    }
    return out;
  }, [activeMatcher, ver, viewLen]);

  const n = rows ? rows.length : viewLen;
  const lineAt = (r: number) => (rows ? rows[r] : r);

  // Measure how many monospace characters fit in the message column. Rows are
  // sized from that, so wrapping follows the panel width and browser zoom.
  useLayoutEffect(() => {
    const el = scroller.current;
    const pm = probeMsg.current;
    const pc = probeChars.current;
    if (!el || !pm || !pc) return;
    const measure = () => {
      setViewH(el.clientHeight);
      const cw = pc.getBoundingClientRect().width / 100;
      const w = pm.getBoundingClientRect().width;
      if (cw > 0 && w > 0) setCols(Math.max(10, Math.floor((w + 0.01) / cw)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(pm);
    document.fonts?.ready.then(measure).catch(() => {});
    return () => ro.disconnect();
  }, []);

  const offsets = useMemo(() => {
    const key = `${cols}|${timestamps}|${gen.current}`;
    if (corrKey.current !== key) {
      corr.current.clear();
      corrKey.current = key;
    }
    const o = new Float64Array(n + 1);
    const c = corr.current;
    const d = dropped.current;
    for (let r = 0; r < n; r++) {
      const i = rows ? rows[r] : r;
      let h = ROW_H;
      if (wrap && cols > 0) h = c.get(d + i) ?? ROW_H * Math.max(1, Math.ceil(all[i].m.length / cols));
      o[r + 1] = o[r] + h;
    }
    return o;
  }, [n, rows, cols, wrap, timestamps, ver, corrVer]);
  offsetsRef.current = offsets;

  // Wide characters (emoji, CJK) can wrap differently; record real heights.
  useLayoutEffect(() => {
    if (!wrap || !canvas.current) return;
    let changed = false;
    canvas.current.querySelectorAll<HTMLElement>('.lv-line[data-a]').forEach((el) => {
      const got = el.offsetHeight;
      if (got && got !== Number(el.dataset.h)) {
        corr.current.set(Number(el.dataset.a), got);
        changed = true;
      }
    });
    if (changed) setCorrVer((v) => v + 1);
  });

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (pendingJump.current !== null && !rows) {
      const r = pendingJump.current - dropped.current;
      if (r >= 0 && r < n) {
        el.scrollTop = Math.max(0, offsets[r] - el.clientHeight / 2);
        const a = pendingJump.current;
        setFlash(a);
        setTimeout(() => setFlash((f) => (f === a ? -1 : f)), 1800);
      }
      pendingJump.current = null;
      return;
    }
    if (prevCols.current !== cols) {
      prevCols.current = cols;
      if (!follow) {
        el.scrollTop = offsets[Math.min(topRow.current, n)] ?? 0;
        return;
      }
    }
    if (follow && !paused) el.scrollTop = el.scrollHeight;
  }, [offsets, follow, paused, cols]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    topRow.current = rowAt(offsetsRef.current, el.scrollTop);
    setFollow(el.scrollTop + el.clientHeight >= el.scrollHeight - ROW_H * 1.5);
  };

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

  const changeQuery = (q: string) => {
    setQuery(q);
    setFollow(true);
  };

  const showInContext = (abs: number) => {
    pendingJump.current = abs;
    setFollow(false);
    setQuery('');
  };

  const togglePause = () => {
    if (!paused) frozenAbs.current = dropped.current + all.length;
    setPaused(!paused);
    if (paused) setFollow(true);
  };

  const followNow = () => {
    setFollow(true);
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const pickRange = (k: RangeKey) => {
    setPick(k);
    if (k !== 'custom') setRange({ key: k });
  };

  const fromMs = draftFrom ? new Date(draftFrom).getTime() : NaN;
  const toMs = draftTo ? new Date(draftTo).getTime() : undefined;
  const customErr = isNaN(fromMs) ? 'Pick a start time' : toMs !== undefined && toMs <= fromMs ? 'End must be after start' : '';
  const applyCustom = () => {
    if (!customErr) setRange({ key: 'custom', from: fromMs, to: toMs });
  };

  const download = () => {
    const out: string[] = [];
    for (let r = 0; r < n; r++) {
      const l = all[lineAt(r)];
      out.push((timestamps && l.t ? l.t + ' ' : '') + l.m);
    }
    const url = URL.createObjectURL(new Blob([out.join('\n') + '\n'], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${pod.name}_${container}${previous ? '_previous' : ''}${rows ? '_filtered' : ''}.log`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const d = dropped.current;
  const digits = String(d + viewLen).length;
  const list: ReactNode[] = [];
  if (n > 0) {
    const hi = scrollTop + viewH + OVERSCAN;
    for (let r = rowAt(offsets, Math.max(0, scrollTop - OVERSCAN)); r < n && offsets[r] < hi; r++) {
      const i = lineAt(r);
      const l = all[i];
      if (!l) continue;
      const a = d + i;
      list.push(
        <div
          key={a}
          data-a={a}
          data-h={offsets[r + 1] - offsets[r]}
          className={cx('lv-line', l.lvl === 2 && 'err', l.lvl === 1 && 'warn', a === flash && 'flash')}
          style={{ top: offsets[r] }}
        >
          {rows ? (
            <button className="lv-num link" onClick={() => showInContext(a)} title="Show this line in context">
              {a + 1}
            </button>
          ) : (
            <span className="lv-num">{a + 1}</span>
          )}
          {timestamps && <span className="lv-ts">{l.ft}</span>}
          <span className="lv-msg" style={wrap && cols ? { width: `calc(${cols}ch + 0.5px)` } : undefined}>
            {highlight(l.m, activeMatcher)}
          </span>
        </div>,
      );
    }
  }

  const st = status.state;
  const live = st === 'live' || st === 'live-resumed';
  const rangeText =
    range.key === 'custom' && range.from !== undefined
      ? `${shortTime(range.from)} to ${range.to !== undefined ? shortTime(range.to) : 'now'}`
      : range.key !== 'all'
        ? RANGES.find((r) => r.key === range.key)?.label
        : '';

  let empty: ReactNode = null;
  if (n === 0) {
    if (rows && viewLen > 0) empty = <>No lines match <span className="mono">{query}</span></>;
    else if (st === 'connecting')
      empty = (
        <>
          <span className="spinner" /> Loading logs
        </>
      );
    else if (live) empty = range.key === 'all' ? 'Waiting for new lines' : 'No lines in this range yet. New lines will show up here.';
    else if (st === 'ended' && range.key !== 'all') empty = 'No lines in this time range.';
    else empty = status.message || 'No logs.';
  }

  return (
    <div className="logviewer">
      <div className="lv-toolbar">
        <div className="lv-row">
          <select className="select select-sm" value={container} onChange={(e) => setContainer(e.target.value)} title="Container">
            {allContainers.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
                {c.init ? ' (init)' : ''}
              </option>
            ))}
          </select>
          <select className="select select-sm" value={pick} onChange={(e) => pickRange(e.target.value as RangeKey)} title="Time range">
            {RANGES.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
          {range.key === 'all' && pick === 'all' && (
            <select className="select select-sm" value={tail} onChange={(e) => onPrefs({ ...prefs, tail: Number(e.target.value) })} title="How many recent lines to load">
              {TAILS.map((t) => (
                <option key={t} value={t}>
                  Last {t.toLocaleString()} lines
                </option>
              ))}
            </select>
          )}
          <button className={cx('btn btn-sm', previous && 'on')} onClick={() => setPrevious(!previous)} title="Logs from the previous container, useful after a crash or restart">
            Previous container
          </button>
          <span className="lv-spacer" />
          <button className={cx('btn btn-ghost btn-sm btn-icon', timestamps && 'on')} onClick={() => onPrefs({ ...prefs, timestamps: !timestamps })} title="Show timestamps">
            <Icon name="clock" size={15} />
          </button>
          <button className={cx('btn btn-ghost btn-sm btn-icon', wrap && 'on')} onClick={() => onPrefs({ ...prefs, wrap: !wrap })} title={wrap ? 'Wrapping long lines' : 'Wrap long lines'}>
            <Icon name="wrap" size={15} />
          </button>
          <button className={cx('btn btn-ghost btn-sm btn-icon', paused && 'on')} onClick={togglePause} title={paused ? 'Resume' : 'Pause (new lines keep buffering)'}>
            <Icon name={paused ? 'play' : 'pause'} size={15} />
          </button>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={download} title={rows ? 'Download matching lines' : 'Download'}>
            <Icon name="download" size={15} />
          </button>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setRestartKey((k) => k + 1)} title="Reload">
            <Icon name="refresh" size={15} />
          </button>
        </div>

        {pick === 'custom' && (
          <div className="lv-row lv-range">
            <label>
              <span>From</span>
              <input type="datetime-local" className="input input-sm" value={draftFrom} onChange={(e) => setDraftFrom(e.target.value)} />
            </label>
            <label>
              <span>To</span>
              <input type="datetime-local" className="input input-sm" value={draftTo} onChange={(e) => setDraftTo(e.target.value)} />
            </label>
            {draftTo && (
              <button className="btn btn-ghost btn-sm" onClick={() => setDraftTo('')} title="Keep streaming new lines">
                Until now
              </button>
            )}
            <button className="btn btn-sm btn-primary" disabled={!!customErr} onClick={applyCustom}>
              Apply
            </button>
            <span className="muted small">{customErr || (draftTo ? 'Shows lines between the two times.' : 'Leave To empty to keep following new lines.')}</span>
          </div>
        )}

        <div className="lv-row">
          <div className={cx('field-box lv-search', matcherErr && 'invalid')}>
            <Icon name="search" size={14} />
            <input
              ref={searchRef}
              value={query}
              placeholder="Filter lines"
              onChange={(e) => changeQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && changeQuery('')}
              title={matcherErr || 'Only lines that match are shown. Ctrl+F to focus, Esc to clear.'}
              spellCheck={false}
            />
            {query && (
              <button className="lv-toggle" onClick={() => changeQuery('')} title="Clear">
                <Icon name="x" size={13} />
              </button>
            )}
            <button className={cx('lv-toggle', caseSensitive && 'on')} onClick={() => setCaseSensitive(!caseSensitive)} title="Match case">
              Aa
            </button>
            <button className={cx('lv-toggle', regex && 'on')} onClick={() => setRegex(!regex)} title="Regular expression">
              .*
            </button>
          </div>
          <span className="lv-count">
            {matcherErr ? 'Invalid pattern' : rows ? `${n.toLocaleString()} of ${viewLen.toLocaleString()} lines` : `${viewLen.toLocaleString()} lines`}
          </span>
        </div>
      </div>

      <div className={cx('lv-scroll', wrap ? 'wrap' : 'nowrap')} ref={scroller} onScroll={onScroll} tabIndex={0}>
        <div className="lv-canvas" ref={canvas} style={{ height: offsets[n] + 12, ['--num-w' as string]: `${Math.max(digits, 3)}ch` }}>
          <div className="lv-line lv-probe" aria-hidden>
            <span className="lv-num" />
            {timestamps && <span className="lv-ts" />}
            <span className="lv-msg" ref={probeMsg} />
            <span className="lv-chars" ref={probeChars}>
              {'0'.repeat(100)}
            </span>
          </div>
          {list}
        </div>
        {empty && <div className="lv-empty">{empty}</div>}
      </div>

      {!follow && !paused && n > 0 && (
        <button className="btn btn-primary btn-sm lv-follow" onClick={followNow}>
          <Icon name="chevronsDown" size={14} />
          Jump to latest
        </button>
      )}

      <div className="lv-status">
        <span className={cx('lv-state', `st-${paused ? 'paused' : st}`)}>
          <span className="dot" />
          {paused ? 'Paused' : (STATUS_LABEL[st] ?? st)}
        </span>
        {rangeText && <span>{rangeText}</span>}
        {d > 0 && <span>{d.toLocaleString()} older lines dropped</span>}
        {pendingNew > 0 && <span className="strong">{pendingNew.toLocaleString()} new while paused</span>}
        {status.message && !live && st !== 'connecting' && !(st === 'ended' && rangeText) && <span className="lv-status-msg">{status.message}</span>}
        <span className="lv-status-end mono">
          {container}
          {previous ? ' (previous)' : ''}
        </span>
      </div>
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
