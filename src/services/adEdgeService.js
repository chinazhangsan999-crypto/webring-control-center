'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { query, one, transaction } = require('../db');
const { CONTROL_CENTER_PUBLIC_URL } = require('../config');
const { encrypt, decrypt } = require('./platformSettingsService');
const { badRequest, notFound } = require('../lib/errors');

const CF_API = 'https://api.cloudflare.com/client/v4';
const WORKER_VERSION = '2.0.1';
const WORKER_COMPATIBILITY_DATE = '2024-12-01';

function text(value, max = 200) { return String(value || '').trim().slice(0, max); }
function hostname(value) {
  const result = text(value, 253).toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(result)) throw badRequest('广告 API 域名格式不正确');
  return result;
}
function workerName(value) {
  const result = text(value, 63).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(result)) throw badRequest('Worker 名称只能使用小写字母、数字和连字符');
  return result;
}
function secretHint(value) { return value ? `••••••${String(value).slice(-6)}` : ''; }
function fingerprint(value) { return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16); }
function deriveSiteTicketKey(secret, siteId) { return crypto.createHmac('sha256', secret).update(`site:${siteId}`).digest('base64url'); }
function timingSafeText(left, right) {
  const a = Buffer.from(String(left || '')); const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function cfRequest(token, route, options = {}) {
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json', ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData)) headers['content-type'] = 'application/json';
  const response = await fetch(`${CF_API}${route}`, { ...options, headers, body: options.body instanceof FormData ? options.body : (options.body ? JSON.stringify(options.body) : undefined), signal: AbortSignal.timeout(30000) });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.success === false) throw new Error(data?.errors?.[0]?.message || `Cloudflare API HTTP ${response.status}`);
  return data?.result;
}

async function zoneForHostname(accountId, token, host) {
  const zones = await cfRequest(token, `/zones?account.id=${encodeURIComponent(accountId)}&status=active&per_page=50`);
  const matches = (Array.isArray(zones) ? zones : []).filter(zone => host === zone.name || host.endsWith(`.${zone.name}`)).sort((a, b) => b.name.length - a.name.length);
  if (!matches.length) throw badRequest('该 Cloudflare 账号中没有找到广告 API 域名所属的 Active Zone');
  return matches[0];
}

function safeProfile(row) {
  return {
    id: row.id, name: row.name, hostname: row.hostname, account_id: row.account_id,
    worker_name: row.worker_name, zone_id: row.zone_id, token_configured: Boolean(row.token_hint),
    token_hint: row.token_hint, secret_fingerprint: row.secret_fingerprint,
    worker_version: row.worker_version, is_default: row.is_default, enabled: row.enabled,
    health_status: row.health_status, last_health_at: row.last_health_at,
    last_deployed_at: row.last_deployed_at, last_error: row.last_error,
    site_ids: row.site_ids || [], group_ids: row.group_ids || []
  };
}

async function listProfiles() {
  const result = await query(`SELECT p.*,
    COALESCE((SELECT array_agg(target_id) FROM ad_edge_assignments WHERE profile_id=p.id AND target_type='site'),'{}') AS site_ids,
    COALESCE((SELECT array_agg(target_id) FROM ad_edge_assignments WHERE profile_id=p.id AND target_type='group'),'{}') AS group_ids
    FROM ad_edge_profiles p ORDER BY p.is_default DESC,p.id`);
  return result.rows.map(safeProfile);
}

