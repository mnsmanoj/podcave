import { useEffect, useState } from 'react';
import { api } from '../api';
import type { SourceStatus } from '../types';
import { cx, errMsg } from '../util';
import { BatSignalArt } from './Bat';

interface Props {
  sources: SourceStatus[];
  onboarding?: boolean;
  onChanged: () => void;
  onClose?: () => void;
}

export function Vault({ sources, onboarding, onChanged, onClose }: Props) {
  const [suggest, setSuggest] = useState<string[]>([]);
  const [mode, setMode] = useState<'link' | 'import'>('link');
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  const loadSuggest = () =>
    api<{ paths: string[] }>('/api/sources/suggest')
      .then((r) => setSuggest(r.paths ?? []))
      .catch(() => setSuggest([]));

  useEffect(() => {
    loadSuggest();
  }, [sources.length]);

  useEffect(() => {
    if (!onClose) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  const run = async (fn: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setErr('');
    setOk('');
    try {
      await fn();
      setOk(success);
      onChanged();
      return true;
    } catch (e) {
      setErr(errMsg(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const link = async (p: string, n = '') => {
    if (await run(() => api('/api/sources/file', { method: 'POST', body: { path: p, name: n } }), 'Kubeconfig linked.')) {
      setPath('');
      setName('');
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

  const importNow = async () => {
    if (await run(() => api('/api/sources/import', { method: 'POST', body: { name: name || 'imported kubeconfig', content } }), 'Kubeconfig imported and encrypted.')) {
      setContent('');
      setName('');
    }
  };

  const readFile = (f: File | undefined) => {
    if (!f) return;
    if (f.size > 1024 * 1024) {
      setErr('That file is larger than 1 MiB — it does not look like a kubeconfig.');
      return;
    }
    const r = new FileReader();
    r.onload = () => {
      setContent(String(r.result ?? ''));
      if (!name) setName(f.name);
    };
    r.readAsText(f);
  };

  const body = (
    <div className="vault">
      {!onboarding && (
        <div className="vault-head">
          <h2>
            <span className="key">🔑</span> Kubeconfig Vault
          </h2>
          {onClose && (
            <button className="icon close" onClick={onClose} title="Close (Esc)">
              ✕
            </button>
          )}
        </div>
      )}

      {sources.length > 0 && (
        <section>
          <h4>In the vault</h4>
          <ul className="src-list">
            {sources.map((s) => (
              <SourceRow key={s.id} s={s} onChanged={onChanged} />
            ))}
          </ul>
        </section>
      )}

      <section>
        <h4>Add a kubeconfig</h4>
        {suggest.length > 0 && (
          <div className="suggest">
            {suggest.map((p) => (
              <button key={p} className="btn suggest-btn" disabled={busy} onClick={() => link(p)}>
                <span className="plus">＋</span> Link <span className="mono">{p}</span>
              </button>
            ))}
          </div>
        )}
        <div className="seg">
          <button className={cx(mode === 'link' && 'on')} onClick={() => setMode('link')}>
            Link a file <small>recommended</small>
          </button>
          <button className={cx(mode === 'import' && 'on')} onClick={() => setMode('import')}>
            Import a copy <small>encrypted</small>
          </button>
        </div>

        {mode === 'link' ? (
          <div className="form">
            <p className="hint">
              Pod Cave reads the file <b>in place</b> every time — nothing is copied. Ideal for <span className="mono">~/.kube/config</span>, which{' '}
              <span className="mono">az aks get-credentials</span> keeps up to date.
            </p>
            <div className="row">
              <input className="grow mono" placeholder="C:\Users\you\.kube\config" value={path} onChange={(e) => setPath(e.target.value)} />
              <button className="btn" disabled={busy} onClick={browse}>
                Browse…
              </button>
            </div>
            <div className="row">
              <input className="grow" placeholder="Display name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
              <button className="btn primary" disabled={busy || !path.trim()} onClick={() => link(path, name)}>
                Link kubeconfig
              </button>
            </div>
          </div>
        ) : (
          <div className="form">
            <p className="hint">
              The contents are stored in your Pod Cave settings folder, <b>encrypted with Windows DPAPI</b> so only your Windows account can read them.
            </p>
            <div className="row">
              <input className="grow" placeholder="Display name, e.g. prod-aks" value={name} onChange={(e) => setName(e.target.value)} />
              <label className="btn file-btn">
                Choose file…
                <input type="file" onChange={(e) => readFile(e.target.files?.[0])} />
              </label>
            </div>
            <textarea className="mono" rows={8} placeholder="…or paste kubeconfig YAML here" value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} />
            <div className="row end">
              <button className="btn primary" disabled={busy || !content.trim()} onClick={importNow}>
                Import &amp; encrypt
              </button>
            </div>
          </div>
        )}
        {err && <div className="panel-error">{err}</div>}
        {ok && <div className="panel-ok">{ok}</div>}
      </section>

      <section className="vault-foot">
        <b>Safety:</b> credentials never leave this computer and are never sent to the browser. Pod Cave only talks to the API servers in your kubeconfigs, and runs{' '}
        <span className="mono">kubelogin</span>/<span className="mono">az</span> exactly as kubectl would.
      </section>
    </div>
  );

  if (onboarding) {
    return (
      <div className="onboarding">
        <div className="hero">
          <BatSignalArt className="hero-art" />
          <h1>Welcome to the Cave</h1>
          <p>Add a kubeconfig to light up your clusters. Pod Cave remembers it — you only do this once.</p>
        </div>
        {body}
      </div>
    );
  }
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal wide">{body}</div>
    </div>
  );
}

function SourceRow({ s, onChanged }: { s: SourceStatus; onChanged: () => void }) {
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
      onChanged();
    } catch (e) {
      setErr(errMsg(e));
    }
  };

  return (
    <li className={cx('src', s.error && 'has-err')}>
      <div className="src-main">
        {editing ? (
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
        ) : (
          <span className="src-name">{s.name}</span>
        )}
        <span className={cx('badge', s.kind === 'imported' ? 'enc' : 'link')}>{s.kind === 'imported' ? '🔒 encrypted import' : '🔗 linked file'}</span>
        <span className="muted small">{s.error ? '' : `${s.contexts} context${s.contexts === 1 ? '' : 's'}`}</span>
      </div>
      {s.path && <div className="src-path mono">{s.path}</div>}
      {s.error && <div className="src-err">{s.error}</div>}
      {err && <div className="src-err">{err}</div>}
      <div className="src-actions">
        {editing ? (
          <>
            <button className="act" onClick={save}>
              Save
            </button>
            <button className="act" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </>
        ) : confirm ? (
          <>
            <span className="small warn-text">{s.kind === 'imported' ? 'Delete the encrypted copy?' : 'Unlink (the file itself is kept)?'}</span>
            <button className="act danger" onClick={remove}>
              Yes, remove
            </button>
            <button className="act" onClick={() => setConfirm(false)}>
              No
            </button>
          </>
        ) : (
          <>
            <button className="act" onClick={() => setEditing(true)}>
              Rename
            </button>
            <button className="act danger" onClick={() => setConfirm(true)}>
              Remove
            </button>
          </>
        )}
      </div>
    </li>
  );
}
