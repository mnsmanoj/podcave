import { useMemo, useState } from 'react';
import { useTick } from '../hooks';
import type { Deployment, Pod, StreamStatus } from '../types';
import { age, cx, podTone, type Tone } from '../util';
import { Icon } from './Icons';
import { MAX_SELECTED, MAX_SELECTED_DEPLOYMENTS } from './Selection';

type SortKey = 'name' | 'status' | 'restarts' | 'age';

const STREAM: Record<string, [string, string]> = {
  connecting: ['Connecting', 'info'],
  live: ['Live', 'ok'],
  reconnecting: ['Reconnecting', 'warn'],
  auth: ['Sign-in needed', 'bad'],
  error: ['Error', 'bad'],
  idle: ['Idle', 'muted'],
};

export function StreamChip({ status }: { status: StreamStatus }) {
  const [label, tone] = STREAM[status.state] ?? [status.state, 'muted'];
  return (
    <span className={cx('badge', `tone-${tone}`)} title={status.message}>
      <span className="dot" />
      {label}
    </span>
  );
}

export const TONE_LABEL: Record<Tone, string> = { ok: 'Running', info: 'Starting', warn: 'Terminating', bad: 'Failing', muted: 'Done' };

export function StatusChips({ pods, tone, onTone }: { pods: Pod[]; tone: Tone | null; onTone: (t: Tone | null) => void }) {
  const counts = useMemo(() => {
    const c: Partial<Record<Tone, number>> = {};
    for (const p of pods) {
      const t = podTone(p.status);
      c[t] = (c[t] ?? 0) + 1;
    }
    return c;
  }, [pods]);
  return (
    <div className="chips">
      {(Object.keys(TONE_LABEL) as Tone[])
        .filter((t) => counts[t])
        .map((t) => (
          <button key={t} className={cx('chip', `tone-${t}`, tone === t && 'on')} onClick={() => onTone(tone === t ? null : t)}>
            <span className="dot" />
            {TONE_LABEL[t]} <b>{counts[t]}</b>
          </button>
        ))}
    </div>
  );
}

interface PodsProps {
  pods: Pod[];
  filter: string;
  tone?: Tone | null;
  armed: boolean;
  selected?: string;
  compact?: boolean;
  /** Multi-pod log selection; omit to hide the checkboxes. */
  picked?: (pod: Pod) => boolean;
  pickFull?: boolean;
  onPick?: (pods: Pod[], on: boolean) => void;
  onOpen: (pod: Pod, tab: 'logs' | 'describe' | 'yaml') => void;
  onDelete: (pod: Pod) => void;
  onForward: (pod: Pod) => void;
}

const opsTitle = (armed: boolean, action: string) => (armed ? action : `${action} (switch to Ops Mode first)`);

function PickHeader<T>({ rows, picked, onPick, noun }: { rows: T[]; picked: (x: T) => boolean; onPick: (xs: T[], on: boolean) => void; noun: string }) {
  const count = rows.filter(picked).length;
  const all = rows.length > 0 && count === rows.length;
  return (
    <th className="col-pick">
      <input
        type="checkbox"
        className="check"
        checked={all}
        ref={(el) => {
          if (el) el.indeterminate = count > 0 && !all;
        }}
        onChange={() => onPick(rows, !all)}
        title={all ? `Unselect these ${noun}` : `Select all ${noun} shown`}
      />
    </th>
  );
}

function PickCell({ on, full, onToggle, what }: { on: boolean; full: boolean; onToggle: () => void; what: 'pods' | 'deployments' }) {
  const limit = what === 'pods' ? MAX_SELECTED : MAX_SELECTED_DEPLOYMENTS;
  return (
    <td className="col-pick">
      <input
        type="checkbox"
        className="check"
        checked={on}
        disabled={!on && full}
        onChange={onToggle}
        onDoubleClick={(e) => e.stopPropagation()}
        title={!on && full ? `Up to ${limit} ${what} can be selected` : 'Select'}
      />
    </td>
  );
}

