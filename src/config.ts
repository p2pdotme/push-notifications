import 'dotenv/config';

/**
 * Centralised, validated runtime configuration. Fails fast on misconfiguration
 * so the service never starts in a half-broken state.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : fallback;
}

/** First non-empty value among the given env var names, else fallback. */
function firstEnv(names: string[], fallback: string): string {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim() !== '') return value.trim();
  }
  return fallback;
}

/** Like `required`, but accepts the first of several candidate env names. */
function required2(names: string[]): string {
  const value = firstEnv(names, '');
  if (!value) {
    throw new Error(`Missing required environment variable (one of): ${names.join(', ')}`);
  }
  return value;
}

function parseAppKeys(raw: string): Record<string, string> {
  if (!raw || raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('APP_KEYS must be valid JSON, e.g. {"user-app":"secret"}');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('APP_KEYS must be a JSON object mapping appId -> key');
  }
  const out: Record<string, string> = {};
  for (const [appId, key] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof key !== 'string' || key.trim() === '') {
      throw new Error(`APP_KEYS entry "${appId}" must map to a non-empty string`);
    }
    out[appId] = key;
  }
  return out;
}

/** Split a comma-separated env value into a trimmed, non-empty list. */
export function parseList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface Config {
  port: number;
  host: string;
  corsOrigins: string[];
  vapid: {
    publicKey: string;
    privateKey: string;
    subject: string;
  };
  databaseUrl: string;
  adminApiKey: string;
  appKeys: Record<string, string>;
  maxFailures: number;
  adminWallets: string[];
  dashboardOrigin: string;
  authDomain: string;
  jwtSecret: string;
  sendConcurrency: number;
  logRetentionDays: number;
}

export function loadConfig(): Config {
  const corsRaw = optional('CORS_ORIGINS', '*');
  return {
    port: Number(optional('PORT', '4000')),
    host: optional('HOST', '0.0.0.0'),
    corsOrigins: corsRaw === '*' ? ['*'] : corsRaw.split(',').map((s) => s.trim()),
    vapid: {
      publicKey: required('VAPID_PUBLIC_KEY'),
      privateKey: required('VAPID_PRIVATE_KEY'),
      subject: optional('VAPID_SUBJECT', 'mailto:dev@p2p.me'),
    },
    databaseUrl: required('DATABASE_URL'),
    adminApiKey: required('ADMIN_API_KEY'),
    appKeys: parseAppKeys(optional('APP_KEYS', '')),
    maxFailures: Number(optional('MAX_FAILURES', '5')),
    adminWallets: parseList(optional('ADMIN_WALLETS', '')).map((a) => a.toLowerCase()),
    dashboardOrigin: optional('DASHBOARD_ORIGIN', ''),
    authDomain: required2(['AUTH_DOMAIN', 'THIRDWEB_AUTH_DOMAIN']),
    jwtSecret: required2(['AUTH_JWT_SECRET', 'THIRDWEB_AUTH_PRIVATE_KEY']),
    sendConcurrency: Number(optional('SEND_CONCURRENCY', '25')),
    logRetentionDays: Number(optional('LOG_RETENTION_DAYS', '0')),
  };
}
