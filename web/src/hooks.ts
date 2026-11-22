import { useEffect, useRef, useState, type RefObject } from 'react';
import { ApiError, sleep, stream } from './api';
import type { StreamStatus } from './types';

/** Live list backed by a server watch stream (snapshot + upsert/delete). */
export function useWatch<T extends { name: string }>(path: string | null) {
  const [items, setItems] = useState<T[]>([]);
  const [status, setStatus] = useState<StreamStatus>({ state: 'connecting' });

  useEffect(() => {
    setItems([]);
    setStatus({ state: path ? 'connecting' : 'idle' });
    if (!path) return;
    const ac = new AbortController();
    const map = new Map<string, T>();
    let dirty = false;
    const flush = setInterval(() => {
      if (dirty) {
        dirty = false;
        setItems(Array.from(map.values()));
      }
    }, 150);

    (async () => {
      let delay = 1000;
      while (!ac.signal.aborted) {
        try {
          await stream(
            path,
            (e) => {
              switch (e.type) {
                case 'snapshot':
                  map.clear();
                  for (const it of (e.items ?? []) as T[]) map.set(it.name, it);
                  dirty = false;
                  setItems(Array.from(map.values()));
                  break;
                case 'upsert':
                  map.set(e.item.name, e.item as T);
                  dirty = true;
                  break;
                case 'delete':
                  map.delete(e.name);
                  dirty = true;
                  break;
                case 'status':
                  setStatus({ state: e.state, message: e.message });
                  if (e.state === 'live') delay = 1000;
                  break;
              }
            },
            ac.signal,
          );
        } catch (err) {
          if (ac.signal.aborted) return;
          if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
            setStatus({ state: 'error', message: err.message });
            return;
          }
        }
        if (ac.signal.aborted) return;
        setStatus({ state: 'reconnecting', message: 'Connection lost. Reconnecting.' });
        await sleep(delay, ac.signal);
        delay = Math.min(delay * 2, 15000);
      }
    })();

    return () => {
      ac.abort();
      clearInterval(flush);
    };
  }, [path]);

  return { items, status };
}

/** Re-renders every `ms` so relative ages stay fresh. */
export function useTick(ms: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

export function useOutsideClick(ref: RefObject<HTMLElement | null>, onOutside: () => void, active: boolean) {
  const cb = useRef(onOutside);
  cb.current = onOutside;
  useEffect(() => {
    if (!active) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) cb.current();
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [ref, active]);
}
