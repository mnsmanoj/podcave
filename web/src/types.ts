export interface ContextInfo {
  id: string;
  name: string;
  sourceId: string;
  sourceName: string;
  cluster: string;
  server: string;
  user: string;
  namespace: string;
  authType: string;
  loginMode?: string;
  insecure?: boolean;
  current?: boolean;
}

export interface SourceStatus {
  id: string;
  name: string;
  kind: 'file' | 'imported';
  path?: string;
  addedAt: string;
  contexts: number;
  error?: string;
}

export interface Pod {
  name: string;
  namespace: string;
  status: string;
  phase: string;
  ready: string;
  restarts: number;
  created: string;
  node?: string;
  ip?: string;
  containers: string[];
  initContainers?: string[];
  ports?: { container: string; name?: string; port: number; protocol: string }[];
  owner?: { kind: string; name: string };
  labels?: Record<string, string>;
}

export interface Deployment {
  name: string;
  namespace: string;
  replicas: number;
  ready: number;
  upToDate: number;
  available: number;
  created: string;
  images: string[];
  selector: string;
  paused?: boolean;
  message?: string;
}

export type AuthState = 'ok' | 'pending' | 'device-code' | 'needs-login' | 'error';

export interface AuthEvent {
  type: 'auth';
  ctx: string;
  state: AuthState;
  message?: string;
  url?: string;
  code?: string;
  time: string;
}

export interface LogPrefs {
  timestamps?: boolean;
  wrap?: boolean;
  tail?: number;
}

export type ThemePref = 'system' | 'light' | 'dark';

export interface Prefs {
  lastContext?: string;
  lastNamespace?: Record<string, string>;
  extraNamespaces?: Record<string, string[]>;
  tab?: 'pods' | 'deployments';
  log?: LogPrefs;
  drawerWidth?: number;
  theme?: ThemePref;
  /** Optional suffix per context id, shown as "name - label". */
  contextLabels?: Record<string, string>;
}

export interface ContextPreview {
  name: string;
  cluster: string;
  server: string;
  namespace?: string;
}

export interface ForwardInfo {
  id: string;
  ctx: string;
  ctxName: string;
  namespace: string;
  pod: string;
  podPort: number;
  localPort: number;
  address: string;
  state: 'starting' | 'active' | 'failed';
  message?: string;
  started: string;
}

export interface StreamStatus {
  state: string;
  message?: string;
}

export type DrawerTarget =
  | { kind: 'pod'; name: string; tab: 'logs' | 'describe' | 'yaml'; snapshot?: Pod }
  | { kind: 'deployment'; name: string; tab: 'pods' | 'describe' | 'yaml' };
