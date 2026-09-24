'use strict';

const { query, one, transaction } = require('../db');
const { randomToken, sha256, timingSafeEqualText, normalizeHttpUrl, cleanSlug } = require('../lib/security');
const { SSO_TICKET_TTL_SECONDS } = require('../config');
const { parseSiteAuthorization } = require('../../packages/shared-protocol');
const { badRequest, notFound } = require('../lib/errors');
const AdEdgeService = require('./adEdgeService');
const { githubPublishTarget, repositoryNameFromFull } = require('./githubPublishTargetService');
const PlatformSettingsService = require('./platformSettingsService');
const SitePublishPlatformService = require('./sitePublishPlatformService');
const { npmCdnUrls } = require('./npmPublishService');

const AD_TYPES = new Set(['normal', 'code']);
const AD_POSITIONS = new Set(['banner', 'icon', 'top_float', 'bottom_float', 'icon_float']);
const PLATFORMS = new Set(['all', 'pc', 'ios', 'non_ios', 'android', 'harmony']);
const POLICIES = new Set(['central_only', 'central_first', 'mixed', 'local_only']);

function requiredText(value, label, max = 200) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`请填写${label}`);
  if (text.length > max) throw new Error(`${label}不能超过 ${max} 个字符`);
  return text;
}

function idList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
}

async function audit(actor, action, resourceType, resourceId = '', detail = {}, ip = null, client = null) {
  const executor = client || { query };
  await executor.query(`INSERT INTO audit_logs(actor_type, actor_id, action, resource_type, resource_id, detail, ip)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`, [
    actor.type, String(actor.id), action, resourceType, String(resourceId || ''), JSON.stringify(detail || {}), ip || null
  ]);
}

async function bumpRevisions(kind, siteIds = null, client = null) {
  const column = { nodes: 'nodes_revision', ads: 'ads_revision', publish: 'publish_revision' }[kind];
  if (!column) throw new Error('未知配置版本类型');
  const executor = client || { query };
  if (Array.isArray(siteIds) && siteIds.length) {
    await executor.query(`UPDATE site_revisions SET ${column} = ${column} + 1, updated_at = NOW() WHERE site_id = ANY($1::bigint[])`, [siteIds]);
  } else if (siteIds === null) {
    await executor.query(`UPDATE site_revisions SET ${column} = ${column} + 1, updated_at = NOW()`);
  }
}

function parseSite(payload) {
  return {
    name: requiredText(payload.name, '站点名称', 100),
    slug: cleanSlug(payload.slug),
    publicUrl: normalizeHttpUrl(payload.public_url, '前台地址'),
    adminUrl: normalizeHttpUrl(payload.admin_url, '后台地址'),
    enabled: payload.enabled !== false
  };
}

async function createSite(payload, actor, ip) {
  const site = parseSite(payload);
  const rawSecret = randomToken(32);
  const created = await transaction(async client => {
    const result = await client.query(`INSERT INTO sites(name, slug, public_url, admin_url, enabled)
      VALUES ($1, $2, $3, $4, $5) RETURNING *`, [site.name, site.slug, site.publicUrl, site.adminUrl, site.enabled]);
    const row = result.rows[0];
    await client.query('INSERT INTO site_credentials(site_id, secret_hash, secret_hint) VALUES ($1, $2, $3)', [row.id, sha256(rawSecret), rawSecret.slice(-6)]);
    await client.query('INSERT INTO site_revisions(site_id) VALUES ($1)', [row.id]);
    await client.query('INSERT INTO publish_pages(site_id) VALUES ($1)', [row.id]);
    for (const platform of ['cloudflare', 'github', 'npm', 'notion']) {
      await client.query(`INSERT INTO site_publish_platforms(site_id,platform,account_mode)
        VALUES($1,$2,'disabled') ON CONFLICT(site_id,platform) DO NOTHING`, [row.id, platform]);
    }
    for (const slot of AD_POSITIONS) {
      await client.query('INSERT INTO ad_slot_policies(site_id, slot) VALUES ($1, $2)', [row.id, slot]);
    }
    await audit(actor, 'site.create', 'site', row.id, { name: row.name, slug: row.slug }, ip, client);
    return row;
  });
  return { site: created, credential: `${created.id}.${rawSecret}` };
}

