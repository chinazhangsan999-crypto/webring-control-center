'use strict';

const crypto = require('node:crypto');
const { query, transaction } = require('../db');
const PlatformSettingsService = require('./platformSettingsService');
const { normalizeLines } = PlatformSettingsService;

const PLATFORMS = ['cloudflare', 'github', 'npm', 'notion'];
const MODES = new Set(['disabled', 'global', 'site']);
const SECRET_BY_PLATFORM = {
  github: 'github_token',
  cloudflare: 'cloudflare_token',
  notion: 'notion_token'
};

function text(value, max = 300) { return String(value || '').trim().slice(0, max); }
function secretHint(value) { const source = text(value, 4000); return source ? `••••••${source.slice(-6)}` : ''; }
function normalizeMode(value) { return MODES.has(value) ? value : 'disabled'; }

function normalizePlatformSettings(platform, value = {}) {
  if (platform === 'github') return {
    username: text(value.username, 120),
    branch: text(value.branch || 'gh-pages', 80) || 'gh-pages',
    workflow_file: text(value.workflow_file || 'publish-npm.yml', 120) || 'publish-npm.yml'
  };
  if (platform === 'cloudflare') return {
    account_id: text(value.account_id, 160),
    branch: text(value.branch || 'main', 80) || 'main'
  };
  if (platform === 'npm') {
    const lines = normalizeLines(value.lines);
    const pageLines = lines.filter(item => item === 'unpkg' || item === 'esm');
    const requested = text(value.primary, 30);
    return {
      username: text(value.username, 120),
      registry: 'https://registry.npmjs.org',
      lines,
      primary: pageLines.includes(requested) ? requested : (pageLines[0] || '')
    };
  }
  if (platform === 'notion') return { workspace_label: text(value.workspace_label, 120) };
  return {};
}

async function ensureSite(siteId, client = null) {
  const executor = client || { query };
  for (const platform of PLATFORMS) {
    await executor.query(`INSERT INTO site_publish_platforms(site_id,platform,account_mode)
      VALUES($1,$2,'disabled') ON CONFLICT(site_id,platform) DO NOTHING`, [siteId, platform]);
  }
}

async function rowsForSite(siteId, client = null) {
  const executor = client || { query };
  return (await executor.query(`SELECT p.platform,p.account_mode,p.settings,p.config_version,p.updated_at,
    s.hint,s.credential_version
    FROM site_publish_platforms p
    LEFT JOIN site_publish_secrets s ON s.site_id=p.site_id AND s.platform=p.platform
    WHERE p.site_id=$1 ORDER BY p.platform`, [siteId])).rows;
}

async function safeSettings(siteId) {
  const rows = await rowsForSite(siteId);
  return Object.fromEntries(PLATFORMS.map(platform => {
    const row = rows.find(item => item.platform === platform) || {};
    return [platform, {
      mode: normalizeMode(row.account_mode),
      settings: normalizePlatformSettings(platform, row.settings || {}),
      config_version: Number(row.config_version || 1),
      credential: { configured: Boolean(row.hint), hint: row.hint || '', version: Number(row.credential_version || 0) }
    }];
  }));
}

async function save(siteId, payload = {}, existingClient = null) {
  const run = async client => {
    await ensureSite(siteId, client);
    const currentRows = await rowsForSite(siteId, client);
    for (const platform of PLATFORMS) {
      if (!Object.prototype.hasOwnProperty.call(payload, platform)) continue;
      const current = currentRows.find(item => item.platform === platform) || {};
      const requested = payload[platform] || {};
      const mode = requested.mode === undefined ? normalizeMode(current.account_mode) : normalizeMode(requested.mode);
      const settings = normalizePlatformSettings(platform, requested.settings || current.settings || {});
      const changed = mode !== normalizeMode(current.account_mode)
        || JSON.stringify(settings) !== JSON.stringify(normalizePlatformSettings(platform, current.settings || {}));
      await client.query(`UPDATE site_publish_platforms SET account_mode=$3,settings=$4::jsonb,
        config_version=config_version+$5,updated_at=NOW() WHERE site_id=$1 AND platform=$2`,
      [siteId, platform, mode, JSON.stringify(settings), changed ? 1 : 0]);

      const secretName = SECRET_BY_PLATFORM[platform];
      if (!secretName || requested.secret === undefined) continue;
      if (requested.secret === null) {
        await client.query('DELETE FROM site_publish_secrets WHERE site_id=$1 AND platform=$2', [siteId, platform]);
        continue;
      }
      const plain = text(requested.secret, 4000);
      if (!plain) continue;
      await client.query(`INSERT INTO site_publish_secrets(site_id,platform,secret_name,encrypted_value,hint,credential_version,updated_at)
        VALUES($1,$2,$3,$4::jsonb,$5,1,NOW())
        ON CONFLICT(site_id,platform,secret_name) DO UPDATE SET encrypted_value=EXCLUDED.encrypted_value,
        hint=EXCLUDED.hint,credential_version=site_publish_secrets.credential_version+1,updated_at=NOW()`,
      [siteId, platform, secretName, JSON.stringify(PlatformSettingsService.encrypt(plain)), secretHint(plain)]);
    }
  };
  if (existingClient) {
    await run(existingClient);
    return null;
  }
  await transaction(run);
  return safeSettings(siteId);
}

