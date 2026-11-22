import { useMemo, useRef, useState } from 'react';
import { useOutsideClick } from '../hooks';
import type { SelPod } from '../types';
import { Icon } from './Icons';

export const MAX_SELECTED = 10;
export const selKey = (ctxId: string, ns: string, pod: string) => `${ctxId}|${ns}|${pod}`;

interface Props {
  selection: SelPod[];
  nameOf: (ctxId: string) => string;
  onRemove: (p: SelPod) => void;
  onClear: () => void;
  onView: () => void;
}

/** Floating bar listing the pods picked for a merged log view. */
export function SelectionBar({ selection, nameOf, onRemove, onClear, onView }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClick(ref, () => setOpen(false), open);

  const groups = useMemo(() => {
    const m = new Map<string, SelPod[]>();
    for (const p of selection) {
      const k = `${nameOf(p.ctxId)} / ${p.ns}`;
      m.set(k, [...(m.get(k) ?? []), p]);
    }
    return [...m.entries()];
  }, [selection, nameOf]);

  if (selection.length === 0) return null;
  const clusters = new Set(selection.map((p) => p.ctxId)).size;
  const namespaces = new Set(selection.map((p) => p.ctxId + '|' + p.ns)).size;
  const where = clusters > 1 ? `${clusters} clusters` : namespaces > 1 ? `${namespaces} namespaces` : groups[0][0];

  return (
    <div className="selbar" ref={ref}>
      {open && (
        <div className="selbar-list">
          {groups.map(([g, pods]) => (
            <div key={g}>
              <div className="selbar-group">{g}</div>
              {pods.map((p) => (
                <div key={p.pod} className="selbar-item">
                  <span className="mono ellipsis">{p.pod}</span>
                  <button className="btn btn-ghost btn-sm btn-icon" onClick={() => onRemove(p)} title="Remove from selection">
                    <Icon name="x" size={13} />
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="selbar-main">
        <button className="selbar-count" onClick={() => setOpen(!open)} title="Show the selected pods">
          <b>{selection.length}</b> {selection.length === 1 ? 'pod' : 'pods'} selected
          <span className="muted">{where}</span>
          <Icon name={open ? 'chevronDown' : 'chevronUp'} size={14} />
        </button>
        <button className="btn btn-sm btn-ghost" onClick={onClear}>
          Clear
        </button>
        <button className="btn btn-sm btn-primary" onClick={onView}>
          View logs
        </button>
      </div>
    </div>
  );
}
