import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, bootstrap, onSessionLost, qs, sleep, stream } from './api';
import { BatEmblem, BatSignalArt } from './components/Bat';
import { BatSignal } from './components/BatSignal';
import { ConfirmDialog } from './components/ConfirmDialog';
import { Drawer } from './components/Drawer';
import { NamespaceList } from './components/NamespaceList';
import { DeploymentsTable, PodsTable, StreamChip } from './components/Tables';
import { TopBar } from './components/TopBar';
import { Vault } from './components/Vault';
import { useWatch } from './hooks';
import type { AuthEvent, ContextInfo, Deployment, DrawerTarget, Pod, Prefs, SourceStatus, StreamStatus } from './types';
import { cx, errMsg } from './util';

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
  if (phase === 'loading')
    return (
      <div className="splash">
        <BatEmblem size={96} />
        <p>Opening the cave…</p>
      </div>
    );
  if (phase === 'locked') return <Locked />;
  return <Cave />;
}

function Locked() {
  return (
    <div className="splash locked">
      <BatSignalArt className="hero-art" />
      <h1>The cave is sealed</h1>
      <p>
        This tab is not signed in. Pod Cave sign-in links are <b>single-use</b> and only work on this computer.
      </p>
      <ol>
        <li>
          Switch to the <b>Pod Cave</b> console window.
        </li>
        <li>
          Press <kbd>Enter</kbd> — a fresh link opens in your browser.
        </li>
      </ol>
      <p className="muted small">If you closed the console, just start podcave.exe again.</p>
    </div>
  );
}

interface Confirm {
  title: string;
  body: ReactNode;
  confirmText: string;
  typeToConfirm?: string;
  danger?: boolean;
  replicas?: number;
  run: (replicas?: number) => Promise<void>;
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
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [epoch, setEpoch] = useState(0);
  const filterRef = useRef<HTMLInputElement>(null);

  const toast = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
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

  useEffect(() => {
    api<Prefs>('/api/prefs')
      .then((p) => setPrefs(p ?? {}))
      .catch(() => setPrefs({}));
    loadContexts();
    api<{ armed: boolean }>('/api/state')
      .then((s) => setArmed(s.armed))
      .catch(() => {});
  }, [loadContexts]);

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