async function resolveSiteAccount(siteId, platform) {
  if (!PLATFORMS.includes(platform)) throw new Error('未知发布平台');
  const row = (await rowsForSite(siteId)).find(item => item.platform === platform);
  const settings = normalizePlatformSettings(platform, row?.settings || {});
  const secretName = SECRET_BY_PLATFORM[platform];
  let token = '';
  if (secretName) {
    const secretRow = (await query(`SELECT encrypted_value FROM site_publish_secrets
      WHERE site_id=$1 AND platform=$2 AND secret_name=$3`, [siteId, platform, secretName])).rows[0];
    token = PlatformSettingsService.decrypt(secretRow?.encrypted_value);
    assertConfigured(token, `请先填写 ${platform} 本站独立账号凭据`);
  }
  if (platform === 'cloudflare') assertConfigured(settings.account_id, '请填写 Cloudflare 本站独立 Account ID');
  return { enabled: true, source: 'site', settings, credentials: token ? { token } : {} };
}

function assertConfigured(condition, message) {
  if (!condition) {
    const error = new Error(message);
    error.retryable = false;
    throw error;
  }
}

async function resolveForDeployment(siteId, onlyPlatform = '') {
  const [rows, global] = await Promise.all([rowsForSite(siteId), PlatformSettingsService.runtimeSettings()]);
  const result = { platforms: {}, bindings: {} };
  for (const platform of PLATFORMS) {
    const row = rows.find(item => item.platform === platform);
    const mode = normalizeMode(row?.account_mode);
    const localSettings = normalizePlatformSettings(platform, row?.settings || {});
    const binding = { mode, config_version: Number(row?.config_version || 1), source: mode };
    result.bindings[platform] = binding;
    if (mode === 'disabled') {
      result.platforms[platform] = { enabled: false, source: 'disabled', settings: localSettings, credentials: {} };
      continue;
    }
    if (onlyPlatform && platform !== onlyPlatform) {
      result.platforms[platform] = { enabled: true, source: mode, settings: localSettings, credentials: {} };
      continue;
    }
    if (mode === 'global') {
      binding.config_key = crypto.createHash('sha256').update(JSON.stringify(normalizePlatformSettings(platform, global[platform] || {}))).digest('hex').slice(0, 16);
      assertConfigured(global[platform]?.enabled, `请先启用 ${platform} 全局平台设置`);
      if (platform === 'github') {
        assertConfigured(global.secrets.github_token, '请先填写 GitHub 全局 Token');
        assertConfigured(global.github.username, '请先填写 GitHub 全局用户名或组织名');
      }
      if (platform === 'cloudflare') {
        assertConfigured(global.secrets.cloudflare_token, '请先填写 Cloudflare 全局 Token');
        assertConfigured(global.cloudflare.account_id, '请先填写 Cloudflare 全局 Account ID');
      }
      if (platform === 'notion') assertConfigured(global.secrets.notion_token, '请先填写 Notion 全局 Integration Token');
      result.platforms[platform] = {
        enabled: true,
        source: 'global',
        settings: normalizePlatformSettings(platform, global[platform] || {}),
        credentials: platform === 'github' ? { token: global.secrets.github_token }
          : platform === 'cloudflare' ? { token: global.secrets.cloudflare_token }
            : platform === 'notion' ? { token: global.secrets.notion_token } : {}
      };
      continue;
    }
    const secretName = SECRET_BY_PLATFORM[platform];
    let secret = '';
    if (secretName) {
      const secretRow = (await query(`SELECT encrypted_value FROM site_publish_secrets
        WHERE site_id=$1 AND platform=$2 AND secret_name=$3`, [siteId, platform, secretName])).rows[0];
      secret = PlatformSettingsService.decrypt(secretRow?.encrypted_value);
      assertConfigured(secret, `请填写 ${platform} 本站独立账号凭据`);
    }
    if (platform === 'github') assertConfigured(localSettings.username, '请填写 GitHub 本站独立用户名或组织名');
    if (platform === 'cloudflare') assertConfigured(localSettings.account_id, '请填写 Cloudflare 本站独立 Account ID');
    result.platforms[platform] = { enabled: true, source: 'site', settings: localSettings, credentials: secret ? { token: secret } : {} };
  }
  return result;
}

function bindingsMatch(expected = {}, current = {}) {
  return PLATFORMS.every(platform => expected[platform]
    && expected[platform].mode === current[platform]?.mode
    && Number(expected[platform].config_version) === Number(current[platform]?.config_version)
    && String(expected[platform].config_key || '') === String(current[platform]?.config_key || ''));
}

module.exports = { PLATFORMS, MODES, normalizeMode, normalizePlatformSettings, ensureSite, safeSettings, save, resolveSiteAccount, resolveForDeployment, bindingsMatch };
