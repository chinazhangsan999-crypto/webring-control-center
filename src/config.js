'use strict';

function integerEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} 配置不合法`);
  }
  return value;
}

const NODE_ENV = process.env.NODE_ENV || 'development';
const PORT = integerEnv('PORT', 3100, { max: 65535 });
const HOST = String(process.env.HOST || '0.0.0.0').trim();
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const DATABASE_SSL = process.env.DATABASE_SSL === '1';
const SESSION_COOKIE_NAME = String(process.env.SESSION_COOKIE_NAME || 'cc_session');
const SESSION_TTL_HOURS = integerEnv('SESSION_TTL_HOURS', 8, { max: 168 });
const SSO_TICKET_TTL_SECONDS = integerEnv('SSO_TICKET_TTL_SECONDS', 60, { min: 30, max: 300 });
const CONTROL_CENTER_PUBLIC_URL = String(process.env.CONTROL_CENTER_PUBLIC_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const INITIAL_ADMIN_USERNAME = String(process.env.INITIAL_ADMIN_USERNAME || 'admin').trim();
const INITIAL_ADMIN_PASSWORD = String(process.env.INITIAL_ADMIN_PASSWORD || '');
const TRUST_PROXY = String(process.env.TRUST_PROXY || 'loopback').trim();
const SETTINGS_ENCRYPTION_KEY = String(process.env.SETTINGS_ENCRYPTION_KEY || '').trim();

if (!DATABASE_URL) throw new Error('缺少 DATABASE_URL');
if (NODE_ENV === 'production' && INITIAL_ADMIN_PASSWORD && INITIAL_ADMIN_PASSWORD.length < 8) {
  throw new Error('生产环境 INITIAL_ADMIN_PASSWORD 至少需要 8 位');
}

module.exports = {
  NODE_ENV,
  PORT,
  HOST,
  DATABASE_URL,
  DATABASE_SSL,
  SESSION_COOKIE_NAME,
  SESSION_TTL_HOURS,
  SSO_TICKET_TTL_SECONDS,
  CONTROL_CENTER_PUBLIC_URL,
  INITIAL_ADMIN_USERNAME,
  INITIAL_ADMIN_PASSWORD,
  TRUST_PROXY,
  SETTINGS_ENCRYPTION_KEY
};
