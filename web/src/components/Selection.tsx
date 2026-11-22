import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useOutsideClick } from '../hooks';
import { Icon } from './Icons';

export const MAX_SELECTED = 10;
export const MAX_SELECTED_DEPLOYMENTS = 50;
export const selKey = (ctxId: string, ns: string, name: string) => `${ctxId}|${ns}|${name}`;

export interface SelItem {
  ctxId: string;
  ns: string;
  name: string;
  note?: string;
}

interface Props {
  items: SelItem[];
  noun: [string, string];
  nameOf: (ctxId: string) => string;
  onRemove: (item: SelItem) => void;
  onClear: () => void;
  children: ReactNode;
}

/** Floating bar listing selected pods or deployments, with bulk actions. */
export function SelectionBar({ items, noun, nameOf, onRemove, onClear, children }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClick(ref, () => setOpen(false), open);

  const groups = useMemo(() => {
    const m = new Map<string, SelItem[]>();
    for (const p of items) {
      const k = `${nameOf(p.ctxId)} / ${p.ns}`;
      m.set(k, [...(m.get(k) ?? []), p]);
    }
    return [...m.entries()];
  }, [items, nameOf]);

  if (items.length === 0) return null;
  const clusters = new Set(items.map((p) => p.ctxId)).size;
  const namespaces = new Set(items.map((p) => p.ctxId + '|' + p.ns)).size;
  const where = clusters > 1 ? `${clusters} clusters` : namespaces > 1 ? `${namespaces} namespaces` : groups[0][0];

  return (
    <div className="selbar" ref={ref}>
      {open && (
        <div className="selbar-list">
          {groups.map(([g, list]) => (
            <div key={g}>
              <div className="selbar-group">{g}</div>
              {list.map((p) => (
                <div key={p.name} className="selbar-item">
                  <span className="mono ellipsis">{p.name}</span>
                  {p.note && <span className="muted small">{p.note}</span>}
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
        <button className="selbar-count" onClick={() => setOpen(!open)} title={`Show the selected ${noun[1]}`}>
          <b>{items.length}</b> {items.length === 1 ? noun[0] : noun[1]} selected
          <span className="muted">{where}</span>
          <Icon name={open ? 'chevronDown' : 'chevronUp'} size={14} />
        </button>
        <button className="btn btn-sm btn-ghost" onClick={onClear}>
          Clear
        </button>
        {children}
      </div>
    </div>
  );
}
