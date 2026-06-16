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

export interface Config {
  port: number;
  host: string;
  corsOrigins: string[];
  vapid: {
    publicKey: string;
    privateKey: string;
    subject: string;
  };
  databasePath: string;
  adminApiKey: string;
  appKeys: Record<string, string>;
  maxFailures: number;
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
    databasePath: optional('DATABASE_PATH', './data/push.sqlite'),
    adminApiKey: required('ADMIN_API_KEY'),
    appKeys: parseAppKeys(optional('APP_KEYS', '')),
    maxFailures: Number(optional('MAX_FAILURES', '5')),
  };
}
