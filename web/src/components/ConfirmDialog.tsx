import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cx, errMsg } from '../util';

interface Props {
  title: string;
  children?: ReactNode;
  confirmText: string;
  /** If set, the user must type this exact value to enable the confirm button. */
  typeToConfirm?: string;
  danger?: boolean;
  replicas?: number;
  onConfirm: (replicas?: number) => Promise<void>;
  onClose: () => void;
}

export function ConfirmDialog({ title, children, confirmText, typeToConfirm, danger, replicas, onConfirm, onClose }: Props) {
  const [typed, setTyped] = useState('');
  const [rep, setRep] = useState(replicas ?? 0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  const ok = (!typeToConfirm || typed === typeToConfirm) && (replicas === undefined || (Number.isInteger(rep) && rep >= 0 && rep <= 500));

  const go = async () => {
    if (!ok || busy) return;
    setBusy(true);
    setErr('');
    try {
      await onConfirm(replicas === undefined ? undefined : rep);
      onClose();
    } catch (e) {
      setErr(errMsg(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('modal', danger && 'danger')} role="dialog" aria-modal="true">
        <h3>{title}</h3>
        <div className="modal-body">{children}</div>
        {replicas !== undefined && (
          <label className="field">
            <span>Replicas</span>
            <input type="number" min={0} max={500} value={rep} onChange={(e) => setRep(Number(e.target.value))} />
          </label>
        )}
        {typeToConfirm && (
          <label className="field">
            <span>
              Type <b className="mono">{typeToConfirm}</b> to confirm
            </span>
            <input ref={input} value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} spellCheck={false} autoComplete="off" />
          </label>
        )}
        {err && <div className="panel-error">{err}</div>}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className={cx('btn', danger ? 'danger' : 'primary')} disabled={!ok || busy} onClick={go}>
            {busy ? 'Working…' : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
