import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, bootstrap, onSessionLost, qs, sleep, stream } from './api';
import { BatBurst, BatEmblem } from './components/Bat';
import { BatSignal } from './components/BatSignal';
import { ConfirmDialog, type ScaleRow } from './components/ConfirmDialog';
import { Drawer } from './components/Drawer';
import { Icon } from './components/Icons';
import { NamespaceList } from './components/NamespaceList';
import { ForwardDialog, ForwardsTray } from './components/PortForward';
import { MAX_SELECTED, MAX_SELECTED_DEPLOYMENTS, selKey, SelectionBar } from './components/Selection';
import { DeploymentsTable, PodsTable, StatusChips, StreamChip } from './components/Tables';
import { TopBar } from './components/TopBar';
import { Vault } from './components/Vault';
import { useWatch } from './hooks';
import { applyTheme, storedTheme, watchSystemTheme } from './theme';
import type { AuthEvent, ContextInfo, Deployment, DrawerTarget, ForwardInfo, Pod, Prefs, SelDep, SelPod, SourceStatus, StreamStatus, ThemePref } from './types';
import { cx, displayName, errMsg, type Tone } from './util';

export default function App() {
  const [phase, setPhase] = useState<'loading' | 'ok' | 'locked'>('loading');
  useEffect(() => {
    onSessionLost(() => setPhase('locked'));
    bootstrap().then((ok) => setPhase(ok ? 'ok' : 'locked'));
    // A fresh launch link pasted into an existing tab only changes the hash.
    const onHash = () => {
      if (/launch=/.test(location.hash)) bootstrap().then((ok) => setPhase(ok ? 'ok' : 'locked'));
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  if (phase === 'loading') return <Splash text="Loading" />;
  if (phase === 'locked') return <Locked />;
  return <Cave />;
}

function Splash({ text }: { text: string }) {
  return (
    <div className="splash">
      <BatEmblem size={40} />
      <p>{text}</p>
    </div>
  );
}

function Locked() {
  return (
    <div className="splash locked">
      <BatEmblem size={40} />
      <h1>This tab is signed out</h1>
      <p>Sign-in links are single-use and only work on this computer. To get a new one:</p>
      <ol>
        <li>
          Switch to the <b>Pod Cave</b> console window.
        </li>
        <li>
          Press <span className="kbd">Enter</span>. A fresh link opens in your browser.
        </li>
      </ol>
      <p className="muted small">If you closed the console, start Pod Cave again.</p>
    </div>
  );
}

interface Confirm {
  title: string;
  body: ReactNode;
  confirmText: string;
  requireYes?: boolean;
  danger?: boolean;
  replicas?: number;
  replicasLabel?: string;
  scaleRows?: ScaleRow[];
  run: (replicas?: number, counts?: Record<string, number>) => Promise<void>;
}

/**
 * Runs fn on every item at once. Items that succeed are dropped from `left`,
 * so retrying from the dialog only repeats the ones that failed.
 */
async function runAll<T>(left: T[], label: (t: T) => string, fn: (t: T) => Promise<void>): Promise<{ done: T[]; failed: T[]; error: string }> {
  const res = await Promise.allSettled(left.map(fn));
  const done = left.filter((_, i) => res[i].status === 'fulfilled');
  const failed: T[] = [];
  const msgs: string[] = [];
  res.forEach((r, i) => {
    if (r.status === 'rejected') {
      failed.push(left[i]);
      msgs.push(`${label(left[i])}: ${errMsg(r.reason)}`);
    }
  });
  const error = failed.length ? `${done.length ? `${done.length} done, ` : ''}${failed.length} failed. Confirm again to retry the failed ones.\n${msgs.join('\n')}` : '';
  return { done, failed, error };
}

function BulkList({ rows }: { rows: { key: string; name: string; where: string; note?: string }[] }) {
  return (
    <ul className="bulk-list">
      {rows.map((r) => (
        <li key={r.key}>
          <span className="mono ellipsis">{r.name}</span>
          <span className="muted small ellipsis">{r.where}</span>
          {r.note && <span className="small bulk-note">{r.note}</span>}
        </li>
      ))}
    </ul>
  );
}

interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'bad';
}

function Cave() {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [contexts, setContexts] = useState<ContextInfo[]>([]);
  const [sources, setSources] = useState<SourceStatus[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState('');
  const [armed, setArmed] = useState(false);
  const [authEvents, setAuthEvents] = useState<Record<string, AuthEvent>>({});
  const [dismissed, setDismissed] = useState<Record<string, string>>({});
  const [vault, setVault] = useState(false);
  const [drawer, setDrawer] = useState<DrawerTarget | null>(null);
  const [filter, setFilter] = useState('');
  const [tone, setTone] = useState<Tone | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [forwardPod, setForwardPod] = useState<Pod | null>(null);
  const [forwards, setForwards] = useState<ForwardInfo[]>([]);
  const [selection, setSelection] = useState<SelPod[]>([]);
  const [depSel, setDepSel] = useState<SelDep[]>([]);
  const [bats, setBats] = useState<{ x: number; y: number } | null>(null);
  const batsDone = useCallback(() => setBats(null), []);
  // Where the user last clicked, so the Ops Mode bats start from the confirm button.
  const lastPointer = useRef({ x: 0, y: 0, at: 0 });
  useEffect(() => {
    const h = (e: PointerEvent) => (lastPointer.current = { x: e.clientX, y: e.clientY, at: Date.now() });
    document.addEventListener('pointerdown', h, true);
    return () => document.removeEventListener('pointerdown', h, true);
  }, []);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [epoch, setEpoch] = useState(0);
  const filterRef = useRef<HTMLInputElement>(null);

  const theme: ThemePref = prefs?.theme ?? storedTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => watchSystemTheme(() => themeRef.current), []);

  const toast = useCallback((text: string, t: Toast['tone'] = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((x) => [...x, { id, text, tone: t }]);
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), 4500);
  }, []);

  const loadContexts = useCallback(async () => {
    try {
      const r = await api<{ contexts: ContextInfo[]; sources: SourceStatus[] }>('/api/contexts');
      setContexts(r.contexts);
      setSources(r.sources);
      setLoadErr('');
    } catch (e) {
      setLoadErr(errMsg(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  const loadForwards = useCallback(() => {
    api<{ items: ForwardInfo[] }>('/api/forwards')
      .then((r) => setForwards(r.items ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    api<Prefs>('/api/prefs')
      .then((p) => setPrefs(p ?? {}))
      .catch(() => setPrefs({}));
    loadContexts();
    loadForwards();
    api<{ armed: boolean }>('/api/state')
      .then((s) => setArmed(s.armed))
      .catch(() => {});
  }, [loadContexts, loadForwards]);

  // Pick up kubeconfig changes on disk (e.g. after `az aks get-credentials`) when returning to the tab.
  useEffect(() => {
    const f = () => loadContexts();
    window.addEventListener('focus', f);
    return () => window.removeEventListener('focus', f);
  }, [loadContexts]);

  // Persist preferences (debounced) so the cave remembers where you were.
  const skipSave = useRef(true);
  useEffect(() => {
    if (!prefs) return;
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    const t = setTimeout(() => api('/api/prefs', { method: 'PUT', body: prefs }).catch(() => {}), 400);
    return () => clearTimeout(t);
  }, [prefs]);
  const update = useCallback((fn: (p: Prefs) => Prefs) => setPrefs((p) => fn(p ?? {})), []);

  // Server events: Cave Signal auth prompts, mode changes and port-forward updates.
  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      while (!ac.signal.aborted) {
        let first = true;
        try {
          await stream(
            '/api/events',
            (e) => {
              if (first) {
                first = false;
                setAuthEvents({});
                loadForwards();
              }
              if (e.type === 'mode') setArmed(e.state === 'true');
              if (e.type === 'forwards') loadForwards();
              if (e.type === 'auth') {
                setAuthEvents((m) => {
                  const n = { ...m };
                  if (e.state === 'ok') {
                    if (n[e.ctx]) setEpoch((x) => x + 1);
                    delete n[e.ctx];
                  } else n[e.ctx] = e as AuthEvent;
                  return n;
                });
              }
            },
            ac.signal,
          );
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) return;
        }
        await sleep(2000, ac.signal);
      }
    })();
    return () => ac.abort();
  }, [loadForwards]);

  const current = contexts.find((c) => c.id === prefs?.lastContext) ?? contexts.find((c) => c.current) ?? contexts[0];
  const ctxId = current?.id ?? '';
  const ns = current ? (prefs?.lastNamespace?.[current.id] ?? current.namespace) : '';
  const tab = prefs?.tab ?? 'pods';
  const labels = useMemo(() => prefs?.contextLabels ?? {}, [prefs?.contextLabels]);
  const nameOf = useCallback(
    (id: string) => {
      const c = contexts.find((x) => x.id === id);
      return c ? displayName(c.name, labels[id]) : id;
    },
    [contexts, labels],
  );
  const currentName = current ? displayName(current.name, labels[current.id]) : '';
  const setLabels = useCallback(
    (patch: Record<string, string>) =>
      update((p) => {
        const next = { ...p.contextLabels };
        for (const [k, v] of Object.entries(patch)) {
          if (v) next[k] = v;
          else delete next[k];
        }
        return { ...p, contextLabels: next };
      }),
    [update],
  );

  const podsPath = prefs && ctxId && ns ? '/api/pods/watch?' + qs({ ctx: ctxId, ns, e: epoch }) : null;
  const depsPath = prefs && ctxId && ns ? '/api/deployments/watch?' + qs({ ctx: ctxId, ns, e: epoch }) : null;
  const pods = useWatch<Pod>(podsPath);
  const deps = useWatch<Deployment>(depsPath);

  useEffect(() => {
    // A merged log view spans namespaces and clusters, so it stays open while browsing.
    setDrawer((d) => (d?.kind === 'logs' ? d : null));
    setFilter('');
    setTone(null);
  }, [ctxId, ns]);

  const pickedKeys = useMemo(() => new Set(selection.map((p) => selKey(p.ctxId, p.ns, p.pod))), [selection]);
  const isPicked = useCallback((p: Pod) => pickedKeys.has(selKey(ctxId, ns, p.name)), [pickedKeys, ctxId, ns]);
  const pick = (list: Pod[], on: boolean) => {
    setSelection((sel) => {
      if (!on) {
        const drop = new Set(list.map((p) => selKey(ctxId, ns, p.name)));
        return sel.filter((p) => !drop.has(selKey(p.ctxId, p.ns, p.pod)));
      }
      const next = [...sel];
      const have = new Set(sel.map((p) => selKey(p.ctxId, p.ns, p.pod)));
      for (const p of list) {
        if (have.has(selKey(ctxId, ns, p.name))) continue;
        if (next.length >= MAX_SELECTED) {
          toast(`Up to ${MAX_SELECTED} pods can be selected.`, 'bad');
          break;
        }
        next.push({ ctxId, ns, pod: p.name, containers: p.containers, owner: p.owner ? `${p.owner.kind} ${p.owner.name}` : undefined });
      }
      return next;
    });
  };

  const depKeys = useMemo(() => new Set(depSel.map((d) => selKey(d.ctxId, d.ns, d.name))), [depSel]);
  const isDepPicked = useCallback((d: Deployment) => depKeys.has(selKey(ctxId, ns, d.name)), [depKeys, ctxId, ns]);
  const pickDeps = (list: Deployment[], on: boolean) => {
    setDepSel((sel) => {
      if (!on) {
        const drop = new Set(list.map((d) => selKey(ctxId, ns, d.name)));
        return sel.filter((d) => !drop.has(selKey(d.ctxId, d.ns, d.name)));
      }
      const next = [...sel];
      const have = new Set(sel.map((d) => selKey(d.ctxId, d.ns, d.name)));
      for (const d of list) {
        if (have.has(selKey(ctxId, ns, d.name))) continue;
        if (next.length >= MAX_SELECTED_DEPLOYMENTS) {
          toast(`Up to ${MAX_SELECTED_DEPLOYMENTS} deployments can be selected.`, 'bad');
          break;
        }
        next.push({ ctxId, ns, name: d.name, replicas: d.replicas });
      }
      return next;
    });
  };
  // Keep replica counts of selected deployments in the current namespace fresh.
  useEffect(() => {
    setDepSel((sel) => {
      let changed = false;
      const next = sel.map((s) => {
        if (s.ctxId !== ctxId || s.ns !== ns) return s;
        const live = deps.items.find((d) => d.name === s.name);
        if (!live || live.replicas === s.replicas) return s;
        changed = true;
        return { ...s, replicas: live.replicas };
      });
      return changed ? next : sel;
    });
  }, [deps.items, ctxId, ns]);

  const viewSelection = () => {
    const containers = [...new Set(selection.flatMap((p) => p.containers))].sort();
    setDrawer({ kind: 'logs', pods: selection, containers });
  };
  const deploymentLogs = (d: Deployment) => {
    const mine = pods.items.filter((p) => p.owner?.kind === 'ReplicaSet' && p.owner.name.startsWith(d.name + '-'));
    const containers = [...new Set(mine.flatMap((p) => p.containers))].sort();
    setDrawer({ kind: 'logs', pods: [], deployment: { ctxId, ns, name: d.name }, containers });
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === '/' && !(t instanceof HTMLInputElement) && !(t instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        filterRef.current?.focus();
      }
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, []);

  const signals = useMemo(
    () =>
      Object.values(authEvents)
        .filter((e) => dismissed[e.ctx] !== e.time)
        .sort((a, b) => (a.ctx === ctxId ? -1 : b.ctx === ctxId ? 1 : 0)),
    [authEvents, dismissed, ctxId],
  );

  const setMode = async (next: boolean) => {
    try {
      const r = await api<{ armed: boolean }>('/api/mode', { method: 'POST', body: { armed: next } });
      setArmed(r.armed);
      if (next && r.armed) {
        const p = lastPointer.current;
        setBats(Date.now() - p.at < 5000 ? { x: p.x, y: p.y } : { x: window.innerWidth / 2, y: window.innerHeight / 2 });
      }
      toast(r.armed ? 'Ops Mode is on. Write actions and port-forward are enabled.' : 'Back to Night Watch. Read-only.');
    } catch (e) {
      toast(errMsg(e), 'bad');
    }
  };

  const disarm = () => {
    const active = forwards.filter((f) => f.state === 'active').length;
    if (!active) return setMode(false);
    setConfirm({
      title: 'Switch back to Night Watch?',
      body: (
        <p>
          Night Watch is read-only, so {active === 1 ? 'the active port-forward' : `all ${active} active port-forwards`} will be closed.
        </p>
      ),
      confirmText: 'Close forwards and switch',
      run: async () => setMode(false),
    });
  };

  const deletePod = (p: Pod) =>
    setConfirm({
      title: `Delete pod ${p.name}?`,
      body: (
        <p>
          The pod will be terminated in <b>{ns}</b> on <b>{currentName}</b>.{' '}
          {p.owner ? `Its ${p.owner.kind} will create a replacement.` : 'It has no controller, so it will not come back.'}
        </p>
      ),
      confirmText: 'Delete pod',
      requireYes: true,
      danger: true,
      run: async () => {
        await api('/api/pods/delete', { method: 'POST', body: { ctx: ctxId, ns, name: p.name, confirm: 'yes' } });
        toast(`Pod ${p.name} deleted.`);
      },
    });

  const deleteSelected = () => {
    let left = [...selection];
    const orphans = left.filter((p) => !p.owner);
    setConfirm({
      title: `Delete ${left.length} ${left.length === 1 ? 'pod' : 'pods'}?`,
      body: (
        <>
          <p>All of these pods are deleted at the same time. Pods managed by a deployment or other controller are recreated automatically.</p>
          <BulkList
            rows={left.map((p) => ({
              key: selKey(p.ctxId, p.ns, p.pod),
              name: p.pod,
              where: `${nameOf(p.ctxId)} / ${p.ns}`,
              note: p.owner ? undefined : 'no controller',
            }))}
          />
          {orphans.length > 0 && (
            <p className="bad-text">
              {orphans.length === 1 ? '1 pod has' : `${orphans.length} pods have`} no controller and will not come back.
            </p>
          )}
        </>
      ),
      confirmText: `Delete ${left.length === 1 ? 'pod' : 'pods'}`,
      requireYes: true,
      danger: true,
      run: async () => {
        const r = await runAll(
          left,
          (p) => p.pod,
          (p) => api('/api/pods/delete', { method: 'POST', body: { ctx: p.ctxId, ns: p.ns, name: p.pod, confirm: 'yes' } }),
        );
        if (r.done.length) {
          const gone = new Set(r.done.map((p) => selKey(p.ctxId, p.ns, p.pod)));
          setSelection((sel) => sel.filter((p) => !gone.has(selKey(p.ctxId, p.ns, p.pod))));
          toast(`Deleted ${r.done.length} ${r.done.length === 1 ? 'pod' : 'pods'}.`);
        }
        left = r.failed;
        if (r.error) throw new Error(r.error);
      },
    });
  };

  const restart = (d: Deployment) =>
    setConfirm({
      title: `Restart ${d.name}?`,
      body: (
        <p>
          Performs a rolling restart (same as <span className="mono">kubectl rollout restart</span>) in <b>{ns}</b> on <b>{currentName}</b>.
        </p>
      ),
      confirmText: 'Rollout restart',
      requireYes: true,
      run: async () => {
        await api('/api/deployments/restart', { method: 'POST', body: { ctx: ctxId, ns, name: d.name, confirm: 'yes' } });
        toast(`Rollout restart of ${d.name} started.`);
      },
    });

  const scale = (d: Deployment) =>
    setConfirm({
      title: `Scale ${d.name}`,
      body: (
        <p>
          Currently <b>{d.replicas}</b> replica{d.replicas === 1 ? '' : 's'} in <b>{ns}</b> on <b>{currentName}</b>.
        </p>
      ),
      confirmText: 'Scale',
      requireYes: true,
      replicas: d.replicas,
      run: async (replicas) => {
        await api('/api/deployments/scale', { method: 'POST', body: { ctx: ctxId, ns, name: d.name, confirm: 'yes', replicas } });
        toast(`${d.name} scaled to ${replicas}.`);
      },
    });

  const scaleSelected = () => {
    let left = [...depSel];
    const current = new Set(left.map((d) => d.replicas));
    const keyOf = (d: SelDep) => selKey(d.ctxId, d.ns, d.name);
    setConfirm({
      title: `Scale ${left.length} ${left.length === 1 ? 'deployment' : 'deployments'}`,
      body: <p>All of them are scaled at once. To give one a different count, type it in its own box.</p>,
      confirmText: 'Scale all',
      requireYes: true,
      replicas: current.size === 1 ? left[0].replicas : 1,
      replicasLabel: 'New replica count for all of them',
      scaleRows: left.map((d) => ({ key: keyOf(d), name: d.name, where: `${nameOf(d.ctxId)} / ${d.ns}`, current: d.replicas })),
      run: async (replicas, counts) => {
        const want = (d: SelDep) => counts?.[keyOf(d)] ?? replicas ?? d.replicas;
        const r = await runAll(
          left,
          (d) => d.name,
          (d) => api('/api/deployments/scale', { method: 'POST', body: { ctx: d.ctxId, ns: d.ns, name: d.name, confirm: 'yes', replicas: want(d) } }),
        );
        if (r.done.length) {
          const done = new Map(r.done.map((d) => [keyOf(d), want(d)]));
          setDepSel((sel) => sel.map((d) => (done.has(keyOf(d)) ? { ...d, replicas: done.get(keyOf(d))! } : d)));
          const values = new Set(done.values());
          const n = r.done.length;
          toast(`Scaled ${n} ${n === 1 ? 'deployment' : 'deployments'}${values.size === 1 ? ` to ${[...values][0]}` : ''}.`);
        }
        left = r.failed;
        if (r.error) throw new Error(r.error);
      },
    });
  };

  const arm = () =>
    setConfirm({
      title: 'Switch to Ops Mode?',
      body: (
        <>
          <p>Ops Mode lets you delete pods, restart and scale deployments, and port-forward for this session.</p>
          <p className="muted">
            Destructive actions still ask you to type yes. Pod Cave always starts in read-only Night Watch, and you can only do what your Kubernetes permissions
            allow.
          </p>
        </>
      ),
      confirmText: 'Switch to Ops Mode',
      run: async () => setMode(true),
    });

  const stopForward = async (f: ForwardInfo) => {
    try {
      await api('/api/forwards/stop', { method: 'POST', body: { id: f.id } });
    } catch (e) {
      toast(errMsg(e), 'bad');
    }
    loadForwards();
  };

  if (!prefs || !loaded) return <Splash text="Loading" />;
  if (sources.length === 0)
    return <Vault sources={sources} contexts={contexts} labels={labels} onLabels={setLabels} onboarding onChanged={loadContexts} />;

  const watchStatus: StreamStatus = tab === 'pods' ? pods.status : deps.status;
  const items = tab === 'pods' ? pods.items.length : deps.items.length;

  return (
    <div className="app">
      <TopBar
        contexts={contexts}
        current={current}
        labels={labels}
        armed={armed}
        authEvents={authEvents}
        theme={theme}
        forwards={<ForwardsTray forwards={forwards} nameOf={nameOf} onStop={stopForward} />}
        onContext={(id) => update((p) => ({ ...p, lastContext: id }))}
        onArm={arm}
        onDisarm={disarm}
        onVault={() => setVault(true)}
        onTheme={(t) => update((p) => ({ ...p, theme: t }))}
      />
      <BatSignal events={signals} contexts={contexts} nameOf={nameOf} onDismiss={(c) => setDismissed((d) => ({ ...d, [c]: authEvents[c]?.time ?? '' }))} />

      <div className="cave">
        {current ? (
          <>
            <NamespaceList
              ctxId={ctxId}
              selected={ns}
              epoch={epoch}
              extra={prefs.extraNamespaces?.[ctxId] ?? []}
              onSelect={(n) => update((p) => ({ ...p, lastNamespace: { ...p.lastNamespace, [ctxId]: n } }))}
              onExtra={(list) => update((p) => ({ ...p, extraNamespaces: { ...p.extraNamespaces, [ctxId]: list } }))}
            />
            <main className="main">
              <div className="page-head">
                <div className="crumbs">
                  <span title={`${current.cluster} (${current.sourceName})`}>{currentName}</span>
                  <span className="sep">/</span>
                  <span>namespace</span>
                </div>
                <div className="page-title">
                  <h1>{ns}</h1>
                  <StreamChip status={watchStatus} />
                </div>
                <nav className="tabs">
                  <button className={cx('tab', tab === 'pods' && 'on')} onClick={() => update((p) => ({ ...p, tab: 'pods' }))}>
                    Pods <span className="count">{pods.items.length}</span>
                  </button>
                  <button className={cx('tab', tab === 'deployments' && 'on')} onClick={() => update((p) => ({ ...p, tab: 'deployments' }))}>
                    Deployments <span className="count">{deps.items.length}</span>
                  </button>
                </nav>
              </div>

              <div className="toolbar">
                <div className="field-box">
                  <Icon name="search" size={14} />
                  <input ref={filterRef} value={filter} placeholder={`Search ${tab}`} onChange={(e) => setFilter(e.target.value)} spellCheck={false} />
                  {filter ? (
                    <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setFilter('')} title="Clear">
                      <Icon name="x" size={13} />
                    </button>
                  ) : (
                    <span className="kbd">/</span>
                  )}
                </div>
                {tab === 'pods' && <StatusChips pods={pods.items} tone={tone} onTone={setTone} />}
              </div>

              {(watchStatus.state === 'error' || watchStatus.state === 'auth' || watchStatus.state === 'reconnecting') && watchStatus.message && (
                <div className={cx('banner', watchStatus.state === 'reconnecting' ? 'warn' : 'bad')}>
                  <Icon name="alert" size={15} />
                  <span>
                    {watchStatus.state === 'auth' ? 'Sign-in needed. ' : ''}
                    {watchStatus.message}
                  </span>
                </div>
              )}

              <div className="table-wrap">
                {tab === 'pods' ? (
                  <PodsTable
                    pods={pods.items}
                    filter={filter}
                    tone={tone}
                    armed={armed}
                    selected={drawer?.kind === 'pod' ? drawer.name : undefined}
                    picked={isPicked}
                    pickFull={selection.length >= MAX_SELECTED}
                    onPick={pick}
                    onOpen={(p, t) => setDrawer({ kind: 'pod', name: p.name, tab: t, snapshot: p })}
                    onDelete={deletePod}
                    onForward={setForwardPod}
                  />
                ) : (
                  <DeploymentsTable
                    deployments={deps.items}
                    filter={filter}
                    armed={armed}
                    selected={drawer?.kind === 'deployment' ? drawer.name : undefined}
                    onOpen={(d, t) => setDrawer({ kind: 'deployment', name: d.name, tab: t })}
                    onLogs={deploymentLogs}
                    picked={isDepPicked}
                    pickFull={depSel.length >= MAX_SELECTED_DEPLOYMENTS}
                    onPick={pickDeps}
                    onRestart={restart}
                    onScale={scale}
                  />
                )}
                {watchStatus.state === 'live' && items === 0 && (
                  <div className="empty">
                    <p>
                      No {tab} in <b>{ns}</b>.
                    </p>
                  </div>
                )}
                {watchStatus.state === 'connecting' && (
                  <div className="empty">
                    <span className="spinner" />
                    <p>Loading {tab}</p>
                  </div>
                )}
              </div>
              {tab === 'pods' ? (
                <SelectionBar
                  items={selection.map((p) => ({ ctxId: p.ctxId, ns: p.ns, name: p.pod }))}
                  noun={['pod', 'pods']}
                  nameOf={nameOf}
                  onRemove={(p) => setSelection((s) => s.filter((x) => selKey(x.ctxId, x.ns, x.pod) !== selKey(p.ctxId, p.ns, p.name)))}
                  onClear={() => setSelection([])}
                >
                  <button
                    className="btn btn-sm btn-danger"
                    disabled={!armed}
                    onClick={deleteSelected}
                    title={armed ? 'Delete all selected pods at once' : 'Delete (switch to Ops Mode first)'}
                  >
                    <Icon name="trash" size={14} />
                    Delete
                  </button>
                  <button className="btn btn-sm btn-primary" onClick={viewSelection}>
                    View logs
                  </button>
                </SelectionBar>
              ) : (
                <SelectionBar
                  items={depSel.map((d) => ({ ctxId: d.ctxId, ns: d.ns, name: d.name, note: `${d.replicas} ${d.replicas === 1 ? 'replica' : 'replicas'}` }))}
                  noun={['deployment', 'deployments']}
                  nameOf={nameOf}
                  onRemove={(d) => setDepSel((s) => s.filter((x) => selKey(x.ctxId, x.ns, x.name) !== selKey(d.ctxId, d.ns, d.name)))}
                  onClear={() => setDepSel([])}
                >
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={!armed}
                    onClick={scaleSelected}
                    title={armed ? 'Scale all selected deployments at once' : 'Scale (switch to Ops Mode first)'}
                  >
                    <Icon name="sliders" size={14} />
                    Scale
                  </button>
                </SelectionBar>
              )}
            </main>
            {drawer && (
              <Drawer
                ctxId={ctxId}
                ns={ns}
                target={drawer}
                pods={pods.items}
                deployments={deps.items}
                armed={armed}
                width={prefs.drawerWidth ?? 0}
                logPrefs={prefs.log ?? {}}
                epoch={epoch}
                nameOf={nameOf}
                onLogPrefs={(l) => update((p) => ({ ...p, log: l }))}
                onWidth={(w) => update((p) => ({ ...p, drawerWidth: w }))}
                onTarget={setDrawer}
                onDeletePod={deletePod}
                onForward={setForwardPod}
                onDeploymentLogs={deploymentLogs}
                onRestart={restart}
                onScale={scale}
              />
            )}
          </>
        ) : (
          <div className="empty full">
            <p>{loadErr || 'None of your kubeconfigs could be loaded. Open Kubeconfigs to check them.'}</p>
            <button className="btn btn-primary" onClick={() => setVault(true)}>
              Open Kubeconfigs
            </button>
          </div>
        )}
      </div>

      {vault && <Vault sources={sources} contexts={contexts} labels={labels} onLabels={setLabels} onChanged={loadContexts} onClose={() => setVault(false)} />}
      {forwardPod && (
        <ForwardDialog
          ctxId={ctxId}
          ns={ns}
          pod={forwardPod}
          onClose={() => setForwardPod(null)}
          onStarted={(f) => {
            loadForwards();
            toast(`Forwarding ${f.address}:${f.localPort} to ${f.pod}:${f.podPort}`);
          }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          confirmText={confirm.confirmText}
          requireYes={confirm.requireYes}
          danger={confirm.danger}
          replicas={confirm.replicas}
          replicasLabel={confirm.replicasLabel}
          scaleRows={confirm.scaleRows}
          onConfirm={confirm.run}
          onClose={() => setConfirm(null)}
        >
          {confirm.body}
        </ConfirmDialog>
      )}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={cx('toast', t.tone)}>
            <Icon name={t.tone === 'ok' ? 'check' : 'alert'} />
            {t.text}
          </div>
        ))}
      </div>
      {bats && <BatBurst from={bats} onDone={batsDone} />}
    </div>
  );
}