export function PodsTable({ pods, filter, tone, armed, selected, compact, picked, pickFull, onPick, onOpen, onDelete, onForward }: PodsProps) {
  useTick(5000);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });

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
      {sort.key === key && <Icon name={sort.dir === 1 ? 'chevronUp' : 'chevronDown'} size={12} className="sort-arrow" />}
    </th>
  );

  if (pods.length === 0) return null;
  const pickable = !!(picked && onPick);
  return (
    <div className="table-card">
      <table className="grid">
        <thead>
          <tr>
            {pickable && <PickHeader rows={rows} picked={picked!} onPick={onPick!} noun="pods" />}
            {th('name', 'Name')}
            <th>Ready</th>
            {th('status', 'Status')}
            {th('restarts', 'Restarts', 'num')}
            {th('age', 'Age', 'num')}
            {!compact && <th>Node</th>}
            <th className="col-actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const t = podTone(p.status);
            const on = pickable && picked!(p);
            return (
              <tr key={p.name} className={cx(selected === p.name && 'selected', on && 'picked')} onDoubleClick={() => onOpen(p, 'logs')}>
                {pickable && <PickCell on={on} full={!!pickFull} onToggle={() => onPick!([p], !on)} what="pods" />}
                <td>
                  <div className="cell-name">
                    <span className={cx('dot', `tone-${t}`)} />
                    <div className="cell-name-text">
                      <button className="name-link" onClick={() => onOpen(p, 'logs')} title="Open logs">
                        {p.name}
                      </button>
                      {p.owner && !compact && (
                        <span className="sub">
                          {p.owner.kind} {p.owner.name}
                        </span>
                      )}
                    </div>
                  </div>
                </td>
                <td className="mono small">{p.ready}</td>
                <td>
                  <span className={cx('badge', `tone-${t}`)}>{p.status}</span>
                </td>
                <td className={cx('num mono small', p.restarts > 0 && 'warn-text')}>{p.restarts}</td>
                <td className="num mono small muted">{age(p.created)}</td>
                {!compact && <td className="muted small ellipsis">{p.node || ''}</td>}
                <td className="col-actions">
                  <div className="row-actions">
                    <button className="btn btn-sm" onClick={() => onOpen(p, 'logs')} title="Live logs">
                      <Icon name="terminal" size={14} />
                      Logs
                    </button>
                    <button className="btn btn-ghost btn-sm btn-icon" onClick={() => onOpen(p, 'describe')} title="Describe">
                      <Icon name="file" size={15} />
                    </button>
                    <button className="btn btn-ghost btn-sm btn-icon" onClick={() => onOpen(p, 'yaml')} title="YAML">
                      <Icon name="code" size={15} />
                    </button>
                    <button className="btn btn-ghost btn-sm btn-icon" disabled={!armed} onClick={() => onForward(p)} title={opsTitle(armed, 'Port-forward')}>
                      <Icon name="plug" size={15} />
                    </button>
                    <button className="btn btn-ghost btn-sm btn-icon danger" disabled={!armed} onClick={() => onDelete(p)} title={opsTitle(armed, 'Delete pod')}>
                      <Icon name="trash" size={15} />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && <div className="empty-row">No pods match your filters.</div>}
    </div>
  );
}

interface DepProps {
  deployments: Deployment[];
  filter: string;
  armed: boolean;
  selected?: string;
  onOpen: (d: Deployment, tab: 'pods' | 'describe' | 'yaml') => void;
  onLogs: (d: Deployment) => void;
  onRestart: (d: Deployment) => void;
  onScale: (d: Deployment) => void;
  picked?: (d: Deployment) => boolean;
  pickFull?: boolean;
  onPick?: (deps: Deployment[], on: boolean) => void;
}

