import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, bootstrap, onSessionLost, qs, sleep, stream } from './api';
import { BatEmblem } from './components/Bat';
import { BatSignal } from './components/BatSignal';
import { ConfirmDialog } from './components/ConfirmDialog';
import { Drawer } from './components/Drawer';
import { Icon } from './components/Icons';
import { NamespaceList } from './components/NamespaceList';
import { ForwardDialog, ForwardsTray } from './components/PortForward';
import { DeploymentsTable, PodsTable, StatusChips, StreamChip } from './components/Tables';
import { TopBar } from './components/TopBar';
import { Vault } from './components/Vault';
import { useWatch } from './hooks';
import { applyTheme, storedTheme, watchSystemTheme } from './theme';
import type { AuthEvent, ContextInfo, Deployment, DrawerTarget, ForwardInfo, Pod, Prefs, SourceStatus, StreamStatus, ThemePref } from './types';
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
  const [tone, setTone] = useState<Tone | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [forwardPod, setForwardPod] = useState<Pod | null>(null);
  const [forwards, setForwards] = useState<ForwardInfo[]>([]);
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
    setDrawer(null);
    setFilter('');
    setTone(null);
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
      typeToConfirm: p.name,
      danger: true,
      run: async () => {
        await api('/api/pods/delete', { method: 'POST', body: { ctx: ctxId, ns, name: p.name, confirm: p.name } });
        toast(`Pod ${p.name} deleted.`);
      },
    });

  const restart = (d: Deployment) =>
    setConfirm({
      title: `Restart ${d.name}?`,
      body: (
        <p>
          Performs a rolling restart (same as <span className="mono">kubectl rollout restart</span>) in <b>{ns}</b> on <b>{currentName}</b>.
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
      title: `Scale ${d.name}`,
      body: (
        <p>
          Currently <b>{d.replicas}</b> replica{d.replicas === 1 ? '' : 's'} in <b>{ns}</b> on <b>{currentName}</b>.
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
      title: 'Switch to Ops Mode?',
      body: (
        <>
          <p>Ops Mode lets you delete pods, restart and scale deployments, and port-forward for this session.</p>
          <p className="muted">
            Destructive actions still ask you to type the resource name. Pod Cave always starts in read-only Night Watch, and you can only do what your Kubernetes
            permissions allow.
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
                onLogPrefs={(l) => update((p) => ({ ...p, log: l }))}
                onWidth={(w) => update((p) => ({ ...p, drawerWidth: w }))}
                onTarget={setDrawer}
                onDeletePod={deletePod}
                onForward={setForwardPod}
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
            <Icon name={t.tone === 'ok' ? 'check' : 'alert'} />
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
