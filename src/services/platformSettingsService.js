'use strict';

const crypto = require('node:crypto');
const { one, transaction } = require('../db');
const { SETTINGS_ENCRYPTION_KEY } = require('../config');

const SECRET_NAMES = new Set(['github_token', 'cloudflare_token', 'telegram_token', 'bark_url']);
const DEFAULT_NPM_LINES = ['jsdelivr', 'unpkg'];

function text(value, max = 300) { return String(value || '').trim().slice(0, max); }
function bool(value, fallback) { return value === undefined ? fallback : value === true; }
function secretHint(value) { const source = text(value, 200); return source ? `••••••${source.slice(-6)}` : ''; }

function encryptionKey() {
  if (!SETTINGS_ENCRYPTION_KEY) return null;
  return crypto.createHash('sha256').update(SETTINGS_ENCRYPTION_KEY, 'utf8').digest();
}

function encrypt(value) {
  const key = encryptionKey();
  if (!key) throw new Error('服务器尚未配置 SETTINGS_ENCRYPTION_KEY，不能保存敏感凭据');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: data.toString('base64url') };
}

function decrypt(payload) {
  if (!payload?.data) return '';
  const key = encryptionKey();
  if (!key) return '';
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64url'), { authTagLength: 16 });
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64url')), decipher.final()]).toString('utf8');
  } catch { return ''; }
}

function normalizeLines(value, fallback = DEFAULT_NPM_LINES) {
  const allowed = new Set(['npmmirror', 'jsdelivr', 'unpkg', 'esm']);
  const lines = Array.isArray(value) ? value.map(item => text(item, 30)).filter(item => allowed.has(item)) : [];
  return [...new Set(lines.length ? lines : fallback)];
}

function defaults(env = process.env) {
  return {
    github: { enabled: true, username: '', branch: text(env.PUBLISH_GITHUB_BRANCH || 'gh-pages', 80) || 'gh-pages' },
    cloudflare: { enabled: true, account_id: text(env.PUBLISH_CLOUDFLARE_ACCOUNT_ID, 160), branch: text(env.PUBLISH_CLOUDFLARE_BRANCH || 'main', 80) || 'main' },
    npm: { enabled: true, username: '', registry: 'https://registry.npmjs.org', lines: DEFAULT_NPM_LINES, primary: 'jsdelivr' },
    alerts: { site_name: text(env.ALERT_SITE_NAME || '星环总控', 100) || '星环总控', telegram_enabled: Boolean(env.ALERT_TELEGRAM_BOT_TOKEN && env.ALERT_TELEGRAM_CHAT_ID), telegram_chat_id: text(env.ALERT_TELEGRAM_CHAT_ID, 100), bark_enabled: Boolean(env.ALERT_BARK_URL), timeout_ms: Number(env.ALERT_TIMEOUT_MS || 8000), retry_delay_ms: Number(env.ALERT_RETRY_DELAY_MS || 1500) }
  };
}

function normalizeSettings(input = {}, fallback = defaults()) {
  const github = input.github || {}, cloudflare = input.cloudflare || {}, npm = input.npm || {}, alerts = input.alerts || {};
  const lines = normalizeLines(npm.lines, fallback.npm.lines);
  const primary = lines.includes(text(npm.primary, 30)) ? text(npm.primary, 30) : (lines.includes(fallback.npm.primary) ? fallback.npm.primary : lines[0]);
  const integer = (value, safe) => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : safe;
  return {
    github: { enabled: bool(github.enabled, fallback.github.enabled), username: text(github.username, 120), branch: text(github.branch || fallback.github.branch, 80) || 'gh-pages' },
    cloudflare: { enabled: bool(cloudflare.enabled, fallback.cloudflare.enabled), account_id: text(cloudflare.account_id || fallback.cloudflare.account_id, 160), branch: text(cloudflare.branch || fallback.cloudflare.branch, 80) || 'main' },
    npm: { enabled: bool(npm.enabled, fallback.npm.enabled), username: text(npm.username, 120), registry: 'https://registry.npmjs.org', lines, primary },
    alerts: { site_name: text(alerts.site_name || fallback.alerts.site_name, 100) || '星环总控', telegram_enabled: bool(alerts.telegram_enabled, fallback.alerts.telegram_enabled), telegram_chat_id: text(alerts.telegram_chat_id || alerts.telegram?.chat_id || fallback.alerts.telegram_chat_id, 100), bark_enabled: bool(alerts.bark_enabled, fallback.alerts.bark_enabled), timeout_ms: Math.min(30000, Math.max(1000, integer(alerts.timeout_ms, fallback.alerts.timeout_ms))), retry_delay_ms: Math.min(10000, Math.max(0, integer(alerts.retry_delay_ms, fallback.alerts.retry_delay_ms))) }
  };
}

