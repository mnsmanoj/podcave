import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react';
import { qs } from '../api';
import { useWatch } from '../hooks';
import type { Deployment, DrawerTarget, LogPrefs, Pod } from '../types';
import { age, cx, podTone } from '../util';
import { LogViewer } from './LogViewer';
import { PodsTable, StreamChip } from './Tables';
import { TextView } from './TextView';

interface Props {
  ctxId: string;
  ns: string;
  target: DrawerTarget;
  pods: Pod[];
  deployments: Deployment[];
  armed: boolean;
  width: number;
  logPrefs: LogPrefs;
  epoch: number;
  onLogPrefs: (p: LogPrefs) => void;
  onWidth: (w: number) => void;
  onTarget: (t: DrawerTarget | null) => void;
  onDeletePod: (p: Pod) => void;
  onRestart: (d: Deployment) => void;
  onScale: (d: Deployment) => void;
}

export function Drawer(props: Props) {
  const { target, onTarget, width, onWidth } = props;
  const dragging = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) onTarget(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onTarget]);

  const startDrag = (e: ReactMouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    let w = width;
    const move = (ev: MouseEvent) => {
      w = Math.min(Math.max(420, window.innerWidth - ev.clientX), window.innerWidth - 240);
      document.documentElement.style.setProperty('--drawer-w', `${w}px`);
    };
    const up = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      onWidth(Math.round(w));
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };

  useEffect(() => {
    document.documentElement.style.setProperty('--drawer-w', `${width}px`);
  }, [width]);

  return (
    <aside className="drawer">
      <div className="drawer-resize" onMouseDown={startDrag} title="Drag to resize" />
      {target.kind === 'pod' ? <PodPanel {...props} target={target} /> : <DeploymentPanel {...props} target={target} />}
    </aside>
  );
}

function PodPanel(props: Props & { target: Extract<DrawerTarget, { kind: 'pod' }> }) {
  const { target, pods, ctxId, ns, armed, onTarget, onDeletePod } = props;
  const live = pods.find((p) => p.name === target.name);
  const pod = live ?? target.snapshot;
  const tone = pod ? podTone(pod.status) : 'muted';
  const tab = (t: 'logs' | 'describe' | 'yaml') => onTarget({ ...target, tab: t });

  return (
    <>
      <header className="drawer-head">
        <div className="drawer-title">
          <span className="kind">POD</span>
          <h2 title={target.name}>{target.name}</h2>
          <button className="icon close" onClick={() => onTarget(null)} title="Close (Esc)">
            ✕
          </button>
        </div>
        {pod && (
          <div className="facts">
            <span className={cx('status', `tone-${tone}`)}>{pod.status}</span>
            <span>
              Ready <b className="mono">{pod.ready}</b>
            </span>
            <span className={pod.restarts ? 'warn-text' : undefined}>
              Restarts <b className="mono">{pod.restarts}</b>
            </span>
            <span>
              Age <b className="mono">{age(pod.created)}</b>
            </span>
            {pod.node && (
              <span className="ellipsis">
                Node <b>{pod.node}</b>
              </span>
            )}
            {pod.ip && (
              <span>
                IP <b className="mono">{pod.ip}</b>
              </span>
            )}
            {pod.owner && (
              <span>
                Owner <b>{pod.owner.kind}/{pod.owner.name}</b>
              </span>
            )}
            {!live && <span className="warn-text">Pod no longer in list</span>}
          </div>
        )}
        <div className="drawer-tabs">
          <nav>
            <button className={cx(target.tab === 'logs' && 'on')} onClick={() => tab('logs')}>
              Logs
            </button>
            <button className={cx(target.tab === 'describe' && 'on')} onClick={() => tab('describe')}>
              Describe
            </button>
            <button className={cx(target.tab === 'yaml' && 'on')} onClick={() => tab('yaml')}>
              YAML
            </button>
          </nav>
          <div className="belt">
            <button className="act danger" disabled={!armed || !pod} onClick={() => pod && onDeletePod(pod)} title={armed ? 'Delete pod' : 'Night Watch is on (read-only)'}>
              Delete pod
            </button>
          </div>
        </div>
      </header>
      <div className="drawer-body">
        {target.tab === 'logs' &&
          (pod ? (
            <LogViewer key={`${ctxId}|${ns}|${pod.name}`} ctxId={ctxId} ns={ns} pod={pod} prefs={props.logPrefs} onPrefs={props.onLogPrefs} epoch={props.epoch} />
          ) : (
            <div className="panel-error">Pod not found.</div>
          ))}
        {target.tab !== 'logs' && <TextView ctxId={ctxId} ns={ns} kind="pod" name={target.name} mode={target.tab} epoch={props.epoch} />}
      </div>
    </>
  );
}

