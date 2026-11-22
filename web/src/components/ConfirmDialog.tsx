import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cx, errMsg } from '../util';
import { Icon } from './Icons';

/** One deployment in a bulk scale, with an optional count of its own. */
export interface ScaleRow {
  key: string;
  name: string;
  where: string;
  current: number;
}

interface Props {
  title: string;
  children?: ReactNode;
  confirmText: string;
  /** The user must type "yes" (any case) to enable the confirm button. */
  requireYes?: boolean;
  danger?: boolean;
  replicas?: number;
  replicasLabel?: string;
  /** Bulk scale: deployments listed with a box each that overrides the overall count. */
  scaleRows?: ScaleRow[];
  /** `counts` has the final replica count per scale row key. */
  onConfirm: (replicas?: number, counts?: Record<string, number>) => Promise<void>;
  onClose: () => void;
}

/** Above this many replicas the dialog reminds you to check cluster capacity. */
const MANY_REPLICAS = 5;

const validCount = (n: number) => Number.isInteger(n) && n >= 0 && n <= 500;

export function ConfirmDialog({ title, children, confirmText, requireYes, danger, replicas, replicasLabel, scaleRows, onConfirm, onClose }: Props) {
  const [typed, setTyped] = useState('');
  const [rep, setRep] = useState(replicas ?? 0);
  const [own, setOwn] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const primary = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    (input.current ?? primary.current)?.focus();
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  // Final count per row: its own box if filled in, otherwise the overall count.
  const rows = (scaleRows ?? []).map((r) => {
    const raw = own[r.key]?.trim() ?? '';
    const n = raw === '' ? rep : Number(raw);
    return { ...r, raw, n, bad: raw !== '' && !validCount(n) };
  });
  const rowsOk = rows.every((r) => !r.bad);
  const usesOverall = rows.length === 0 || rows.some((r) => r.raw === '');

  const ok =
    (!requireYes || typed.trim().toLowerCase() === 'yes') &&
    (replicas === undefined || !usesOverall || validCount(rep)) &&
    rowsOk;

  // Remind about capacity when something goes above 5 and above what it runs now.
  let warn = '';
  if (replicas !== undefined && rowsOk && (!usesOverall || validCount(rep))) {
    if (rows.length > 0) {
      const big = rows.filter((r) => r.n > Math.max(MANY_REPLICAS, r.current));
      if (big.length) {
        const total = rows.reduce((s, r) => s + r.n, 0);
        warn = `That is ${total} pods in total, up to ${Math.max(...big.map((r) => r.n))} for one deployment.`;
      }
    } else if (rep > Math.max(MANY_REPLICAS, replicas)) {
      warn = `That is ${rep} pods.`;
    }
  }

  const go = async () => {
    if (!ok || busy) return;
    setBusy(true);
    setErr('');
    try {
      const counts = rows.length ? Object.fromEntries(rows.map((r) => [r.key, r.n])) : undefined;
      await onConfirm(replicas === undefined ? undefined : rep, counts);
      onClose();
    } catch (e) {
      setErr(errMsg(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('modal', rows.length > 0 && 'medium')} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div className="grow">
            <h3>{title}</h3>
          </div>
        </div>
        <div className="modal-body">
          {children}
          {rows.length > 0 && (
            <div className="scale-rows">
              <div className="scale-row scale-row-head">
                <span>Deployment</span>
                <span>Now</span>
                <span>Own count</span>
                <span>New</span>
              </div>
              {rows.map((r) => (
                <div className="scale-row" key={r.key}>
                  <span className="scale-row-name">
                    <span className="mono ellipsis">{r.name}</span>
                    <span className="muted small ellipsis">{r.where}</span>
                  </span>
                  <span className="mono small muted">{r.current}</span>
                  <input
                    className={cx('input input-sm mono', r.bad && 'invalid')}
                    type="number"
                    min={0}
                    max={500}
                    value={own[r.key] ?? ''}
                    placeholder={validCount(rep) ? String(rep) : ''}
                    onChange={(e) => setOwn((o) => ({ ...o, [r.key]: e.target.value }))}
                    title="Leave empty to use the overall count below"
                    aria-label={`Replicas for ${r.name}`}
                  />
                  <span className={cx('mono small', r.raw !== '' && 'strong')}>{r.bad ? '?' : r.n}</span>
                </div>
              ))}
            </div>
          )}
          {replicas !== undefined && (
            <label className="field">
              <span className="field-label">{replicasLabel ?? 'Replicas'}</span>
              <input className="input mono" type="number" min={0} max={500} value={rep} onChange={(e) => setRep(Number(e.target.value))} />
              {rows.length > 0 && <span className="field-hint">Used by every deployment whose own box is empty.</span>}
            </label>
          )}
          {warn && (
            <p className="field-warn" role="status">
              <Icon name="alert" size={14} />
              <span>
                {warn} Are you sure? Make sure the cluster has enough CPU and memory for them, otherwise the extra pods will wait in Pending.
              </span>
            </p>
          )}
          {requireYes && (
            <label className="field">
              <span className="field-label">
                Type <span className="mono">yes</span> to confirm
              </span>
              <input
                ref={input}
                className="input mono"
                value={typed}
                placeholder="yes"
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && go()}
                spellCheck={false}
                autoComplete="off"
              />
            </label>
          )}
          {err && <div className="panel-error" style={{ margin: '12px 0 0' }}>{err}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button ref={primary} className={cx('btn', danger ? 'btn-danger solid' : 'btn-primary')} disabled={!ok || busy} onClick={go}>
            {busy && <span className="spinner" />}
            {busy ? 'Working' : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
