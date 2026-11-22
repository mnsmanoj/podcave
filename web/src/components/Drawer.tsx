import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { qs } from '../api';
import { useTick, useWatch } from '../hooks';
import type { Deployment, DrawerTarget, LogPrefs, Pod } from '../types';
import { age, cx, podTone } from '../util';
import { Icon } from './Icons';
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
  nameOf: (ctxId: string) => string;
  onLogPrefs: (p: LogPrefs) => void;
  onWidth: (w: number) => void;
  onTarget: (t: DrawerTarget | null) => void;
  onDeletePod: (p: Pod) => void;
  onForward: (p: Pod) => void;
  onDeploymentLogs: (d: Deployment) => void;
  onRestart: (d: Deployment) => void;
  onScale: (d: Deployment) => void;
}

export function Drawer(props: Props) {
  const { target, onTarget, width, onWidth } = props;
  const [focus, setFocus] = useState(false);
  const focusRef = useRef(focus);
  focusRef.current = focus;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
      if (e.key === 'Escape' && !typing) {
        if (document.querySelector('.modal-backdrop')) return;
        if (focusRef.current) setFocus(false);
        else onTarget(null);
      }
      if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'f') setFocus((f) => !f);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onTarget]);

  const startDrag = (e: ReactMouseEvent) => {
    e.preventDefault();
    let w = width;
    const move = (ev: MouseEvent) => {
      w = Math.min(Math.max(480, window.innerWidth - ev.clientX), window.innerWidth - 200);
      document.documentElement.style.setProperty('--drawer-w', `${w}px`);
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      onWidth(Math.round(w));
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };

  useEffect(() => {
    if (width) document.documentElement.style.setProperty('--drawer-w', `${width}px`);
  }, [width]);

  const chrome = (
    <>
      <button className={cx('btn btn-ghost btn-sm btn-icon', focus && 'on')} onClick={() => setFocus(!focus)} title={focus ? 'Exit focus (Esc)' : 'Focus: fill the window (F)'}>
        <Icon name={focus ? 'minimize' : 'maximize'} size={15} />
      </button>
      <button className="btn btn-ghost btn-sm btn-icon" onClick={() => onTarget(null)} title="Close (Esc)">
        <Icon name="x" size={16} />
      </button>
    </>
  );

  return (
    <aside className={cx('drawer', focus && 'focus')}>
      {!focus && <div className="drawer-resize" onMouseDown={startDrag} title="Drag to resize" />}
      {target.kind === 'pod' ? (
        <PodPanel {...props} target={target} chrome={chrome} />
      ) : target.kind === 'deployment' ? (
        <DeploymentPanel {...props} target={target} chrome={chrome} />
      ) : (
        <MultiLogsPanel {...props} target={target} chrome={chrome} />
      )}
    </aside>
  );
}

function MultiLogsPanel(props: Props & { target: Extract<DrawerTarget, { kind: 'logs' }>; chrome: ReactNode }) {
  const { target, nameOf, chrome } = props;
  const dep = target.deployment;
  const places = [...new Set(target.pods.map((p) => `${nameOf(p.ctxId)} / ${p.ns}`))];
  return (
    <>
      <header className="drawer-head">
        <div className="drawer-title">
          <div className="drawer-title-text">
            <span className="drawer-kind">{dep ? 'Following deployment' : 'Merged logs'}</span>
            <h2>{dep ? dep.name : `${target.pods.length} ${target.pods.length === 1 ? 'pod' : 'pods'}`}</h2>
          </div>
          <div className="drawer-head-actions">{chrome}</div>
        </div>
        <div className="meta">
          {dep ? (
            <span>
              {nameOf(dep.ctxId)} / {dep.ns}. New pods join automatically.
            </span>
          ) : (
            <span className="ellipsis">{places.length > 2 ? `${places.length} namespaces` : places.join(', ')}</span>
          )}
        </div>
        <div className="drawer-tabs-spacer" />
      </header>
      <div className="drawer-body">
        <LogViewer
          key={JSON.stringify([dep, target.pods.map((p) => [p.ctxId, p.ns, p.pod])])}
          multi={target}
          prefs={props.logPrefs}
          onPrefs={props.onLogPrefs}
          epoch={props.epoch}
          nameOf={nameOf}
        />
      </div>
    </>
  );
}

function Title({ kind, name }: { kind: string; name: string }) {
  return (
    <div className="drawer-title-text">
      <span className="drawer-kind">{kind}</span>
      <h2 title={name}>{name}</h2>
    </div>
  );
}