  // Server events: auth prompts (Cave Signal) and read-only mode changes.
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
              }
              if (e.type === 'mode') setArmed(e.state === 'true');
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
  }, []);

  const current = contexts.find((c) => c.id === prefs?.lastContext) ?? contexts.find((c) => c.current) ?? contexts[0];
  const ctxId = current?.id ?? '';
  const ns = current ? (prefs?.lastNamespace?.[current.id] ?? current.namespace) : '';
  const tab = prefs?.tab ?? 'pods';

  const podsPath = prefs && ctxId && ns ? '/api/pods/watch?' + qs({ ctx: ctxId, ns, e: epoch }) : null;
  const depsPath = prefs && ctxId && ns ? '/api/deployments/watch?' + qs({ ctx: ctxId, ns, e: epoch }) : null;
  const pods = useWatch<Pod>(podsPath);
  const deps = useWatch<Deployment>(depsPath);

  useEffect(() => {
    setDrawer(null);
    setFilter('');
  }, [ctxId, ns]);

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
      toast(r.armed ? 'Utility Belt armed — write actions enabled.' : 'Night Watch restored — read-only.');
    } catch (e) {
      toast(errMsg(e), 'bad');
    }
  };

  const deletePod = (p: Pod) =>
    setConfirm({
      title: `Delete pod ${p.name}?`,
      body: (
        <p>
          The pod will be terminated in <b>{ns}</b> on <b>{current?.name}</b>.{' '}
          {p.owner ? `Its ${p.owner.kind} will create a replacement.` : 'It has no controller and will NOT come back.'}
        </p>
      ),
      confirmText: 'Delete pod',
      typeToConfirm: p.name,
      danger: true,
      run: async () => {
        await api('/api/pods/delete', { method: 'POST', body: { ctx: ctxId, ns, name: p.name, confirm: p.name } });
        toast(`Pod ${p.name} deleted.`);
      },
    });

  const restart = (d: Deployment) =>
    setConfirm({
      title: `Restart deployment ${d.name}?`,
      body: (
        <p>
          Performs a rolling restart (same as <span className="mono">kubectl rollout restart</span>) in <b>{ns}</b> on <b>{current?.name}</b>.
        </p>
      ),
      confirmText: 'Rollout restart',
      typeToConfirm: d.name,
      run: async () => {
        await api('/api/deployments/restart', { method: 'POST', body: { ctx: ctxId, ns, name: d.name, confirm: d.name } });
        toast(`Rollout restart of ${d.name} started.`);
      },
    });

  const scale = (d: Deployment) =>
    setConfirm({
      title: `Scale deployment ${d.name}`,
      body: (
        <p>
          Currently <b>{d.replicas}</b> replica{d.replicas === 1 ? '' : 's'} in <b>{ns}</b> on <b>{current?.name}</b>.
        </p>
      ),
      confirmText: 'Scale',
      typeToConfirm: d.name,
      replicas: d.replicas,
      run: async (replicas) => {
        await api('/api/deployments/scale', { method: 'POST', body: { ctx: ctxId, ns, name: d.name, confirm: d.name, replicas } });
        toast(`${d.name} scaled to ${replicas}.`);
      },
    });

  const arm = () =>
    setConfirm({
      title: 'Arm the Utility Belt?',
      body: (
        <>
          <p>This enables write actions for this session: delete pods, restart and scale deployments.</p>
          <p className="muted">
            Every action still asks you to type the resource name. Pod Cave always starts in read-only Night Watch, and you can only do what your Kubernetes
            permissions allow.
          </p>
        </>
      ),
      confirmText: 'Arm',
      run: async () => setMode(true),
    });

  if (!prefs || !loaded) {
    return (
      <div className="splash">
        <BatEmblem size={96} />
        <p>Powering up the Cave Computer…</p>
      </div>
    );
  }

  if (sources.length === 0) {
    return <Vault sources={sources} onboarding onChanged={loadContexts} />;
  }

  const watchStatus: StreamStatus = tab === 'pods' ? pods.status : deps.status;

  return (
    <div className={cx('app', armed && 'is-armed')}>
      <TopBar
        contexts={contexts}
        current={current}
        armed={armed}
        authEvents={authEvents}
        onContext={(id) => update((p) => ({ ...p, lastContext: id }))}
        onArm={arm}
        onDisarm={() => setMode(false)}
        onVault={() => setVault(true)}
      />
      <BatSignal events={signals} contexts={contexts} onDismiss={(c) => setDismissed((d) => ({ ...d, [c]: authEvents[c]?.time ?? '' }))} />

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
              <div className="main-head">
                <div className="crumbs">
                  <span className="muted">{current.name}</span>
                  <span className="sep">›</span>
                  <b>{ns}</b>
                </div>
                <div className="tabs">
                  <button className={cx(tab === 'pods' && 'on')} onClick={() => update((p) => ({ ...p, tab: 'pods' }))}>
                    Pods <span className="count">{pods.items.length}</span>
                  </button>
                  <button className={cx(tab === 'deployments' && 'on')} onClick={() => update((p) => ({ ...p, tab: 'deployments' }))}>
                    Deployments <span className="count">{deps.items.length}</span>
                  </button>
                </div>
                <div className="main-tools">
                  <input ref={filterRef} className="filter" value={filter} placeholder={`Search ${tab}…  ( / )`} onChange={(e) => setFilter(e.target.value)} />
                  <StreamChip status={watchStatus} />
                </div>
              </div>

              {(watchStatus.state === 'error' || watchStatus.state === 'auth' || watchStatus.state === 'reconnecting') && watchStatus.message && (
                <div className={cx('banner', watchStatus.state === 'reconnecting' ? 'warn' : 'bad')}>
                  {watchStatus.state === 'auth' ? 'Signal lost: ' : ''}
                  {watchStatus.message}
                </div>
              )}

              {tab === 'pods' ? (
                <PodsTable pods={pods.items} filter={filter} armed={armed} onOpen={(p, t) => setDrawer({ kind: 'pod', name: p.name, tab: t, snapshot: p })} onDelete={deletePod} />
              ) : (
                <DeploymentsTable
                  deployments={deps.items}
                  filter={filter}
                  armed={armed}
                  onOpen={(d, t) => setDrawer({ kind: 'deployment', name: d.name, tab: t })}
                  onRestart={restart}
                  onScale={scale}
                />
              )}
              {watchStatus.state === 'live' && (tab === 'pods' ? pods.items.length === 0 : deps.items.length === 0) && (
                <div className="empty">
                  <BatEmblem size={56} />
                  <p>
                    No {tab} in <b>{ns}</b>. Quiet night in the cluster.
                  </p>
                </div>
              )}
              {watchStatus.state === 'connecting' && <div className="empty muted">Scanning {ns}…</div>}
            </main>
            {drawer && (
              <Drawer
                ctxId={ctxId}
                ns={ns}
                target={drawer}
                pods={pods.items}
                deployments={deps.items}
                armed={armed}
                width={prefs.drawerWidth ?? Math.round(window.innerWidth * 0.62)}
                logPrefs={prefs.log ?? {}}
                epoch={epoch}
                onLogPrefs={(l) => update((p) => ({ ...p, log: l }))}
                onWidth={(w) => update((p) => ({ ...p, drawerWidth: w }))}
                onTarget={setDrawer}
                onDeletePod={deletePod}
                onRestart={restart}
                onScale={scale}
              />
            )}
          </>
        ) : (
          <div className="empty full">
            <BatSignalArt className="hero-art" />
            <p>{loadErr || 'None of your kubeconfigs could be loaded. Open the Kubeconfig Vault to check them.'}</p>
            <button className="btn primary" onClick={() => setVault(true)}>
              Open Kubeconfig Vault
            </button>
          </div>
        )}
      </div>

      {vault && <Vault sources={sources} onChanged={loadContexts} onClose={() => setVault(false)} />}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          confirmText={confirm.confirmText}
          typeToConfirm={confirm.typeToConfirm}
          danger={confirm.danger}
          replicas={confirm.replicas}
          onConfirm={confirm.run}
          onClose={() => setConfirm(null)}
        >
          {confirm.body}
        </ConfirmDialog>
      )}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={cx('toast', t.tone)}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