async function updateSite(id, payload, actor, ip) {
  const site = parseSite(payload);
  return transaction(async client => {
    const result = await client.query(`UPDATE sites SET name=$2, slug=$3, public_url=$4, admin_url=$5, enabled=$6,
      updated_at=NOW() WHERE id=$1 RETURNING *`, [id, site.name, site.slug, site.publicUrl, site.adminUrl, site.enabled]);
    if (!result.rows[0]) throw notFound('站点不存在');
    if (!site.enabled) await client.query('DELETE FROM sso_tickets WHERE site_id=$1 AND redeemed_at IS NULL', [id]);
    await bumpRevisions('publish', [id], client);
    await audit(actor, 'site.update', 'site', id, { name: site.name, enabled: site.enabled }, ip, client);
    return result.rows[0];
  });
}

async function rotateSiteSecret(id, actor, ip) {
  const rawSecret = randomToken(32);
  await transaction(async client => {
    const result = await client.query(`UPDATE site_credentials SET secret_hash=$2, secret_hint=$3, rotated_at=NOW()
      WHERE site_id=$1 RETURNING site_id`, [id, sha256(rawSecret), rawSecret.slice(-6)]);
    if (!result.rows[0]) throw notFound('站点不存在');
    await client.query('DELETE FROM sso_tickets WHERE site_id=$1 AND redeemed_at IS NULL', [id]);
    await audit(actor, 'site.credential.rotate', 'site', id, {}, ip, client);
  });
  return `${id}.${rawSecret}`;
}

async function issueSsoTicket(siteId, admin, ip) {
  const raw = randomToken(32);
  const site = await transaction(async client => {
    const selected = (await client.query('SELECT id,name,admin_url,enabled FROM sites WHERE id=$1 FOR UPDATE', [siteId])).rows[0];
    if (!selected || !selected.enabled) throw notFound('站点不存在或已停用');
    await client.query('DELETE FROM sso_tickets WHERE site_id=$1 AND admin_id=$2 AND redeemed_at IS NULL', [selected.id, admin.id]);
    await client.query(`INSERT INTO sso_tickets(ticket_hash,site_id,admin_id,expires_at)
      VALUES($1,$2,$3,NOW()+($4*INTERVAL '1 second'))`, [sha256(raw), selected.id, admin.id, SSO_TICKET_TTL_SECONDS]);
    await audit({ type: 'admin', id: admin.id }, 'site.sso.issue', 'site', selected.id, {}, ip, client);
    return selected;
  });
  const url = new URL('/api/admin/control-center/login', site.admin_url);
  url.hash = `control-ticket=${raw}`;
  return { url: url.href, expires_in: SSO_TICKET_TTL_SECONDS };
}

async function authenticateSiteCredential(value) {
  const credential = parseSiteAuthorization(value);
  if (!credential) return null;
  const site = await one(`SELECT s.*, c.secret_hash FROM sites s JOIN site_credentials c ON c.site_id=s.id
    WHERE s.id=$1 AND s.enabled=TRUE`, [credential.siteId]);
  if (!site || !timingSafeEqualText(sha256(credential.secret), site.secret_hash)) return null;
  delete site.secret_hash;
  return site;
}

async function redeemSsoTicket(site, rawTicket, ip) {
  const ticketHash = sha256(rawTicket);
  return transaction(async client => {
    const result = await client.query(`UPDATE sso_tickets SET redeemed_at=NOW()
      WHERE ticket_hash=$1 AND site_id=$2 AND redeemed_at IS NULL AND expires_at>NOW()
      RETURNING admin_id`, [ticketHash, site.id]);
    if (!result.rows[0]) throw new Error('票据无效、已使用或已过期');
    const adminResult = await client.query('SELECT id, username FROM admins WHERE id=$1 AND enabled=TRUE AND singleton_key=TRUE', [result.rows[0].admin_id]);
    if (!adminResult.rows[0]) throw new Error('管理员账号不可用');
    const localSessionNonce = randomToken(24);
    await audit({ type: 'site', id: site.id }, 'site.sso.redeem', 'site', site.id, { admin_id: adminResult.rows[0].id }, ip, client);
    return { admin: adminResult.rows[0], local_session_nonce: localSessionNonce, expires_in: 120 };
  });
}

