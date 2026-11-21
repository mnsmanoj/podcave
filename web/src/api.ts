// API client. The session token lives only in this tab's sessionStorage and is
// sent as a bearer header: no cookies, so nothing ambient for other sites to abuse.
const SESSION_KEY = 'podcave.session';
let sessionLost: (() => void) | null = null;

export function onSessionLost(fn: () => void) {
  sessionLost = fn;
}

function session(): string {
  return sessionStorage.getItem(SESSION_KEY) ?? '';
}

export async function bootstrap(): Promise<boolean> {
  const m = /[#&]launch=([A-Za-z0-9_-]{20,})/.exec(location.hash);
  if (m) {
    // Remove the token from the address bar and history immediately.
    history.replaceState(null, '', location.pathname + location.search);
    try {
      const r = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ launch: m[1] }),
        cache: 'no-store',
      });
      if (r.ok) {
        const j = (await r.json()) as { session: string };
        sessionStorage.setItem(SESSION_KEY, j.session);
        return true;
      }
    } catch {
      /* fall through */
    }
  }
  if (!session()) return false;
  try {
    await api('/api/state');
    return true;
  } catch {
    return false;
  }
}

export class ApiError extends Error {
  status: number;
  code?: string;
  clusterAuth?: boolean;
  constructor(message: string, status: number, code?: string, clusterAuth?: boolean) {
    super(message);
    this.status = status;
    this.code = code;
    this.clusterAuth = clusterAuth;
  }
}

async function check(r: Response) {
  if (r.ok) return;
  let body: { error?: string; code?: string; clusterAuth?: boolean } = {};
  try {
    body = await r.json();
  } catch {
    /* not json */
  }
  if (r.status === 401 && body.code === 'session') {
    sessionStorage.removeItem(SESSION_KEY);
    sessionLost?.();
  }
  throw new ApiError(body.error || r.statusText || 'request failed', r.status, body.code, body.clusterAuth);
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const hasBody = method !== 'GET';
  const r = await fetch(path, {
    method,
    headers: {
      Authorization: 'Bearer ' + session(),
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    },
    body: hasBody ? JSON.stringify(opts.body ?? {}) : undefined,
    cache: 'no-store',
  });
  await check(r);
  if (r.status === 204) return undefined as T;
  return (await r.json()) as T;
}

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  }
  return p.toString();
}

// Reads an NDJSON stream. Resolves when the server ends it; a watchdog aborts
// if nothing (not even a ping) arrives for 60s so callers can reconnect.
export async function stream(path: string, onEvent: (e: any) => void, signal: AbortSignal): Promise<void> {
  const inner = new AbortController();
  const both = AbortSignal.any([signal, inner.signal]);
  let watchdog = setTimeout(() => inner.abort(), 60_000);
  const kick = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => inner.abort(), 60_000);
  };
  try {
    const r = await fetch(path, { headers: { Authorization: 'Bearer ' + session() }, signal: both, cache: 'no-store' });
    await check(r);
    if (!r.body) return;
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      kick();
      buf += value;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type !== 'ping') onEvent(ev);
      }
    }
  } catch (e) {
    if (signal.aborted) return;
    if (inner.signal.aborted) return; // watchdog: treat as a normal end so caller reconnects
    throw e;
  } finally {
    clearTimeout(watchdog);
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}
