import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ContextInfo, ContextPreview, SourceStatus } from '../types';
import { cx, displayName, errMsg } from '../util';
import { BatEmblem } from './Bat';
import { Icon } from './Icons';

interface Props {
  sources: SourceStatus[];
  contexts: ContextInfo[];
  labels: Record<string, string>;
  onLabels: (patch: Record<string, string>) => void;
  onboarding?: boolean;
  onChanged: () => void;
  onClose?: () => void;
}

const MAX_LABEL = 40;

function host(s: string) {
  try {
    return new URL(s).host;
  } catch {
    return s;
  }
}

export function Vault({ sources, contexts, labels, onLabels, onboarding, onChanged, onClose }: Props) {
  const [suggest, setSuggest] = useState<string[]>([]);
  const [mode, setMode] = useState<'link' | 'import'>('link');
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [preview, setPreview] = useState<{ list: ContextPreview[]; err: string } | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  useEffect(() => {
    api<{ paths: string[] }>('/api/sources/suggest')
      .then((r) => setSuggest(r.paths ?? []))
      .catch(() => setSuggest([]));
  }, [sources.length]);

  useEffect(() => {
    if (!onClose) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  // Read the clusters out of the kubeconfig before saving so they can be labelled.
  const input = mode === 'link' ? path.trim() : content.trim();
  useEffect(() => {
    setPreview(null);
    if (!input) return;
    let alive = true;
    const t = setTimeout(() => {
      api<{ contexts: ContextPreview[] }>('/api/sources/preview', { method: 'POST', body: mode === 'link' ? { path: input } : { content } })
        .then((r) => alive && setPreview({ list: r.contexts ?? [], err: '' }))
        .catch((e) => alive && setPreview({ list: [], err: errMsg(e) }));
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [mode, input]);

  const reset = () => {
    setPath('');
    setContent('');
    setName('');
    setDraft({});
    setPreview(null);
  };

  const save = async () => {
    setBusy(true);
    setErr('');
    setOk('');
    try {
      const src =
        mode === 'link'
          ? await api<{ id: string }>('/api/sources/file', { method: 'POST', body: { path: path.trim(), name: name.trim() } })
          : await api<{ id: string }>('/api/sources/import', { method: 'POST', body: { name: name.trim() || 'Imported kubeconfig', content } });
      const patch: Record<string, string> = {};
      for (const [ctx, label] of Object.entries(draft)) if (label.trim()) patch[`${src.id}/${ctx}`] = label.trim();
      if (Object.keys(patch).length) onLabels(patch);
      setOk(mode === 'link' ? 'Kubeconfig added.' : 'Kubeconfig imported and encrypted.');
      reset();
      onChanged();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const browse = async () => {
    setErr('');
    setBusy(true);
    try {
      const r = await api<{ path: string }>('/api/sources/browse', { method: 'POST', body: {} });
      if (r.path) setPath(r.path);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const readFile = (f: File | undefined) => {
    if (!f) return;
    if (f.size > 1024 * 1024) {
      setErr('That file is larger than 1 MiB, so it is probably not a kubeconfig.');
      return;
    }
    const r = new FileReader();
    r.onload = () => {
      setContent(String(r.result ?? ''));
      if (!name) setName(f.name);
    };
    r.readAsText(f);
  };

  const found = preview?.list ?? [];
  const canSave = !busy && found.length > 0;

  const body = (
    <div className="vault">
      <div className="vault-head">
        <div className="grow">
          <h2>Kubeconfigs</h2>
          <p>Pod Cave remembers these between launches.</p>
        </div>
        {onClose && (
          <button className="btn btn-ghost btn-icon" onClick={onClose} title="Close (Esc)">
            <Icon name="x" />
          </button>
        )}
      </div>

      {sources.length > 0 && (
        <section>
          <h4>Saved</h4>
          <ul className="src-list">
            {sources.map((s) => (
              <SourceRow key={s.id} s={s} contexts={contexts.filter((c) => c.sourceId === s.id)} labels={labels} onLabels={onLabels} onChanged={onChanged} />
            ))}
          </ul>
        </section>
      )}

      <section>
        <h4>Add a kubeconfig</h4>
        <div className="seg seg-full">
          <button className={cx(mode === 'link' && 'on')} onClick={() => setMode('link')}>
            Use a file on disk
          </button>
          <button className={cx(mode === 'import' && 'on')} onClick={() => setMode('import')}>
            Import an encrypted copy
          </button>
        </div>

        {mode === 'link' ? (
          <div className="form">
            <p className="hint">
              Read in place every time, never copied. Good for <span className="mono">~/.kube/config</span>, which <span className="mono">az aks get-credentials</span>{' '}
              keeps up to date.
            </p>
            {suggest.length > 0 && !path && (
              <div className="suggest">
                {suggest.map((p) => (
                  <button key={p} className="suggest-btn" onClick={() => setPath(p)}>
                    <span className="mono ellipsis">{p}</span>
                    <span className="muted small">Use this</span>
                  </button>
                ))}
              </div>
            )}
            <div className="row">
              <input className="input grow mono" placeholder="C:\Users\you\.kube\config" value={path} onChange={(e) => setPath(e.target.value)} spellCheck={false} />
              <button className="btn" disabled={busy} onClick={browse}>
                Browse
              </button>
            </div>
          </div>
        ) : (
          <div className="form">
            <p className="hint">Stored in your Pod Cave settings folder and encrypted with Windows DPAPI, so only your Windows account can read it.</p>
            <div className="row">
              <label className="btn file-btn">
                Choose file
                <input type="file" onChange={(e) => readFile(e.target.files?.[0])} />
              </label>
              <span className="muted small">or paste the YAML below</span>
            </div>
            <textarea className="input mono" rows={7} placeholder={'apiVersion: v1\nkind: Config\n...'} value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} />
          </div>
        )}

        {preview?.err && input && <div className="form-note bad-text">{preview.err}</div>}

        {found.length > 0 && (
          <div className="found">
            <div className="found-head">
              {found.length === 1 ? 'Found 1 cluster.' : `Found ${found.length} clusters.`} Add a label if you want to tell them apart, for example <i>nonprod</i>.
            </div>
            {found.map((c) => {
              const label = draft[c.name] ?? '';
              return (
                <div className="label-row" key={c.name}>
                  <div className="label-row-name">
                    <span className="mono">{c.name}</span>
                    <span className="muted small ellipsis">{host(c.server)}</span>
                  </div>
                  <input
                    className="input input-sm"
                    placeholder="Label (optional)"
                    maxLength={MAX_LABEL}
                    value={label}
                    onChange={(e) => setDraft((d) => ({ ...d, [c.name]: e.target.value }))}
                  />
                  <span className="label-row-shows muted small ellipsis">Shows as {displayName(c.name, label)}</span>
                </div>
              );
            })}
            <div className="row">
              <input className="input grow" placeholder="Name for this kubeconfig (optional)" value={name} onChange={(e) => setName(e.target.value)} />
              <button className="btn btn-primary" disabled={!canSave} onClick={save}>
                {busy && <span className="spinner" />}
                {mode === 'link' ? 'Add kubeconfig' : 'Import and encrypt'}
              </button>
            </div>
          </div>
        )}
        {err && <div className="panel-error">{err}</div>}
        {ok && <div className="panel-ok">{ok}</div>}
      </section>

      <p className="vault-foot">
        Credentials stay on this computer and are never sent to the browser. Pod Cave only talks to the API servers in your kubeconfigs, and runs{' '}
        <span className="mono">kubelogin</span> or <span className="mono">az</span> the same way kubectl does.
      </p>
    </div>
  );

  if (onboarding) {
    return (
      <div className="onboarding">
        <div className="hero">
          <BatEmblem size={44} />
          <h1>Pod Cave</h1>
          <p>Add a kubeconfig to get started. You only need to do this once.</p>
        </div>
        <div className="card">{body}</div>
      </div>
    );
  }
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal wide">{body}</div>
    </div>
  );
}

interface RowProps {
  s: SourceStatus;
  contexts: ContextInfo[];
  labels: Record<string, string>;
  onLabels: (patch: Record<string, string>) => void;
  onChanged: () => void;
}

function SourceRow({ s, contexts, labels, onLabels, onChanged }: RowProps) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(s.name);
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    try {
      await api('/api/sources/rename', { method: 'POST', body: { id: s.id, name } });
      setEditing(false);
      onChanged();
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  const remove = async () => {
    try {
      await api('/api/sources/remove', { method: 'POST', body: { id: s.id } });
      const patch: Record<string, string> = {};
      for (const c of contexts) if (labels[c.id]) patch[c.id] = '';
      if (Object.keys(patch).length) onLabels(patch);
      onChanged();
    } catch (e) {
      setErr(errMsg(e));
    }
  };

  return (
    <li className={cx('src', s.error && 'has-err')}>
      <div className="src-main">
        {editing ? (
          <input className="input input-sm" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
        ) : (
          <span className="src-name">{s.name}</span>
        )}
        <span className="src-kind">{s.kind === 'imported' ? 'Encrypted copy' : 'File on disk'}</span>
        <span className="grow" />
        <div className="src-actions">
          {editing ? (
            <>
              <button className="btn btn-sm btn-primary" onClick={save}>
                Save
              </button>
              <button className="btn btn-sm" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </>
          ) : confirm ? (
            <>
              <span className="small">{s.kind === 'imported' ? 'Delete the encrypted copy?' : 'Stop using this file? It stays on disk.'}</span>
              <button className="btn btn-sm btn-danger solid" onClick={remove}>
                Remove
              </button>
              <button className="btn btn-sm" onClick={() => setConfirm(false)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-sm btn-ghost" onClick={() => setEditing(true)}>
                Rename
              </button>
              <button className="btn btn-sm btn-ghost btn-danger" onClick={() => setConfirm(true)}>
                Remove
              </button>
            </>
          )}
        </div>
      </div>
      {s.path && <div className="src-path mono">{s.path}</div>}
      {s.error && <div className="src-err">{s.error}</div>}
      {err && <div className="src-err">{err}</div>}
      {contexts.length > 0 && (
        <div className="src-ctxs">
          {contexts.map((c) => (
            <div className="label-row" key={c.id}>
              <div className="label-row-name">
                <span className="mono">{c.name}</span>
                <span className="muted small ellipsis">{host(c.server)}</span>
              </div>
              <input
                className="input input-sm"
                placeholder="Label (optional)"
                maxLength={MAX_LABEL}
                value={labels[c.id] ?? ''}
                onChange={(e) => onLabels({ [c.id]: e.target.value })}
              />
              <span className="label-row-shows muted small ellipsis">Shows as {displayName(c.name, labels[c.id])}</span>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}