async function validateTargets(client, siteIds, groupIds) {
  if (siteIds.length) {
    const count = Number((await client.query('SELECT COUNT(*)::int AS count FROM sites WHERE id=ANY($1::bigint[])', [siteIds])).rows[0].count);
    if (count !== siteIds.length) throw badRequest('广告 API 分配包含不存在的导航站');
  }
  if (groupIds.length) {
    const count = Number((await client.query('SELECT COUNT(*)::int AS count FROM site_groups WHERE id=ANY($1::bigint[])', [groupIds])).rows[0].count);
    if (count !== groupIds.length) throw badRequest('广告 API 分配包含不存在的站点分组');
  }
  if (siteIds.length) {
    const conflict = (await client.query(`SELECT s.name,p.name AS profile_name FROM ad_edge_assignments a JOIN sites s ON s.id=a.target_id JOIN ad_edge_profiles p ON p.id=a.profile_id
      WHERE a.target_type='site' AND a.target_id=ANY($1::bigint[]) LIMIT 1`, [siteIds])).rows[0];
    if (conflict) throw badRequest(`导航站“${conflict.name}”已单独分配给“${conflict.profile_name}”`);
  }
  if (groupIds.length) {
    const conflict = (await client.query(`SELECT g.name,p.name AS profile_name FROM ad_edge_assignments a JOIN site_groups g ON g.id=a.target_id JOIN ad_edge_profiles p ON p.id=a.profile_id
      WHERE a.target_type='group' AND a.target_id=ANY($1::bigint[]) LIMIT 1`, [groupIds])).rows[0];
    if (conflict) throw badRequest(`站点分组“${conflict.name}”已分配给“${conflict.profile_name}”`);
  }
}

async function saveProfile(id, payload, actor, ip, audit) {
  const name = text(payload.name, 100); if (!name) throw badRequest('请填写广告 API 名称');
  const host = hostname(payload.hostname);
  const accountId = text(payload.account_id, 64); if (!/^[a-f0-9]{32}$/i.test(accountId)) throw badRequest('Cloudflare Account ID 格式不正确');
  const service = workerName(payload.worker_name || `webring-ad-edge-${host.split('.')[0]}`);
  const apiToken = text(payload.api_token, 4000);
  const siteIds = [...new Set((Array.isArray(payload.site_ids) ? payload.site_ids : []).map(Number).filter(Number.isSafeInteger))];
  const groupIds = [...new Set((Array.isArray(payload.group_ids) ? payload.group_ids : []).map(Number).filter(Number.isSafeInteger))];
  const isDefault = payload.is_default === true;
  return transaction(async client => {
    const existing = id ? (await client.query('SELECT * FROM ad_edge_profiles WHERE id=$1', [id])).rows[0] : null;
    if (id && !existing) throw notFound('广告 API 不存在');
    if (!existing && !apiToken) throw badRequest('首次创建广告 API 必须填写 Cloudflare API Token');
    const tokenCipher = apiToken ? encrypt(apiToken) : existing.encrypted_api_token;
    const backendSecret = existing ? decrypt(existing.encrypted_backend_secret) : crypto.randomBytes(32).toString('base64url');
    if (!backendSecret) throw new Error('广告 API 内部密钥无法解密');
    await client.query('DELETE FROM ad_edge_assignments WHERE profile_id=$1', [id || 0]);
    await validateTargets(client, siteIds, groupIds);
    if (isDefault) await client.query('UPDATE ad_edge_profiles SET is_default=FALSE WHERE is_default=TRUE');
    const params = [name,host,accountId,service,JSON.stringify(tokenCipher),apiToken ? secretHint(apiToken) : existing?.token_hint || '',JSON.stringify(existing?.encrypted_backend_secret?.data ? existing.encrypted_backend_secret : encrypt(backendSecret)),fingerprint(backendSecret),isDefault,payload.enabled !== false];
    const row = id
      ? (await client.query(`UPDATE ad_edge_profiles SET name=$2,hostname=$3,account_id=$4,worker_name=$5,encrypted_api_token=$6::jsonb,token_hint=$7,encrypted_backend_secret=$8::jsonb,secret_fingerprint=$9,is_default=$10,enabled=$11,updated_at=NOW() WHERE id=$1 RETURNING *`, [id,...params])).rows[0]
      : (await client.query(`INSERT INTO ad_edge_profiles(name,hostname,account_id,worker_name,encrypted_api_token,token_hint,encrypted_backend_secret,secret_fingerprint,is_default,enabled) VALUES(${params.map((_,index)=>`$${index+1}`).join(',')}) RETURNING *`, params)).rows[0];
    for (const siteId of siteIds) await client.query("INSERT INTO ad_edge_assignments(profile_id,target_type,target_id) VALUES($1,'site',$2)", [row.id, siteId]);
    for (const groupId of groupIds) await client.query("INSERT INTO ad_edge_assignments(profile_id,target_type,target_id) VALUES($1,'group',$2)", [row.id, groupId]);
    await client.query('UPDATE site_revisions SET ads_revision=ads_revision+1,updated_at=NOW()');
    if (audit) await audit(actor, id ? 'ad-edge.update' : 'ad-edge.create', 'ad_edge_profile', row.id, { hostname: host, worker_name: service, is_default: isDefault, site_ids: siteIds, group_ids: groupIds }, ip, client);
    return safeProfile({ ...row, site_ids: siteIds, group_ids: groupIds });
  });
}