async function setTargets(client, table, resourceColumn, resourceId, siteIds, groupIds) {
  await client.query(`DELETE FROM ${table}_site_targets WHERE ${resourceColumn}=$1`, [resourceId]);
  await client.query(`DELETE FROM ${table}_group_targets WHERE ${resourceColumn}=$1`, [resourceId]);
  for (const siteId of siteIds) await client.query(`INSERT INTO ${table}_site_targets(${resourceColumn}, site_id) VALUES ($1,$2)`, [resourceId, siteId]);
  for (const groupId of groupIds) await client.query(`INSERT INTO ${table}_group_targets(${resourceColumn}, group_id) VALUES ($1,$2)`, [resourceId, groupId]);
}

function resourceScope(payload) {
  const scopeMode = payload.scope_mode === 'selected' ? 'selected' : 'global';
  return { scopeMode, siteIds: scopeMode === 'selected' ? idList(payload.site_ids) : [], groupIds: scopeMode === 'selected' ? idList(payload.group_ids) : [] };
}

function parseNode(payload) {
  const scope = resourceScope(payload);
  if (scope.scopeMode === 'selected' && !scope.siteIds.length && !scope.groupIds.length) {
    throw badRequest('定向节点至少需要选择一个站点或站点分组');
  }
  const item = {
    speedName: requiredText(payload.speed_name, '测速名称', 80),
    partnerName: requiredText(payload.partner_name, '站点名称', 80),
    url: normalizeHttpUrl(payload.url, '节点地址'),
    enabled: payload.enabled !== false,
    sortOrder: Number(payload.sort_order || 0)
  };
  if (!Number.isSafeInteger(item.sortOrder) || Math.abs(item.sortOrder) > 1_000_000) throw badRequest('节点排序必须是 -1000000 到 1000000 之间的整数');
  return { ...item, scope };
}