async function stored() { return one('SELECT settings FROM platform_settings WHERE singleton_key=TRUE'); }
async function safeSettings() {
  const fallback = defaults();
  const row = await stored();
  const settings = normalizeSettings(row?.settings || {}, fallback);
  const secrets = await transaction(async client => (await client.query('SELECT name,hint FROM platform_secrets ORDER BY name')).rows);
  const hints = Object.fromEntries(secrets.map(item => [item.name, item.hint]));
  return { ...settings, alerts: { ...settings.alerts, telegram: { chat_id: settings.alerts.telegram_chat_id } }, encryption_ready: Boolean(encryptionKey()), credentials: {
    github_token: { configured: Boolean(hints.github_token || process.env.PUBLISH_GITHUB_TOKEN), hint: hints.github_token || secretHint(process.env.PUBLISH_GITHUB_TOKEN) },
    cloudflare_token: { configured: Boolean(hints.cloudflare_token || process.env.PUBLISH_CLOUDFLARE_API_TOKEN), hint: hints.cloudflare_token || secretHint(process.env.PUBLISH_CLOUDFLARE_API_TOKEN) },
    telegram_token: { configured: Boolean(hints.telegram_token || process.env.ALERT_TELEGRAM_BOT_TOKEN), hint: hints.telegram_token || secretHint(process.env.ALERT_TELEGRAM_BOT_TOKEN) },
    bark_url: { configured: Boolean(hints.bark_url || process.env.ALERT_BARK_URL), hint: hints.bark_url || secretHint(process.env.ALERT_BARK_URL) }
  }};
}

async function decryptedSecrets() {
  const rows = await transaction(async client => (await client.query('SELECT name,encrypted_value FROM platform_secrets')).rows);
  const values = Object.fromEntries(rows.map(row => [row.name, decrypt(row.encrypted_value)]));
  return {
    github_token: values.github_token || text(process.env.PUBLISH_GITHUB_TOKEN),
    cloudflare_token: values.cloudflare_token || text(process.env.PUBLISH_CLOUDFLARE_API_TOKEN),
    telegram_token: values.telegram_token || text(process.env.ALERT_TELEGRAM_BOT_TOKEN),
    bark_url: values.bark_url || text(process.env.ALERT_BARK_URL)
  };
}

async function runtimeSettings() { const [safe, secrets] = await Promise.all([safeSettings(), decryptedSecrets()]); return { ...safe, secrets }; }

async function save(payload = {}) {
  const current = await safeSettings();
  const next = normalizeSettings(payload, current);
  const supplied = payload.secrets && typeof payload.secrets === 'object' ? payload.secrets : {};
  await transaction(async client => {
    await client.query(`INSERT INTO platform_settings(singleton_key,settings,updated_at) VALUES(TRUE,$1::jsonb,NOW()) ON CONFLICT(singleton_key) DO UPDATE SET settings=EXCLUDED.settings,updated_at=NOW()`, [JSON.stringify(next)]);
    for (const [name, value] of Object.entries(supplied)) {
      if (!SECRET_NAMES.has(name)) continue;
      if (value === null) { await client.query('DELETE FROM platform_secrets WHERE name=$1', [name]); continue; }
      const plain = text(value, 4000); if (!plain) continue;
      const encrypted = encrypt(plain);
      await client.query(`INSERT INTO platform_secrets(name,encrypted_value,hint,updated_at) VALUES($1,$2::jsonb,$3,NOW()) ON CONFLICT(name) DO UPDATE SET encrypted_value=EXCLUDED.encrypted_value,hint=EXCLUDED.hint,updated_at=NOW()`, [name, JSON.stringify(encrypted), secretHint(plain)]);
    }
  });
  return safeSettings();
}

async function deploymentCredentials() {
  const runtime = await runtimeSettings();
  return { githubToken: runtime.secrets.github_token, githubBranch: runtime.github.branch, cloudflareToken: runtime.secrets.cloudflare_token, cloudflareAccountId: runtime.cloudflare.account_id, cloudflareBranch: runtime.cloudflare.branch };
}

async function alertRuntimeConfig() {
  const runtime = await runtimeSettings();
  return { siteName: runtime.alerts.site_name, telegramToken: runtime.alerts.telegram_enabled ? runtime.secrets.telegram_token : '', telegramChatId: runtime.alerts.telegram_enabled ? runtime.alerts.telegram_chat_id : '', barkUrl: runtime.alerts.bark_enabled ? runtime.secrets.bark_url : '', timeoutMs: runtime.alerts.timeout_ms, retryDelayMs: runtime.alerts.retry_delay_ms };
}

module.exports = { DEFAULT_NPM_LINES, encrypt, decrypt, normalizeLines, normalizeSettings, safeSettings, runtimeSettings, save, deploymentCredentials, alertRuntimeConfig };