async function resolveProfile(siteId) {
  const explicit = await query(`SELECT DISTINCT p.* FROM ad_edge_profiles p JOIN ad_edge_assignments a ON a.profile_id=p.id WHERE p.enabled=TRUE AND a.target_type='site' AND a.target_id=$1`, [siteId]);
  if (explicit.rows.length > 1) throw new Error('导航站存在多个同级广告 API 分配');
  if (explicit.rows[0]) return explicit.rows[0];
  const grouped = await query(`SELECT DISTINCT p.* FROM ad_edge_profiles p JOIN ad_edge_assignments a ON a.profile_id=p.id JOIN site_group_members m ON m.group_id=a.target_id WHERE p.enabled=TRUE AND a.target_type='group' AND m.site_id=$1`, [siteId]);
  if (grouped.rows.length > 1) throw new Error('导航站所属分组存在多个同级广告 API 分配');
  if (grouped.rows[0]) return grouped.rows[0];
  return one('SELECT * FROM ad_edge_profiles WHERE enabled=TRUE AND is_default=TRUE LIMIT 1');
}

async function siteConfig(siteId) {
  const profile = await resolveProfile(siteId);
  if (!profile) return { profile_id: '', origin: '', ticket_key: '', worker_version: '', enabled: false };
  const backendSecret = decrypt(profile.encrypted_backend_secret);
  if (!backendSecret) throw new Error('广告 API 内部密钥无法解密');
  return { profile_id: String(profile.id), origin: `https://${profile.hostname}`, ticket_key: deriveSiteTicketKey(backendSecret, siteId), worker_version: profile.worker_version, enabled: profile.enabled === true };
}

async function deployProfile(id) {
  const profile = await one('SELECT * FROM ad_edge_profiles WHERE id=$1', [id]);
  if (!profile) throw notFound('广告 API 不存在');
  const token = decrypt(profile.encrypted_api_token); const backendSecret = decrypt(profile.encrypted_backend_secret);
  if (!token || !backendSecret) throw new Error('广告 API Cloudflare Token 或内部密钥无法解密');
  try {
    await cfRequest(token, '/user/tokens/verify');
    const zone = await zoneForHostname(profile.account_id, token, profile.hostname);
    const source = await fs.readFile(path.join(__dirname, '..', '..', 'assets', 'ad-edge-worker.js'), 'utf8');
    const form = new FormData();
    form.set('metadata', new Blob([JSON.stringify({ main_module: 'worker.js', compatibility_date: WORKER_COMPATIBILITY_DATE, bindings: [
      { type: 'plain_text', name: 'BACKEND_ORIGIN', text: CONTROL_CENTER_PUBLIC_URL },
      { type: 'plain_text', name: 'PROFILE_ID', text: String(profile.id) }
    ] })], { type: 'application/json' }));
    form.set('worker.js', new Blob([source], { type: 'application/javascript+module' }), 'worker.js');
    await cfRequest(token, `/accounts/${encodeURIComponent(profile.account_id)}/workers/scripts/${encodeURIComponent(profile.worker_name)}`, { method: 'PUT', body: form });
    await cfRequest(token, `/accounts/${encodeURIComponent(profile.account_id)}/workers/scripts/${encodeURIComponent(profile.worker_name)}/secrets`, { method: 'PUT', body: { name: 'BACKEND_SECRET', text: backendSecret, type: 'secret_text' } });
    await cfRequest(token, `/accounts/${encodeURIComponent(profile.account_id)}/workers/domains`, { method: 'PUT', body: {
      hostname: profile.hostname,
      service: profile.worker_name,
      environment: 'production',
      zone_id: zone.id,
      override_existing_origin: true
    } });
    let healthStatus = 'provisioning'; let lastError = '';
    try { const response = await fetch(`https://${profile.hostname}/health`, { signal: AbortSignal.timeout(15000) }); healthStatus = response.ok ? 'healthy' : 'error'; if (!response.ok) lastError = `健康检查 HTTP ${response.status}`; } catch (error) { lastError = `域名证书可能仍在签发：${error.message}`; }
    await query('UPDATE ad_edge_profiles SET zone_id=$2,worker_version=$3,health_status=$4,last_error=$5,last_deployed_at=NOW(),last_health_at=NOW(),updated_at=NOW() WHERE id=$1', [id,zone.id,WORKER_VERSION,healthStatus,lastError]);
    return { ...safeProfile(profile), zone_id: zone.id, worker_version: WORKER_VERSION, health_status: healthStatus, last_error: lastError };
  } catch (error) {
    await query("UPDATE ad_edge_profiles SET health_status='error',last_error=$2,updated_at=NOW() WHERE id=$1", [id,String(error.message || error).slice(0,500)]);
    throw error;
  }
}

