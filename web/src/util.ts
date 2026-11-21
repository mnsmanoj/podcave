export function age(iso: string | undefined): string {
  if (!iso) return '-';
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? `${m % 60}m` : ''}`;
  const d = Math.floor(h / 24);
  if (d < 365) return `${d}d`;
  return `${Math.floor(d / 365)}y${d % 365}d`;
}

export type Tone = 'ok' | 'warn' | 'bad' | 'muted' | 'info';

export function podTone(status: string): Tone {
  if (status === 'Running') return 'ok';
  if (status === 'Completed' || status === 'Succeeded') return 'muted';
  if (status === 'Terminating') return 'warn';
  if (/^(Pending|ContainerCreating|PodInitializing|Init:\d)/.test(status)) return 'info';
  if (/Unknown/.test(status)) return 'muted';
  return 'bad';
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Builds a global search regex; returns null for empty query, Error for invalid regex. */
export function buildMatcher(query: string, regex: boolean, caseSensitive: boolean): RegExp | null | Error {
  if (!query) return null;
  try {
    return new RegExp(regex ? query : escapeRegExp(query), caseSensitive ? 'g' : 'gi');
  } catch (e) {
    return e as Error;
  }
}

export function formatTs(raw: string): string {
  // Kubernetes timestamps are RFC3339Nano; trim to ms for Date parsing.
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?(Z|[+-]\d\d:\d\d)$/.exec(raw);
  if (!m) return raw;
  const d = new Date(m[1] + (m[2] ? m[2].slice(0, 4) : '') + m[3]);
  if (isNaN(d.getTime())) return raw;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