function DeploymentPanel(props: Props & { target: Extract<DrawerTarget, { kind: 'deployment' }> }) {
  const { target, deployments, ctxId, ns, armed, onTarget, onRestart, onScale, onDeletePod } = props;
  const dep = deployments.find((d) => d.name === target.name);
  const tab = (t: 'pods' | 'describe' | 'yaml') => onTarget({ ...target, tab: t });
  const selPath = dep?.selector && target.tab === 'pods' ? '/api/pods/watch?' + qs({ ctx: ctxId, ns, selector: dep.selector, e: props.epoch }) : null;
  const { items: depPods, status } = useWatch<Pod>(selPath);

  return (
    <>
      <header className="drawer-head">
        <div className="drawer-title">
          <span className="kind dep">DEPLOYMENT</span>
          <h2 title={target.name}>{target.name}</h2>
          <button className="icon close" onClick={() => onTarget(null)} title="Close (Esc)">
            ✕
          </button>
        </div>
        {dep && (
          <div className="facts">
            <span>
              Ready <b className="mono">{dep.ready}/{dep.replicas}</b>
            </span>
            <span>
              Up-to-date <b className="mono">{dep.upToDate}</b>
            </span>
            <span>
              Available <b className="mono">{dep.available}</b>
            </span>
            <span>
              Age <b className="mono">{age(dep.created)}</b>
            </span>
            <span className="ellipsis" title={dep.selector}>
              Selector <b className="mono">{dep.selector || '—'}</b>
            </span>
          </div>
        )}
        <div className="drawer-tabs">
          <nav>
            <button className={cx(target.tab === 'pods' && 'on')} onClick={() => tab('pods')}>
              Pods
            </button>
            <button className={cx(target.tab === 'describe' && 'on')} onClick={() => tab('describe')}>
              Describe
            </button>
            <button className={cx(target.tab === 'yaml' && 'on')} onClick={() => tab('yaml')}>
              YAML
            </button>
          </nav>
          <div className="belt">
            <button className="act warn" disabled={!armed || !dep} onClick={() => dep && onRestart(dep)} title={armed ? 'Rollout restart' : 'Night Watch is on (read-only)'}>
              Restart
            </button>
            <button className="act warn" disabled={!armed || !dep} onClick={() => dep && onScale(dep)} title={armed ? 'Scale' : 'Night Watch is on (read-only)'}>
              Scale
            </button>
          </div>
        </div>
      </header>
      <div className="drawer-body">
        {target.tab === 'pods' && (
          <div className="dep-pods">
            <div className="subhead">
              <span>Pods matching this deployment</span>
              <StreamChip status={status} />
            </div>
            {status.state === 'error' && <div className="panel-error">{status.message}</div>}
            <PodsTable
              compact
              pods={depPods}
              filter=""
              armed={armed}
              onOpen={(p, t) => onTarget({ kind: 'pod', name: p.name, tab: t, snapshot: p })}
              onDelete={onDeletePod}
            />
            {depPods.length === 0 && status.state === 'live' && <div className="empty-row">No pods found for this deployment.</div>}
          </div>
        )}
        {target.tab !== 'pods' && <TextView ctxId={ctxId} ns={ns} kind="deployment" name={target.name} mode={target.tab} epoch={props.epoch} />}
      </div>
    </>
  );
}
