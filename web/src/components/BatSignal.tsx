import { useState } from 'react';
import { api } from '../api';
import type { AuthEvent, ContextInfo } from '../types';
import { cx, errMsg } from '../util';
import { BatSignalArt } from './Bat';

interface Props {
  events: AuthEvent[];
  contexts: ContextInfo[];
  onDismiss: (ctx: string) => void;
}

/** Raised whenever a cluster needs the user to sign in again (the Cave Signal). */
export function BatSignal({ events, contexts, onDismiss }: Props) {
  if (!events.length) return null;
  return (
    <div className="batsignal-stack">
      {events.map((e) => (
        <Signal key={e.ctx} ev={e} ctx={contexts.find((c) => c.id === e.ctx)} onDismiss={() => onDismiss(e.ctx)} />
      ))}
    </div>
  );
}

function Signal({ ev, ctx, onDismiss }: { ev: AuthEvent; ctx?: ContextInfo; onDismiss: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);
  const azure = ctx?.loginMode === 'azurecli';

  const login = async (method: string) => {
    setBusy(true);
    setErr('');
    try {
      await api('/api/auth/login', { method: 'POST', body: { ctx: ev.ctx, method } });
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!ev.code) return;
    try {
      await navigator.clipboard.writeText(ev.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  const title =
    ev.state === 'device-code'
      ? 'THE SIGNAL IS LIT — SIGN IN'
      : ev.state === 'pending'
        ? 'AWAITING CLEARANCE…'
        : ev.state === 'needs-login'
          ? 'SIGNAL LOST — SESSION EXPIRED'
          : 'SIGNAL LOST — AUTH FAILED';

  return (
    <div className={cx('batsignal', `bs-${ev.state}`)} role="alert">
      <BatSignalArt className="bs-art" />
      <div className="bs-body">
        <div className="bs-title">
          {title}
          <span className="bs-ctx">{ctx?.name ?? ev.ctx}</span>
        </div>
        {ev.message && <div className="bs-msg">{ev.message}</div>}
        {ev.state === 'device-code' && ev.code && (
          <div className="bs-code">
            <span className="code mono">{ev.code}</span>
            <button className="btn" onClick={copy}>
              {copied ? 'Copied ✓' : 'Copy code'}
            </button>
            {ev.url && /^https:\/\//.test(ev.url) && (
              <a className="btn primary" href={ev.url} target="_blank" rel="noopener noreferrer">
                Open sign-in page ↗
              </a>
            )}
            <span className="muted small">Only enter this code if you started this sign-in from Pod Cave just now.</span>
          </div>
        )}
        {ev.state !== 'device-code' && ev.state !== 'pending' && (
          <div className="bs-actions">
            {azure && (
              <>
                <button className="btn primary" disabled={busy} onClick={() => login('az-browser')}>
                  Re-login (browser)
                </button>
                <button className="btn" disabled={busy} onClick={() => login('az-devicecode')}>
                  Re-login (device code)
                </button>
              </>
            )}
            <button className={cx('btn', !azure && 'primary')} disabled={busy} onClick={() => login('retry')}>
              {azure ? 'Retry' : 'Sign in again'}
            </button>
          </div>
        )}
        {err && <div className="bs-err">{err}</div>}
      </div>
      <button className="icon bs-close" onClick={onDismiss} title="Dismiss">
        ✕
      </button>
    </div>
  );
}