export function DeploymentsTable({ deployments, filter, armed, selected, onOpen, onLogs, onRestart, onScale, picked, pickFull, onPick }: DepProps) {
  useTick(5000);
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return deployments
      .filter((d) => !f || d.name.toLowerCase().includes(f) || d.images.some((i) => i.toLowerCase().includes(f)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [deployments, filter]);

  if (deployments.length === 0) return null;
  const pickable = !!(picked && onPick);
  return (
    <div className="table-card">
      <table className="grid">
        <thead>
          <tr>
            {pickable && <PickHeader rows={rows} picked={picked!} onPick={onPick!} noun="deployments" />}
            <th>Name</th>
            <th>Ready</th>
            <th className="num">Up-to-date</th>
            <th className="num">Available</th>
            <th className="num">Age</th>
            <th>Images</th>
            <th className="col-actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => {
            const healthy = d.ready === d.replicas && d.available === d.replicas;
            const t: Tone = d.replicas === 0 ? 'muted' : healthy ? 'ok' : d.ready === 0 ? 'bad' : 'warn';
            const pct = d.replicas ? Math.round((d.ready / d.replicas) * 100) : 0;
            const on = pickable && picked!(d);
            return (
              <tr key={d.name} className={cx(selected === d.name && 'selected', on && 'picked')} onDoubleClick={() => onOpen(d, 'pods')}>
                {pickable && <PickCell on={on} full={!!pickFull} onToggle={() => onPick!([d], !on)} what="deployments" />}
                <td>
                  <div className="cell-name">
                    <span className={cx('dot', `tone-${t}`)} />
                    <div className="cell-name-text">
                      <button className="name-link" onClick={() => onOpen(d, 'pods')} title="Show pods">
                        {d.name}
                      </button>
                      {d.message && !healthy ? (
                        <span className="sub warn-text" title={d.message}>
                          {d.message}
                        </span>
                      ) : (
                        d.paused && <span className="sub">Paused</span>
                      )}
                    </div>
                  </div>
                </td>
                <td>
                  <div className="readybar" title={`${d.ready}/${d.replicas} ready`}>
                    <div className={cx('bar', `tone-${t}`)}>
                      <div className="fill" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="mono small">
                      {d.ready}/{d.replicas}
                    </span>
                  </div>
                </td>
                <td className="num mono small">{d.upToDate}</td>
                <td className="num mono small">{d.available}</td>
                <td className="num mono small muted">{age(d.created)}</td>
                <td className="images ellipsis" title={d.images.join('\n')}>
                  {d.images.map((i) => i.split('/').pop()).join(', ')}
                </td>
                <td className="col-actions">
                  <div className="row-actions">
                    <button className="btn btn-sm" onClick={() => onOpen(d, 'pods')}>
                      <Icon name="box" size={14} />
                      Pods
                    </button>
                    <button className="btn btn-ghost btn-sm btn-icon" onClick={() => onLogs(d)} title="Logs of all pods, following new ones">
                      <Icon name="terminal" size={15} />
                    </button>
                    <button className="btn btn-ghost btn-sm btn-icon" onClick={() => onOpen(d, 'describe')} title="Describe">
                      <Icon name="file" size={15} />
                    </button>
                    <button className="btn btn-ghost btn-sm btn-icon" onClick={() => onOpen(d, 'yaml')} title="YAML">
                      <Icon name="code" size={15} />
                    </button>
                    <button className="btn btn-ghost btn-sm btn-icon" disabled={!armed} onClick={() => onRestart(d)} title={opsTitle(armed, 'Rollout restart')}>
                      <Icon name="restart" size={15} />
                    </button>
                    <button className="btn btn-ghost btn-sm btn-icon" disabled={!armed} onClick={() => onScale(d)} title={opsTitle(armed, 'Scale')}>
                      <Icon name="sliders" size={15} />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && <div className="empty-row">No deployments match your search.</div>}
    </div>
  );
}
