import type { ThemePref } from './types';

const KEY = 'podcave.theme';
const media = () => window.matchMedia('(prefers-color-scheme: light)');

export function storedTheme(): ThemePref {
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}

export function resolveTheme(pref: ThemePref): 'light' | 'dark' {
  if (pref === 'system') return media().matches ? 'light' : 'dark';
  return pref;
}

export function applyTheme(pref: ThemePref) {
  localStorage.setItem(KEY, pref);
  document.documentElement.dataset.theme = resolveTheme(pref);
}

/** Re-applies the theme when Windows switches between light and dark. */
export function watchSystemTheme(getPref: () => ThemePref): () => void {
  const m = media();
  const h = () => {
    if (getPref() === 'system') applyTheme('system');
  };
  m.addEventListener('change', h);
  return () => m.removeEventListener('change', h);
}