async function verifyRenderRequest(req, siteId, adId) {
  const profileId = text(req.get('x-ad-edge-profile'), 40);
  const mode = text(req.get('x-ad-edge-mode'), 20);
  const timestamp = text(req.get('x-ad-edge-timestamp'), 20);
  const signature = text(req.get('x-ad-edge-signature'), 200);
  const source = text(req.get('x-ad-edge-source'), 20) === 'local' ? 'local' : 'central';
  if (!/^\d+$/.test(profileId) || !['direct','sandbox'].includes(mode) || !/^\d+$/.test(timestamp) || Math.abs(Date.now()/1000-Number(timestamp)) > 30) throw badRequest('广告 Edge 请求无效');
  const profile = await one('SELECT * FROM ad_edge_profiles WHERE id=$1 AND enabled=TRUE', [profileId]);
  if (!profile) throw notFound('广告 API 不存在');
  const assigned = await resolveProfile(siteId);
  if (!assigned || String(assigned.id) !== profileId) throw badRequest('导航站未分配给该广告 API');
  const secret = decrypt(profile.encrypted_backend_secret); if (!secret) throw new Error('广告 API 内部密钥无法解密');
  const canonical = `${timestamp}\n${profileId}\n${siteId}\n${adId}\n${mode}\n${source}`;
  const expected = crypto.createHmac('sha256', secret).update(canonical).digest('base64url');
  if (!timingSafeText(expected, signature)) throw badRequest('广告 Edge 签名无效');
  const ad = source === 'local'
    ? await one(`SELECT local_ad_id AS id,ad_code,integrity_sha256,render_mode FROM site_ad_payloads
      WHERE site_id=$1 AND local_ad_id=$2 AND enabled=TRUE AND ad_type='code' AND render_mode=$3`, [siteId,adId,mode])
    : await one(`SELECT DISTINCT a.id,a.ad_code,a.integrity_sha256,a.render_mode FROM ads a
    LEFT JOIN ad_site_targets ast ON ast.ad_id=a.id AND ast.site_id=$1
    LEFT JOIN ad_group_targets agt ON agt.ad_id=a.id
    LEFT JOIN site_group_members sgm ON sgm.group_id=agt.group_id AND sgm.site_id=$1
    WHERE a.id=$2 AND a.enabled=TRUE AND a.ad_type='code' AND a.render_mode=$3
      AND (a.scope_mode='global' OR ast.site_id IS NOT NULL OR sgm.site_id IS NOT NULL)`, [siteId,adId,mode]);
  if (!ad) throw notFound('代码广告不可用');
  if (crypto.createHash('sha256').update(ad.ad_code).digest('hex') !== ad.integrity_sha256) throw new Error('广告代码完整性检查失败');
  return { code: ad.ad_code, integrity: ad.integrity_sha256 };
}

module.exports = { WORKER_VERSION, listProfiles, saveProfile, resolveProfile, siteConfig, deployProfile, verifyRenderRequest, deriveSiteTicketKey };