function Tabs<T extends string>({ tabs, value, onChange }: { tabs: [T, string][]; value: T; onChange: (t: T) => void }) {
  return (
    <nav className="drawer-tabs">
      {tabs.map(([id, label]) => (
        <button key={id} className={cx('tab', value === id && 'on')} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </nav>
  );
}

const opsTitle = (armed: boolean, action: string) => (armed ? action : `${action} (switch to Ops Mode first)`);

function PodPanel(props: Props & { target: Extract<DrawerTarget, { kind: 'pod' }>; chrome: ReactNode }) {
  const { target, pods, ctxId, ns, armed, onTarget, onDeletePod, onForward, chrome } = props;
  useTick(5000);
  const live = pods.find((p) => p.name === target.name);
  const pod = live ?? target.snapshot;
  const tone = pod ? podTone(pod.status) : 'muted';

  return (
    <>
      <header className="drawer-head">
        <div className="drawer-title">
          <Title kind="Pod" name={target.name} />
          {pod && <span className={cx('badge', `tone-${tone}`)}>{pod.status}</span>}
          <div className="drawer-head-actions">
            <button className="btn btn-sm" disabled={!armed || !pod} onClick={() => pod && onForward(pod)} title={opsTitle(armed, 'Port-forward')}>
              <Icon name="plug" size={14} />
              Forward
            </button>
            <button className="btn btn-sm btn-danger" disabled={!armed || !pod} onClick={() => pod && onDeletePod(pod)} title={opsTitle(armed, 'Delete pod')}>
              <Icon name="trash" size={14} />
              Delete
            </button>
            {chrome}
          </div>
        </div>
        {pod && (
          <div className="meta">
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
              <span>
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
            {!live && (
              <span className="warn-text">
                <Icon name="alert" size={13} /> No longer in the pod list
              </span>
            )}
          </div>
        )}
        <Tabs
          value={target.tab}
          onChange={(t) => onTarget({ ...target, tab: t })}
          tabs={[
            ['logs', 'Logs'],
            ['describe', 'Describe'],
            ['yaml', 'YAML'],
          ]}
        />
      </header>
      <div className="drawer-body">
        {target.tab === 'logs' &&
          (pod ? (
            <LogViewer
              key={`${ctxId}|${ns}|${pod.name}`}
              ctxId={ctxId}
              ns={ns}
              pod={pod}
              prefs={props.logPrefs}
              onPrefs={props.onLogPrefs}
              epoch={props.epoch}
              nameOf={props.nameOf}
            />
          ) : (
            <div className="panel-error">Pod not found.</div>
          ))}
        {target.tab !== 'logs' && <TextView ctxId={ctxId} ns={ns} kind="pod" name={target.name} mode={target.tab} epoch={props.epoch} />}
      </div>
    </>
  );
}

function DeploymentPanel(props: Props & { target: Extract<DrawerTarget, { kind: 'deployment' }>; chrome: ReactNode }) {
  const { target, deployments, ctxId, ns, armed, onTarget, onRestart, onScale, onDeletePod, onForward, onDeploymentLogs, chrome } = props;
  const dep = deployments.find((d) => d.name === target.name);
  const selPath = dep?.selector && target.tab === 'pods' ? '/api/pods/watch?' + qs({ ctx: ctxId, ns, selector: dep.selector, e: props.epoch }) : null;
  const { items: depPods, status } = useWatch<Pod>(selPath);

  return (
    <>
      <header className="drawer-head">
        <div className="drawer-title">
          <Title kind="Deployment" name={target.name} />
          {dep && (
            <span className={cx('badge', dep.ready === dep.replicas ? 'tone-ok' : dep.ready === 0 && dep.replicas > 0 ? 'tone-bad' : 'tone-warn')}>
              {dep.ready}/{dep.replicas} ready
            </span>
          )}
          <div className="drawer-head-actions">
            <button className="btn btn-sm" disabled={!dep} onClick={() => dep && onDeploymentLogs(dep)} title="Logs of all pods, following new ones">
              <Icon name="terminal" size={14} />
              Logs
            </button>
            <button className="btn btn-sm" disabled={!armed || !dep} onClick={() => dep && onRestart(dep)} title={opsTitle(armed, 'Rollout restart')}>
              <Icon name="restart" size={14} />
              Restart
            </button>
            <button className="btn btn-sm" disabled={!armed || !dep} onClick={() => dep && onScale(dep)} title={opsTitle(armed, 'Scale')}>
              <Icon name="sliders" size={14} />
              Scale
            </button>
            {chrome}
          </div>
        </div>
        {dep && (
          <div className="meta">
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
              Selector <b className="mono">{dep.selector || 'none'}</b>
            </span>
          </div>
        )}
        <Tabs
          value={target.tab}
          onChange={(t) => onTarget({ ...target, tab: t })}
          tabs={[
            ['pods', 'Pods'],
            ['describe', 'Describe'],
            ['yaml', 'YAML'],
          ]}
        />
      </header>
      <div className="drawer-body">
        {target.tab === 'pods' && (
          <div className="dep-pods">
            <div className="subhead">
              <span>Pods selected by this deployment</span>
              <StreamChip status={status} />
            </div>
            {status.state === 'error' && <div className="panel-error">{status.message}</div>}
            <div className="table-wrap">
              <PodsTable
                compact
                pods={depPods}
                filter=""
                armed={armed}
                onOpen={(p, t) => onTarget({ kind: 'pod', name: p.name, tab: t, snapshot: p })}
                onDelete={onDeletePod}
                onForward={onForward}
              />
              {depPods.length === 0 && status.state === 'live' && <div className="empty-row">No pods found for this deployment.</div>}
            </div>
          </div>
        )}
        {target.tab !== 'pods' && <TextView ctxId={ctxId} ns={ns} kind="deployment" name={target.name} mode={target.tab} epoch={props.epoch} />}
      </div>
    </>
  );
}
