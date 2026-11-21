import { useMemo, useState } from 'react';
import { useTick } from '../hooks';
import type { Deployment, Pod, StreamStatus } from '../types';
import { age, cx, podTone, type Tone } from '../util';

type SortKey = 'name' | 'status' | 'restarts' | 'age';

export function StreamChip({ status }: { status: StreamStatus }) {
  const map: Record<string, [string, string]> = {
    connecting: ['CONNECTING', 'info'],
    live: ['LIVE', 'ok'],
    reconnecting: ['RECONNECTING', 'warn'],
    auth: ['SIGNAL LOST', 'bad'],
    error: ['ERROR', 'bad'],
    idle: ['IDLE', 'muted'],
  };
  const [label, tone] = map[status.state] ?? [status.state.toUpperCase(), 'muted'];
  return (
    <span className={cx('pill', `tone-${tone}`)} title={status.message}>
      <i />
      {label}
    </span>
  );
}

const TONE_LABEL: Record<Tone, string> = { ok: 'Running', info: 'Starting', warn: 'Terminating', bad: 'Failing', muted: 'Done/Unknown' };

interface PodsProps {
  pods: Pod[];
  filter: string;
  armed: boolean;
  onOpen: (pod: Pod, tab: 'logs' | 'describe' | 'yaml') => void;
  onDelete: (pod: Pod) => void;
  compact?: boolean;
}

export function PodsTable({ pods, filter, armed, onOpen, onDelete, compact }: PodsProps) {
  useTick(5000);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });
  const [tone, setTone] = useState<Tone | null>(null);

  const counts = useMemo(() => {
    const c: Partial<Record<Tone, number>> = {};
    for (const p of pods) {
      const t = podTone(p.status);
      c[t] = (c[t] ?? 0) + 1;
    }
    return c;
  }, [pods]);

  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const list = pods.filter(
      (p) =>
        (!tone || podTone(p.status) === tone) &&
        (!f || p.name.toLowerCase().includes(f) || p.status.toLowerCase().includes(f) || (p.node ?? '').toLowerCase().includes(f)),
    );
    const cmp: Record<SortKey, (a: Pod, b: Pod) => number> = {
      name: (a, b) => a.name.localeCompare(b.name),
      status: (a, b) => a.status.localeCompare(b.status) || a.name.localeCompare(b.name),
      restarts: (a, b) => a.restarts - b.restarts || a.name.localeCompare(b.name),
      age: (a, b) => new Date(b.created).getTime() - new Date(a.created).getTime(),
    };
    return list.sort((a, b) => cmp[sort.key](a, b) * sort.dir);
  }, [pods, filter, sort, tone]);

  const th = (key: SortKey, label: string, cls?: string) => (
    <th className={cx('sortable', cls, sort.key === key && 'sorted')} onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))}>
      {label}
      {sort.key === key && <span className="sort-arrow">{sort.dir === 1 ? '▲' : '▼'}</span>}
    </th>
  );

  return (
    <div className="table-wrap">
      {!compact && pods.length > 0 && (
        <div className="tone-chips">
          {(Object.keys(TONE_LABEL) as Tone[])
            .filter((t) => counts[t])
            .map((t) => (
              <button key={t} className={cx('tone-chip', `tone-${t}`, tone === t && 'on')} onClick={() => setTone(tone === t ? null : t)}>
                <i /> {TONE_LABEL[t]} <b>{counts[t]}</b>
              </button>
            ))}
        </div>
      )}
      <table className="grid">
        <thead>
          <tr>
            {th('name', 'Name', 'col-name')}
            <th>Ready</th>
            {th('status', 'Status')}
            {th('restarts', 'Restarts', 'num')}
            {th('age', 'Age', 'num')}
            {!compact && <th>Node</th>}
            <th className="col-actions">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const t = podTone(p.status);
            return (
              <tr key={p.name} className={`row-${t}`} onDoubleClick={() => onOpen(p, 'logs')}>
                <td className="col-name">
                  <span className={cx('dot', `tone-${t}`)} />
                  <button className="link" onClick={() => onOpen(p, 'logs')} title="Open logs">
                    {p.name}
                  </button>
                  {p.owner && !compact && (
                    <span className="owner">
                      {p.owner.kind} · {p.owner.name}
                    </span>
                  )}
                </td>
                <td className="mono">{p.ready}</td>
                <td>
                  <span className={cx('status', `tone-${t}`)}>{p.status}</span>
                </td>
                <td className={cx('num mono', p.restarts > 0 && 'warn-text')}>{p.restarts}</td>
                <td className="num mono">{age(p.created)}</td>
                {!compact && <td className="muted ellipsis">{p.node || '—'}</td>}
                <td className="col-actions">
                  <button className="act" onClick={() => onOpen(p, 'logs')}>
                    Logs
                  </button>
                  <button className="act" onClick={() => onOpen(p, 'describe')}>
                    Describe
                  </button>
                  <button className="act" onClick={() => onOpen(p, 'yaml')}>
                    YAML
                  </button>
                  <button
                    className="act danger"
                    disabled={!armed}
                    title={armed ? 'Delete pod (its controller will recreate it)' : 'Night Watch is on (read-only)'}
                    onClick={() => onDelete(p)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && pods.length > 0 && <div className="empty-row">No pods match your search.</div>}
    </div>
  );
}

