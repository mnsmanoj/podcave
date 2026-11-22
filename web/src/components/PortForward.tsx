import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useOutsideClick } from '../hooks';
import type { ForwardInfo, Pod } from '../types';
import { cx, errMsg } from '../util';
import { Icon } from './Icons';

const CUSTOM = 'custom';

function parsePort(s: string): number | null {
  if (!/^\d{1,5}$/.test(s.trim())) return null;
  const n = Number(s);
  return n >= 1 && n <= 65535 ? n : null;
}

interface DialogProps {
  ctxId: string;
  ns: string;
  pod: Pod;
  onClose: () => void;
  onStarted: (f: ForwardInfo) => void;
}

/** Equivalent of: kubectl -n <ns> port-forward pod/<pod> <local>:<pod port> */
export function ForwardDialog({ ctxId, ns, pod, onClose, onStarted }: DialogProps) {
  const tcp = useMemo(() => (pod.ports ?? []).filter((p) => p.protocol === 'TCP'), [pod.ports]);
  const [choice, setChoice] = useState(tcp[0] ? String(tcp[0].port) : CUSTOM);
  const [custom, setCustom] = useState('');
  const [local, setLocal] = useState(tcp[0] ? String(tcp[0].port) : '');
  const [localTouched, setLocalTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const selRef = useRef<HTMLSelectElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const podPort = choice === CUSTOM ? parsePort(custom) : Number(choice);
  const localPort = local.trim() === '' ? 0 : parsePort(local);
  const valid = podPort !== null && localPort !== null;

  useEffect(() => {
    (selRef.current ?? inputRef.current)?.focus();
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  // Keep local = pod port until the user edits it, like kubectl's "8080" shorthand.
  useEffect(() => {
    if (!localTouched && podPort) setLocal(String(podPort));
  }, [podPort, localTouched]);

  const start = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setErr('');
    try {
      const f = await api<ForwardInfo>('/api/forwards/start', {
        method: 'POST',
        body: { ctx: ctxId, ns, pod: pod.name, podPort, localPort },
      });
      onStarted(f);
      onClose();
    } catch (e) {
      setErr(errMsg(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-head">
          <div className="grow">
            <h3>Port-forward</h3>
            <p className="ellipsis">
              <span className="mono">{pod.name}</span> in {ns}
            </p>
          </div>
        </div>
        <div className="modal-body">
          <div className="form-row">
            <label className="field">
              <span className="field-label">Pod port</span>
              {tcp.length > 0 ? (
                <select className="select" value={choice} onChange={(e) => setChoice(e.target.value)} ref={selRef}>
                  {tcp.map((p) => (
                    <option key={`${p.container}-${p.port}`} value={p.port}>
                      {p.port}
                      {p.name ? ` ${p.name}` : ''}, {p.container}
                    </option>
                  ))}
                  <option value={CUSTOM}>Another port</option>
                </select>
              ) : (
                <input
                  className={cx('input mono', custom && podPort === null && 'invalid')}
                  value={custom}
                  placeholder="e.g. 80"
                  inputMode="numeric"
                  onChange={(e) => setCustom(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && start()}
                  ref={inputRef}
                />
              )}
              {choice === CUSTOM && tcp.length > 0 && (
                <input
                  className={cx('input mono', custom && podPort === null && 'invalid')}
                  value={custom}
                  placeholder="e.g. 80"
                  inputMode="numeric"
                  autoFocus
                  onChange={(e) => setCustom(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && start()}
                />
              )}
              <span className="field-hint">The port inside the container.</span>
            </label>
            <label className="field">
              <span className="field-label">Local port</span>
              <input
                className={cx('input mono', local && localPort === null && 'invalid')}
                value={local}
                placeholder="auto"
                inputMode="numeric"
                onChange={(e) => {
                  setLocal(e.target.value);
                  setLocalTouched(true);
                }}
                onKeyDown={(e) => e.key === 'Enter' && start()}
              />
              <span className="field-hint">On this computer. Empty picks a free one.</span>
            </label>
          </div>
          <div className="cmd-preview" title="Equivalent kubectl command">
            <span className="muted">$ </span>kubectl -n {ns} port-forward pod/{pod.name} {local.trim() || ''}:{podPort ?? '?'}
          </div>
          {err && <div className="panel-error" style={{ margin: '12px 0 0' }}>{err}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!valid || busy} onClick={start}>
            {busy && <span className="spinner" />}
            {busy ? 'Connecting' : 'Start forwarding'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface TrayProps {
  forwards: ForwardInfo[];
  nameOf: (ctxId: string) => string;
  onStop: (f: ForwardInfo) => void;
}

/** Header button + popover listing active port-forwards. */
export function ForwardsTray({ forwards, nameOf, onStop }: TrayProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClick(ref, () => setOpen(false), open);
  const active = forwards.filter((f) => f.state === 'active').length;
  const failed = forwards.some((f) => f.state === 'failed');

  const copy = async (f: ForwardInfo) => {
    try {
      await navigator.clipboard.writeText(`${f.address}:${f.localPort}`);
      setCopied(f.id);
      setTimeout(() => setCopied(''), 1200);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="fw-anchor" ref={ref}>
      <button className={cx('btn', open && 'on')} onClick={() => setOpen(!open)} title="Port-forwards">
        Forwards
        {forwards.length > 0 && <span className={cx('count', failed && 'tone-bad')}>{active}</span>}
        {failed && <span className="alert-dot" />}
      </button>
      {open && (
        <div className="popover fw-pop">
          <div className="fw-pop-head">
            Port-forwards
            <span className="muted small">bound to 127.0.0.1 only</span>
          </div>
          <div className="fw-list">
            {forwards.length === 0 && <div className="fw-empty">No active forwards. In Ops Mode, use Forward on a pod to start one.</div>}
            {forwards.map((f) => {
              const url = `http://${f.address}:${f.localPort}`;
              const ok = f.state === 'active';
              return (
                <div key={f.id} className="fw-item">
                  <div className="fw-row">
                    <span className={cx('dot', ok ? 'tone-ok' : 'tone-bad')} />
                    <span className="fw-addr">
                      {f.address}:{f.localPort}
                    </span>
                    <Icon name="arrowRight" size={13} className="fw-arrow" />
                    <span className="mono small muted">:{f.podPort}</span>
                    <span className="fw-actions">
                      {ok && (
                        <>
                          <a className="btn btn-ghost btn-sm btn-icon" href={url} target="_blank" rel="noopener noreferrer" title={`Open ${url}`}>
                            <Icon name="external" size={14} />
                          </a>
                          <button className="btn btn-ghost btn-sm btn-icon" onClick={() => copy(f)} title="Copy address">
                            <Icon name={copied === f.id ? 'check' : 'copy'} size={14} />
                          </button>
                        </>
                      )}
                      <button className="btn btn-ghost btn-sm btn-icon" onClick={() => onStop(f)} title={ok ? 'Stop forwarding' : 'Dismiss'}>
                        <Icon name="x" size={14} />
                      </button>
                    </span>
                  </div>
                  <div className="fw-meta ellipsis">
                    {f.pod} in {f.namespace}, {nameOf(f.ctx)}
                  </div>
                  {!ok && f.message && <div className="fw-err">{f.message}</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