async function saveNode(id, payload, actor, ip) {
  const item = parseNode(payload);
  const { scope } = item;
  return transaction(async client => {
    if (scope.siteIds.length) {
      const count = Number((await client.query('SELECT COUNT(*)::int AS count FROM sites WHERE id=ANY($1::bigint[])', [scope.siteIds])).rows[0].count);
      if (count !== scope.siteIds.length) throw badRequest('节点投放范围包含不存在的站点');
    }
    if (scope.groupIds.length) {
      const count = Number((await client.query('SELECT COUNT(*)::int AS count FROM site_groups WHERE id=ANY($1::bigint[])', [scope.groupIds])).rows[0].count);
      if (count !== scope.groupIds.length) throw badRequest('节点投放范围包含不存在的站点分组');
    }
    const result = id
      ? await client.query(`UPDATE nodes SET speed_name=$2,partner_name=$3,url=$4,enabled=$5,scope_mode=$6,sort_order=$7,updated_at=NOW() WHERE id=$1 RETURNING *`, [id,item.speedName,item.partnerName,item.url,item.enabled,scope.scopeMode,item.sortOrder])
      : await client.query(`INSERT INTO nodes(speed_name,partner_name,url,enabled,scope_mode,sort_order) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [item.speedName,item.partnerName,item.url,item.enabled,scope.scopeMode,item.sortOrder]);
    const row = result.rows[0];
    if (!row) throw new Error('节点不存在');
    await setTargets(client, 'node', 'node_id', row.id, scope.siteIds, scope.groupIds);
    await bumpRevisions('nodes', null, client);
    await audit(actor, id ? 'node.update' : 'node.create', 'node', row.id, { url: row.url, scope_mode: scope.scopeMode, site_ids: scope.siteIds, group_ids: scope.groupIds, sort_order: item.sortOrder, enabled: item.enabled }, ip, client);
    return row;
  });
}

function parseAd(payload) {
  const scope = resourceScope(payload);
  if (scope.scopeMode === 'selected' && !scope.siteIds.length && !scope.groupIds.length) {
    throw badRequest('定向广告至少需要选择一个站点或站点分组');
  }
  const adType = String(payload.ad_type || 'normal');
  const position = String(payload.ad_position || 'banner');
  const platform = adType === 'code' ? 'all' : String(payload.platform || 'all');
  if (!AD_TYPES.has(adType)) throw new Error('广告类型不合法');
  if (!AD_POSITIONS.has(position)) throw new Error('广告位置不合法');
  if (!PLATFORMS.has(platform)) throw new Error('投放平台不合法');
  const adCode = adType === 'code' ? String(payload.ad_code || '') : '';
  if (adType === 'code' && !adCode.trim()) throw new Error('请填写联盟广告代码');
  const priority = Number(payload.priority || 0);
  if (!Number.isSafeInteger(priority) || Math.abs(priority) > 1_000_000) throw badRequest('广告优先级必须是 -1000000 到 1000000 之间的整数');
  const renderMode = adType === 'code' && payload.render_mode === 'sandbox' ? 'sandbox' : 'direct';
  const rawSandbox = payload.sandbox_options && typeof payload.sandbox_options === 'object' && !Array.isArray(payload.sandbox_options) ? payload.sandbox_options : {};
  const sandboxOptions = renderMode === 'sandbox' ? {
    initial_height: Math.min(800, Math.max(50, Number.parseInt(rawSandbox.initial_height, 10) || 120)),
    auto_height: rawSandbox.auto_height !== false,
    allow_popups: rawSandbox.allow_popups !== false,
    allow_forms: rawSandbox.allow_forms === true,
    timeout_ms: Math.min(30000, Math.max(1000, Number.parseInt(rawSandbox.timeout_ms, 10) || 10000))
  } : {};
  return {
    namespace: requiredText(payload.namespace, '广告命名空间', 120),
    title: requiredText(payload.title, '广告标题', 120),
    adType,
    position,
    platform,
    adCode,
    renderMode,
    sandboxOptions,
    imageUrl: adType === 'normal' && payload.image_url ? normalizeHttpUrl(payload.image_url, '图片地址') : '',
    targetUrl: adType === 'normal' && payload.target_url ? normalizeHttpUrl(payload.target_url, '跳转地址') : '',
    description: String(payload.description || '').slice(0, 500),
    priority,
    enabled: payload.enabled !== false,
    scope
  };
}

function parseAdPolicies(value) {
  if (!Array.isArray(value)) throw badRequest('广告位策略必须是列表');
  const policies = new Map();
  for (const item of value) {
    if (!item || !AD_POSITIONS.has(item.slot) || !POLICIES.has(item.policy) || policies.has(item.slot)) {
      throw badRequest('广告位策略不合法或重复');
    }
    policies.set(item.slot, item.policy);
  }
  if (policies.size !== AD_POSITIONS.size) throw badRequest('请为全部广告位选择混合策略');
  return [...AD_POSITIONS].map(slot => ({ slot, policy: policies.get(slot) }));
}

function parsePublishPayload(value) {
  const payload = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const logoUrl = payload.logo_url ? normalizeHttpUrl(payload.logo_url, 'Logo 地址') : '';
  const entries = Array.isArray(payload.entries) ? payload.entries.slice(0, 100).map((item, index) => ({
    name: requiredText(item?.name || `访问入口 ${index + 1}`, '入口名称', 80),
    url: normalizeHttpUrl(item?.url, '入口地址'),
    note: String(item?.note || '').trim().slice(0, 160),
    official: item?.official === true
  })) : [];
  return {
    page_title: String(payload.page_title || '').trim().slice(0, 120),
    description: String(payload.description || '').trim().slice(0, 300),
    announcement: String(payload.announcement || '').trim().slice(0, 300),
    logo_url: logoUrl,
    entries
  };
}

const PUBLISH_LINK_WEIGHT_DEFAULTS = Object.freeze({
  cloudflare: 500,
  github: 400,
  notion: 300,
  'npm:unpkg': 200,
  'npm:esm': 100
});

function parsePublishLinkWeights(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.entries(PUBLISH_LINK_WEIGHT_DEFAULTS).map(([key, fallback]) => {
    const number = Number(input[key] ?? fallback);
    if (!Number.isSafeInteger(number) || Math.abs(number) > 1_000_000) throw badRequest('永久发布页排序权重必须是 -1000000 到 1000000 之间的整数');
    return [key, number];
  }));
}

async function saveAd(id, payload, actor, ip) {
  const item = parseAd(payload);
  const { scope } = item;
  const integrity = sha256(item.adCode || `${item.imageUrl}\n${item.targetUrl}`);
  return transaction(async client => {
    if (scope.siteIds.length) {
      const count = Number((await client.query('SELECT COUNT(*)::int AS count FROM sites WHERE id=ANY($1::bigint[])', [scope.siteIds])).rows[0].count);
      if (count !== scope.siteIds.length) throw badRequest('广告投放范围包含不存在的站点');
    }
    if (scope.groupIds.length) {
      const count = Number((await client.query('SELECT COUNT(*)::int AS count FROM site_groups WHERE id=ANY($1::bigint[])', [scope.groupIds])).rows[0].count);
      if (count !== scope.groupIds.length) throw badRequest('广告投放范围包含不存在的站点分组');
    }
    const params = [item.namespace,item.title,item.adType,item.position,item.platform,item.adCode,item.imageUrl,item.targetUrl,item.description,item.priority,item.enabled,scope.scopeMode,integrity,item.renderMode,JSON.stringify(item.sandboxOptions)];
    const result = id
      ? await client.query(`UPDATE ads SET namespace=$2,title=$3,ad_type=$4,ad_position=$5,platform=$6,ad_code=$7,image_url=$8,target_url=$9,description=$10,priority=$11,enabled=$12,scope_mode=$13,integrity_sha256=$14,render_mode=$15,sandbox_options=$16::jsonb,updated_at=NOW() WHERE id=$1 RETURNING *`, [id,...params])
      : await client.query(`INSERT INTO ads(namespace,title,ad_type,ad_position,platform,ad_code,image_url,target_url,description,priority,enabled,scope_mode,integrity_sha256,render_mode,sandbox_options) VALUES(${params.map((_,i)=>`$${i+1}`).join(',')}) RETURNING *`, params);
    const row = result.rows[0];
    if (!row) throw new Error('广告不存在');
    await setTargets(client, 'ad', 'ad_id', row.id, scope.siteIds, scope.groupIds);
    await bumpRevisions('ads', null, client);
    await audit(actor, id ? 'ad.update' : 'ad.create', 'ad', row.id, {
      namespace: row.namespace,
      ad_type: item.adType,
      ad_position: item.position,
      priority: item.priority,
      enabled: item.enabled,
      scope_mode: scope.scopeMode,
      site_ids: scope.siteIds,
      group_ids: scope.groupIds,
      integrity_sha256: integrity
      ,render_mode: item.renderMode
    }, ip, client);
    return row;
  });
}

function publishPageLinks(publish, platformAccounts, platformSettings) {
  const pages = [];
  const weights = parsePublishLinkWeights(publish?.publish_link_weights);
  if (platformAccounts.cloudflare?.mode !== 'disabled' && publish?.permanent_url) pages.push({ id: 'cloudflare', label: 'Cloudflare 永久发布页', url: publish.permanent_url, enabled: true, sort_order: 10, sort_weight: weights.cloudflare });
  if (platformAccounts.github?.mode !== 'disabled') {
    const repositoryName = publish?.github_repo_name || repositoryNameFromFull(publish?.github_repo);
    const owner = platformAccounts.github.mode === 'site' ? platformAccounts.github.settings?.username : platformSettings.github?.username;
    if (repositoryName && owner) {
      const target = githubPublishTarget(owner, repositoryName);
      pages.push({ id: 'github', label: 'GitHub Pages', url: target.pagesUrl, enabled: true, sort_order: 20, sort_weight: weights.github });
    }
  }
  if (platformAccounts.notion?.mode !== 'disabled' && publish?.notion_enabled && publish?.notion_public_url) pages.push({ id: 'notion', label: 'Notion 公告发布页', url: publish.notion_public_url, enabled: true, sort_order: 30, sort_weight: weights.notion });
  if (platformAccounts.npm?.mode !== 'disabled' && publish?.npm_enabled && publish?.npm_package_name) {
    const inherited = platformAccounts.npm.mode === 'site' ? platformAccounts.npm.settings : platformSettings.npm;
    const lines = publish.npm_cdn_mode === 'custom' ? publish.npm_cdn_lines : inherited.lines;
    const primary = publish.npm_cdn_mode === 'custom' ? publish.npm_primary_cdn : inherited.primary;
    for (const [index, item] of npmCdnUrls(publish.npm_package_name, 'latest', lines, primary).filter(item => item.page_entry).entries()) {
      const id = `npm:${item.provider}`;
      pages.push({ id, label: item.label, url: item.url, enabled: true, sort_order: 40 + index, sort_weight: weights[id] });
    }
  }
  return pages;
}

async function resolveSiteConfig(siteId) {
  const revisions = await one('SELECT * FROM site_revisions WHERE site_id=$1', [siteId]);
  const nodes = await query(`SELECT DISTINCT n.id,n.speed_name,n.partner_name,n.url,n.enabled,n.sort_order
    FROM nodes n
    LEFT JOIN node_site_targets nst ON nst.node_id=n.id AND nst.site_id=$1
    LEFT JOIN node_group_targets ngt ON ngt.node_id=n.id
    LEFT JOIN site_group_members sgm ON sgm.group_id=ngt.group_id AND sgm.site_id=$1
    WHERE n.scope_mode='global' OR nst.site_id IS NOT NULL OR sgm.site_id IS NOT NULL
    ORDER BY n.sort_order DESC,n.id ASC`, [siteId]);
  const ads = await query(`SELECT DISTINCT a.id,a.namespace,a.title,a.ad_type,a.ad_position,a.platform,a.ad_code,a.image_url,a.target_url,a.description,a.priority,a.integrity_sha256,a.render_mode,a.sandbox_options
    FROM ads a
    LEFT JOIN ad_site_targets ast ON ast.ad_id=a.id AND ast.site_id=$1
    LEFT JOIN ad_group_targets agt ON agt.ad_id=a.id
    LEFT JOIN site_group_members sgm ON sgm.group_id=agt.group_id AND sgm.site_id=$1
    WHERE a.enabled=TRUE AND (a.scope_mode='global' OR ast.site_id IS NOT NULL OR sgm.site_id IS NOT NULL)
    ORDER BY a.ad_position,a.priority DESC,a.id`, [siteId]);
  const policies = await query('SELECT slot,policy FROM ad_slot_policies WHERE site_id=$1 ORDER BY slot', [siteId]);
  const publish = await one('SELECT * FROM publish_pages WHERE site_id=$1', [siteId]);
  const [platformAccounts, platformSettings] = await Promise.all([
    SitePublishPlatformService.safeSettings(siteId),
    PlatformSettingsService.safeSettings()
  ]);
  publish.pages = publishPageLinks(publish, platformAccounts, platformSettings);
  const adEdge = await AdEdgeService.siteConfig(siteId);
  const deliveredAds = ads.rows
    .filter(ad => ad.ad_type !== 'code' || adEdge.enabled)
    .map(ad => ad.ad_type === 'code' ? { ...ad, ad_code: '', code_delivery: 'edge', ad_edge: { profile_id: adEdge.profile_id, origin: adEdge.origin } } : ad);
  return { revisions, nodes: nodes.rows, ads: deliveredAds, ad_policies: policies.rows, publish, ad_edge: adEdge };
}

module.exports = {
  AD_POSITIONS,
  POLICIES,
  audit,
  bumpRevisions,
  createSite,
  updateSite,
  rotateSiteSecret,
  issueSsoTicket,
  authenticateSiteCredential,
  redeemSsoTicket,
  saveNode,
  saveAd,
  resolveSiteConfig,
  publishPageLinks,
  requiredText,
  idList,
  parseAd,
  parseAdPolicies,
  parsePublishPayload,
  parsePublishLinkWeights,
  parseNode,
  resourceScope
};
