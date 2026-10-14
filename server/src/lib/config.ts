/**
 * Configuration from the environment. Every value has a development default that matches compose.yaml, so tests and
 * the dev stack need nothing set; production sets UCAP_PUBLIC_URL and UCAP_ALLOWED_ORIGINS.
 */
export type Role = 'core' | 'assistant';

export interface Config {
  role: Role;
  /** NODE_ENV=production: no development origins, no lists under review. */
  production: boolean;
  port: number;
  databaseUrl: string;
  /** The address apps and herde workers use, e.g. https://ucap.example; Caddy in front. */
  publicUrl: string;
  /** Origins allowed for CORS and the WebSocket upgrade: the Capacitor app (https://localhost), the dev server, ourselves. */
  allowedOrigins: string[];
  /** The addresses apps use to reach this server; a signed statement must name one of them (its `org`). */
  publicOrigins: string[];
  filesDir: string;
  ntfyPublicUrl: string | null;
  ntfyInternalUrl: string | null;
  ollamaUrl: string | null;
  sttUrl: string | null;
  serverName: string;
  logLevel: string;
}

function list(value: string | undefined): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(role: Role, env: NodeJS.ProcessEnv = process.env): Config {
  const publicUrl = env.UCAP_PUBLIC_URL ?? 'http://localhost:8810';
  const origins = new Set([
    new URL(publicUrl).origin,
    'https://localhost', // the Capacitor app on Android (androidScheme https)
    'capacitor://localhost', // the Capacitor app on iOS, later
    ...(env.NODE_ENV === 'production' ? [] : ['http://localhost:8812']), // Vite and live reload in development
    ...list(env.UCAP_ALLOWED_ORIGINS),
  ]);
  const publicOrigins = new Set([
    new URL(publicUrl).origin,
    // In development the browser reaches the stack through Vite's proxy, and the emulator through adb reverse.
    ...(env.NODE_ENV === 'production' ? [] : ['http://localhost:8812', 'http://localhost:8810']),
    ...list(env.UCAP_PUBLIC_ORIGINS),
  ]);
  return {
    role,
    production: env.NODE_ENV === 'production',
    publicOrigins: [...publicOrigins],
    port: Number(env.PORT ?? (role === 'core' ? 8820 : 8821)),
    databaseUrl: env.DATABASE_URL ?? 'postgres://ucap:ucap@127.0.0.1:55440/ucap',
    publicUrl,
    allowedOrigins: [...origins],
    filesDir: env.UCAP_FILES_DIR ?? '/data/files',
    ntfyPublicUrl: env.NTFY_PUBLIC_URL ?? null,
    ntfyInternalUrl: env.NTFY_INTERNAL_URL ?? null,
    ollamaUrl: env.OLLAMA_URL ?? null,
    sttUrl: env.STT_URL ?? null,
    serverName: env.UCAP_SERVER_NAME ?? 'UCAP',
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}
