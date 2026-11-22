import { useState } from 'react';
import { api } from '../api';
import type { AuthEvent, ContextInfo } from '../types';
import { cx, errMsg } from '../util';
import { Icon } from './Icons';

interface Props {
  events: AuthEvent[];
  contexts: ContextInfo[];
  nameOf: (ctxId: string) => string;
  onDismiss: (ctx: string) => void;
}

/** The Cave Signal: raised whenever a cluster needs you to sign in again. */
export function BatSignal({ events, contexts, nameOf, onDismiss }: Props) {
  if (!events.length) return null;
  return (
    <div className="signals">
      {events.map((e) => (
        <Signal key={e.ctx} ev={e} name={nameOf(e.ctx)} ctx={contexts.find((c) => c.id === e.ctx)} onDismiss={() => onDismiss(e.ctx)} />
      ))}
    </div>
  );
}

const TITLES: Record<string, string> = {
  'device-code': 'Sign in to continue',
  pending: 'Signing in',
  'needs-login': 'Your session expired',
  error: 'Sign-in failed',
};

function Signal({ ev, name, ctx, onDismiss }: { ev: AuthEvent; name: string; ctx?: ContextInfo; onDismiss: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);
  const azure = ctx?.loginMode === 'azurecli';
  const bad = ev.state === 'needs-login' || ev.state === 'error';

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

  return (
    <div className={cx('signal', bad && 'bad')} role="alert">
      <div className="signal-icon">
        {ev.state === 'pending' ? <span className="spinner" /> : <Icon name="signal" size={18} />}
      </div>
      <div className="signal-body">
        <div className="signal-label">Cave Signal, {name}</div>
        <div className="signal-title">{TITLES[ev.state] ?? 'Sign-in needed'}</div>
        {ev.message && <div className="signal-msg">{ev.message}</div>}
        {ev.state === 'device-code' && ev.code && (
          <div className="signal-actions">
            <span className="signal-code">{ev.code}</span>
            <button className="btn" onClick={copy}>
              <Icon name={copied ? 'check' : 'copy'} size={14} />
              {copied ? 'Copied' : 'Copy code'}
            </button>
            {ev.url && /^https:\/\//.test(ev.url) && (
              <a className="btn btn-primary" href={ev.url} target="_blank" rel="noopener noreferrer">
                Open sign-in page
                <Icon name="external" size={14} />
              </a>
            )}
            <span className="muted small">Only enter this code if you just started a sign-in from Pod Cave.</span>
          </div>
        )}
        {bad && (
          <div className="signal-actions">
            {azure && (
              <>
                <button className="btn btn-primary" disabled={busy} onClick={() => login('az-browser')}>
                  Sign in with browser
                </button>
                <button className="btn" disabled={busy} onClick={() => login('az-devicecode')}>
                  Use device code
                </button>
              </>
            )}
            <button className={cx('btn', !azure && 'btn-primary')} disabled={busy} onClick={() => login('retry')}>
              <Icon name="refresh" size={14} />
              {azure ? 'Retry' : 'Sign in again'}
            </button>
          </div>
        )}
        {err && <div className="signal-err">{err}</div>}
      </div>
      <button className="btn btn-ghost btn-sm btn-icon signal-close" onClick={onDismiss} title="Dismiss">
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}