interface DepProps {
  deployments: Deployment[];
  filter: string;
  armed: boolean;
  onOpen: (d: Deployment, tab: 'pods' | 'describe' | 'yaml') => void;
  onRestart: (d: Deployment) => void;
  onScale: (d: Deployment) => void;
}

export function DeploymentsTable({ deployments, filter, armed, onOpen, onRestart, onScale }: DepProps) {
  useTick(5000);
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return deployments
      .filter((d) => !f || d.name.toLowerCase().includes(f) || d.images.some((i) => i.toLowerCase().includes(f)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [deployments, filter]);

  return (
    <div className="table-wrap">
      <table className="grid">
        <thead>
          <tr>
            <th className="col-name">Name</th>
            <th>Ready</th>
            <th className="num">Up-to-date</th>
            <th className="num">Available</th>
            <th className="num">Age</th>
            <th>Images</th>
            <th className="col-actions">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => {
            const healthy = d.ready === d.replicas && d.available === d.replicas;
            const t: Tone = d.replicas === 0 ? 'muted' : healthy ? 'ok' : d.ready === 0 ? 'bad' : 'warn';
            const pct = d.replicas ? Math.round((d.ready / d.replicas) * 100) : 0;
            return (
              <tr key={d.name} className={`row-${t}`} onDoubleClick={() => onOpen(d, 'pods')}>
                <td className="col-name">
                  <span className={cx('dot', `tone-${t}`)} />
                  <button className="link" onClick={() => onOpen(d, 'pods')} title="Show pods">
                    {d.name}
                  </button>
                  {d.paused && <span className="badge">paused</span>}
                  {d.message && !healthy && (
                    <span className="owner warn-text" title={d.message}>
                      {d.message}
                    </span>
                  )}
                </td>
                <td>
                  <div className="readybar" title={`${d.ready}/${d.replicas} ready`}>
                    <span className="mono">
                      {d.ready}/{d.replicas}
                    </span>
                    <div className="bar">
                      <div className={`fill tone-${t}`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                </td>
                <td className="num mono">{d.upToDate}</td>
                <td className="num mono">{d.available}</td>
                <td className="num mono">{age(d.created)}</td>
                <td className="muted ellipsis images" title={d.images.join('\n')}>
                  {d.images.map((i) => i.split('/').pop()).join(', ')}
                </td>
                <td className="col-actions">
                  <button className="act" onClick={() => onOpen(d, 'pods')}>
                    Pods
                  </button>
                  <button className="act" onClick={() => onOpen(d, 'describe')}>
                    Describe
                  </button>
                  <button className="act" onClick={() => onOpen(d, 'yaml')}>
                    YAML
                  </button>
                  <button className="act warn" disabled={!armed} title={armed ? 'Rollout restart' : 'Night Watch is on (read-only)'} onClick={() => onRestart(d)}>
                    Restart
                  </button>
                  <button className="act warn" disabled={!armed} title={armed ? 'Scale replicas' : 'Night Watch is on (read-only)'} onClick={() => onScale(d)}>
                    Scale
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && deployments.length > 0 && <div className="empty-row">No deployments match your search.</div>}
    </div>
  );
}
