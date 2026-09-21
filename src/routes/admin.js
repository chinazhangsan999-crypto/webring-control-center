'use strict';

const express = require('express');
const { query, one, transaction } = require('../db');
const { ok, fail, asyncRoute } = require('../lib/http');
const { cleanSlug, normalizeHttpUrl } = require('../lib/security');
const { requireAdmin, requireCsrf } = require('../middleware/auth');
const ControlService = require('../services/controlService');
const SuperAdminService = require('../services/superAdminService');
const JobWorker = require('../services/jobWorker');
const AlertService = require('../services/alertService');
const JobAlertService = require('../services/jobAlertService');
const PlatformSettingsService = require('../services/platformSettingsService');
const SitePublishPlatformService = require('../services/sitePublishPlatformService');
const { normalizePackageName, normalizeCdnLines, npmCdnUrls, npmPageUrl, resolveNpmPageEntryProvider } = require('../services/npmPublishService');
const { normalizePageId, normalizePublicUrl, verifyNotionToken } = require('../services/notionPublishService');
const { badRequest, notFound, conflict } = require('../lib/errors');

const router = express.Router();
router.use(requireAdmin, requireCsrf);

function numericId(value, label = '编号') {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${label}不合法`);
  return id;
}

function actor(req) { return { type: 'admin', id: req.admin.id }; }

async function testGithub(config) {
  if (!config.githubToken) throw badRequest('请先填写 GitHub Token');
  const response = await fetch('https://api.github.com/user', { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${config.githubToken}`, 'User-Agent': 'webring-control-center' }, signal: AbortSignal.timeout(15_000) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw badRequest(`GitHub 连接失败：${data?.message || `HTTP ${response.status}`}`);
  return { account: data?.login || '', message: 'GitHub Token 有效' };
}

async function testCloudflare(config) {
  if (!config.cloudflareToken) throw badRequest('请先填写 Cloudflare API Token');
  const response = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', { headers: { Authorization: `Bearer ${config.cloudflareToken}` }, signal: AbortSignal.timeout(15_000) });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.success === false) throw badRequest(`Cloudflare 连接失败：${data?.errors?.[0]?.message || `HTTP ${response.status}`}`);
  return { status: data?.result?.status || 'active', message: 'Cloudflare Token 有效' };
}

async function testTelegram(config) {
  if (!config.telegramToken || !config.telegramChatId) throw badRequest('请先填写 Telegram Bot Token 与 Chat ID');
  const response = await fetch(`https://api.telegram.org/bot${config.telegramToken}/getMe`, { signal: AbortSignal.timeout(15_000) });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.ok === false) throw badRequest(`Telegram 连接失败：${data?.description || `HTTP ${response.status}`}`);
  return { account: data?.result?.username || '', message: 'Telegram Bot Token 有效' };
}

async function testBark(config) {
  if (!config.barkUrl) throw badRequest('请先填写 Bark URL');
  let url;
  try { url = new URL(config.barkUrl); } catch { throw badRequest('Bark URL 不合法'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw badRequest('Bark URL 只允许 HTTP/HTTPS');
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '【总后台】Bark 连接测试', body: '这是一条连接测试通知。', group: '总后台' }), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw badRequest(`Bark 连接失败：HTTP ${response.status}`);
  return { message: 'Bark 测试通知已发送' };
}

router.get('/security', asyncRoute(async (req, res) => ok(res,
  await SuperAdminService.getSecurityOverview(req.admin.id, req.admin.sessionId))));

router.put('/security/account', asyncRoute(async (req, res) => ok(res,
  await SuperAdminService.updateAccount(req.admin.id, req.admin.sessionId, req.body || {}, req.ip),
  '超级管理员账号已更新')));

router.post('/security/revoke-sessions', asyncRoute(async (req, res) => ok(res,
  await SuperAdminService.revokeOtherSessions(req.admin.id, req.admin.sessionId, req.ip),
  '其他管理会话已全部退出')));

router.get('/platform-settings', asyncRoute(async (_req, res) => ok(res, await PlatformSettingsService.safeSettings())));
router.get('/platform-settings/site-accounts', asyncRoute(async (_req, res) => {
  const sites=(await query('SELECT id,name,slug FROM sites ORDER BY name,id')).rows;
  const items=await Promise.all(sites.map(async site=>({site,platforms:await SitePublishPlatformService.safeSettings(site.id)})));
  return ok(res,items);
}));
router.put('/platform-settings', asyncRoute(async (req, res) => {
  const current = await PlatformSettingsService.safeSettings();
  const proposed = PlatformSettingsService.normalizeSettings(req.body || {}, current);
  if (proposed.npm.enabled && !resolveNpmPageEntryProvider(proposed.npm.lines, proposed.npm.primary)) {
    throw badRequest('启用 npm 发布时，至少选择 UNPKG 或 esm.sh 作为网页入口线路');
  }
  const saved = await PlatformSettingsService.save(req.body || {});
  const changedPlatforms=['github','cloudflare','npm','notion'].filter(name=>JSON.stringify(current[name])!==JSON.stringify(proposed[name]));
  if(changedPlatforms.length){
    const affected=(await query(`SELECT DISTINCT site_id FROM site_publish_platforms WHERE account_mode='global' AND platform=ANY($1::text[])`,[changedPlatforms])).rows.map(row=>Number(row.site_id));
    if(affected.length)await ControlService.bumpRevisions('publish',affected);
  }
  await ControlService.audit(actor(req), 'platform-settings.update', 'settings', 'platforms', { sections: Object.keys(req.body || {}).filter(key => key !== 'secrets'), secret_keys: Object.keys(req.body?.secrets || {}).filter(key => req.body.secrets[key] !== undefined).sort(), changed_platforms: changedPlatforms }, req.ip);
  return ok(res, saved, '平台与告警设置已保存');
}));
router.put('/platform-settings/sites/:id', asyncRoute(async (req,res)=>{
  const siteId=numericId(req.params.id);
  const site=await one('SELECT id,name FROM sites WHERE id=$1',[siteId]);
  if(!site)throw notFound('站点不存在');
  const requested=req.body?.platforms&&typeof req.body.platforms==='object'?req.body.platforms:{};
  for(const name of Object.keys(requested)){if(!SitePublishPlatformService.PLATFORMS.includes(name))throw badRequest('发布平台不合法');}
  if(requested.npm){
    const settings=SitePublishPlatformService.normalizePlatformSettings('npm',requested.npm.settings||{});
    if(!resolveNpmPageEntryProvider(settings.lines,settings.primary))throw badRequest('独立 npm 设置至少选择 UNPKG 或 esm.sh 作为网页入口');
  }
  const before=await SitePublishPlatformService.safeSettings(siteId);
  const payload=Object.fromEntries(Object.entries(requested).map(([name,value])=>[name,{settings:value?.settings,secret:value?.secret}]));
  const saved=await SitePublishPlatformService.save(siteId,payload);
  const configChanged=SitePublishPlatformService.PLATFORMS.some(name=>JSON.stringify(before[name]?.settings)!==JSON.stringify(saved[name]?.settings));
  if(configChanged)await ControlService.bumpRevisions('publish',[siteId]);
  await ControlService.audit(actor(req),'platform-settings.site.update','site',siteId,{platforms:Object.keys(requested),secret_platforms:Object.entries(requested).filter(([,value])=>value?.secret!==undefined).map(([name])=>name),config_changed:configChanged},req.ip);
  return ok(res,saved,`${site.name}的独立发布账号已保存`);
}));
router.post('/platform-settings/sites/:id/test/:provider', asyncRoute(async (req,res)=>{
  const siteId=numericId(req.params.id);const provider=String(req.params.provider||'');
  if(!SitePublishPlatformService.PLATFORMS.includes(provider))throw badRequest('未知发布平台');
  const site=await one('SELECT id,name FROM sites WHERE id=$1',[siteId]);
  if(!site)throw notFound('站点不存在');
  const platform=await SitePublishPlatformService.resolveSiteAccount(siteId,provider);
  let result;
  if(provider==='github')result=await testGithub({githubToken:platform.credentials.token});
  else if(provider==='cloudflare')result=await testCloudflare({cloudflareToken:platform.credentials.token});
  else if(provider==='npm'){
    const response=await fetch(`${platform.settings.registry||'https://registry.npmjs.org'}/-/ping`,{signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw badRequest(`npm Registry 连接失败：HTTP ${response.status}`);
    result={message:'独立 npm Registry 可访问，发布认证继续使用 GitHub OIDC'};
  }else if(provider==='notion')result=await verifyNotionToken({token:platform.credentials.token});
  else throw badRequest('未知发布平台');
  await ControlService.audit(actor(req),'platform-settings.site.test','site',siteId,{provider,success:true},req.ip);
  return ok(res,result,`${site.name} · ${result.message}`);
}));
router.post('/platform-settings/test/:provider', asyncRoute(async (req, res) => {
  const provider = String(req.params.provider || '');
  const runtime = await PlatformSettingsService.runtimeSettings();
  let result;
  if (provider === 'github') result = await testGithub({ githubToken: runtime.secrets.github_token });
  else if (provider === 'cloudflare') result = await testCloudflare({ cloudflareToken: runtime.secrets.cloudflare_token });
  else if (provider === 'npm') {
    const response = await fetch(`${runtime.npm.registry}/-/ping`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw badRequest(`npm Registry 连接失败：HTTP ${response.status}`);
    result = { message: 'npm Registry 可访问，发布认证使用 GitHub OIDC' };
  } else if (provider === 'notion') result = await verifyNotionToken({ token: runtime.secrets.notion_token });
  else if (provider === 'telegram') result = await testTelegram({ telegramToken: runtime.secrets.telegram_token, telegramChatId: runtime.alerts.telegram_chat_id });
  else if (provider === 'bark') result = await testBark({ barkUrl: runtime.secrets.bark_url });
  else throw badRequest('未知平台');
  await ControlService.audit(actor(req), 'platform-settings.test', 'settings', provider, { success: true }, req.ip);
  return ok(res, result, result.message);
}));

router.post('/sites/:id/publish/platforms/:provider/test', asyncRoute(async (req, res) => {
  const siteId=numericId(req.params.id);const provider=String(req.params.provider||'');
  if(!SitePublishPlatformService.PLATFORMS.includes(provider))throw badRequest('未知发布平台');
  const config=await one('SELECT github_repo,cloudflare_project,npm_package_name,notion_page_id FROM publish_pages WHERE site_id=$1',[siteId]);
  if(!config)throw notFound('站点不存在');
  const resolved=await SitePublishPlatformService.resolveForDeployment(siteId,provider);
  const platform=resolved.platforms[provider];
  if(!platform.enabled)throw badRequest('该站点未启用此平台');
  let result;
  if(provider==='github'){
    const token=platform.credentials.token;const repo=String(config.github_repo||'');
    if(!repo)throw badRequest('请先填写 GitHub 仓库');
    const response=await fetch(`https://api.github.com/repos/${repo}`,{headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${token}`,'User-Agent':'webring-control-center'},signal:AbortSignal.timeout(15000)});
    const data=await response.json().catch(()=>null);if(!response.ok)throw badRequest(`GitHub 仓库连接失败：${data?.message||`HTTP ${response.status}`}`);
    result={message:`GitHub 仓库连接正常（${platform.source==='global'?'全局账号':'本站独立账号'}）`};
  }else if(provider==='cloudflare'){
    if(!config.cloudflare_project)throw badRequest('请先填写 Cloudflare 项目');
    const url=`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(platform.settings.account_id)}/pages/projects/${encodeURIComponent(config.cloudflare_project)}`;
    const response=await fetch(url,{headers:{Authorization:`Bearer ${platform.credentials.token}`},signal:AbortSignal.timeout(15000)});
    const data=await response.json().catch(()=>null);if(!response.ok||data?.success===false)throw badRequest(`Cloudflare 项目连接失败：${data?.errors?.[0]?.message||`HTTP ${response.status}`}`);
    result={message:`Cloudflare 项目连接正常（${platform.source==='global'?'全局账号':'本站独立账号'}）`};
  }else if(provider==='npm'){
    const response=await fetch(`${platform.settings.registry||'https://registry.npmjs.org'}/-/ping`,{signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw badRequest(`npm Registry 连接失败：HTTP ${response.status}`);
    result={message:`npm Registry 可访问（${platform.source==='global'?'全局设置':'本站独立设置'}；发布认证使用 GitHub OIDC）`};
  }else{
    result=await verifyNotionToken({token:platform.credentials.token});
    result.message=`Notion Integration 有效（${platform.source==='global'?'全局账号':'本站独立账号'}）`;
  }
  await ControlService.audit(actor(req),'publish.platform.test','site',siteId,{provider,account_source:platform.source,success:true},req.ip);
  return ok(res,result,result.message);
}));

router.get('/dashboard', asyncRoute(async (_req, res) => {
  const counts = await one(`SELECT
    (SELECT COUNT(*)::int FROM sites) AS sites,
    (SELECT COUNT(*)::int FROM sites WHERE status='online' AND last_seen_at>NOW()-INTERVAL '3 minutes') AS online_sites,
    (SELECT COUNT(*)::int FROM nodes WHERE enabled=TRUE) AS nodes,
    (SELECT COUNT(*)::int FROM ads WHERE enabled=TRUE) AS ads,
    (SELECT COUNT(*)::int FROM jobs WHERE status IN ('queued','running')) AS active_jobs`);
  const recent = await query('SELECT id,name,public_url,status,agent_version,last_seen_at FROM sites ORDER BY last_seen_at DESC NULLS LAST,id LIMIT 8');
  return ok(res, { counts, recent_sites: recent.rows });
}));

router.get('/sites', asyncRoute(async (_req, res) => {
  const result = await query(`SELECT s.*,c.secret_hint,c.rotated_at,r.nodes_revision,r.ads_revision,r.publish_revision
    FROM sites s JOIN site_credentials c ON c.site_id=s.id JOIN site_revisions r ON r.site_id=s.id ORDER BY s.id`);
  return ok(res, result.rows);
}));

router.post('/sites', asyncRoute(async (req, res) => {
  const result = await ControlService.createSite(req.body || {}, actor(req), req.ip);
  return ok(res, result, '站点已创建，请立即保存凭据', 201);
}));

router.put('/sites/:id', asyncRoute(async (req, res) => ok(res,
  await ControlService.updateSite(numericId(req.params.id), req.body || {}, actor(req), req.ip), '站点已更新')));

router.post('/sites/:id/rotate-secret', asyncRoute(async (req, res) => ok(res, {
  credential: await ControlService.rotateSiteSecret(numericId(req.params.id), actor(req), req.ip)
}, '站点凭据已轮换，请立即保存')));

router.post('/sites/:id/sso-ticket', asyncRoute(async (req, res) => ok(res,
  await ControlService.issueSsoTicket(numericId(req.params.id), req.admin, req.ip), '一次性后台入口已生成')));

router.get('/groups', asyncRoute(async (_req, res) => {
  const result = await query(`SELECT g.*,COALESCE(array_agg(m.site_id) FILTER(WHERE m.site_id IS NOT NULL),'{}') AS site_ids
    FROM site_groups g LEFT JOIN site_group_members m ON m.group_id=g.id GROUP BY g.id ORDER BY g.name`);
  return ok(res, result.rows);
}));

router.post('/groups', asyncRoute(async (req, res) => {
  const name = ControlService.requiredText(req.body?.name, '分组名称', 80);
  const slug = cleanSlug(req.body?.slug);
  const siteIds = ControlService.idList(req.body?.site_ids);
  const group = await transaction(async client => {
    const created = (await client.query('INSERT INTO site_groups(name,slug) VALUES($1,$2) RETURNING *', [name,slug])).rows[0];
    for (const siteId of siteIds) await client.query('INSERT INTO site_group_members(group_id,site_id) VALUES($1,$2)', [created.id,siteId]);
    await ControlService.bumpRevisions('nodes', null, client);
    await ControlService.bumpRevisions('ads', null, client);
    await ControlService.audit(actor(req), 'group.create', 'group', created.id, { site_ids: siteIds }, req.ip, client);
    return created;
  });
  return ok(res, group, '站点分组已创建', 201);
}));

router.put('/groups/:id', asyncRoute(async (req, res) => {
  const id = numericId(req.params.id);
  const name = ControlService.requiredText(req.body?.name, '分组名称', 80);
  const slug = cleanSlug(req.body?.slug);
  const siteIds = ControlService.idList(req.body?.site_ids);
  const group = await transaction(async client => {
    const updated = (await client.query('UPDATE site_groups SET name=$2,slug=$3,updated_at=NOW() WHERE id=$1 RETURNING *',[id,name,slug])).rows[0];
    if (!updated) throw new Error('分组不存在');
    await client.query('DELETE FROM site_group_members WHERE group_id=$1',[id]);
    for (const siteId of siteIds) await client.query('INSERT INTO site_group_members(group_id,site_id) VALUES($1,$2)',[id,siteId]);
    await ControlService.bumpRevisions('nodes', null, client);
    await ControlService.bumpRevisions('ads', null, client);
    await ControlService.audit(actor(req), 'group.update', 'group', id, { site_ids: siteIds }, req.ip, client);
    return updated;
  });
  return ok(res, group, '站点分组已更新');
}));

router.delete('/groups/:id', asyncRoute(async (req, res) => {
  const id = numericId(req.params.id);
  await transaction(async client => {
    const group = (await client.query('DELETE FROM site_groups WHERE id=$1 RETURNING id,name', [id])).rows[0];
    if (!group) throw notFound('分组不存在');
    await ControlService.bumpRevisions('nodes', null, client);
    await ControlService.bumpRevisions('ads', null, client);
    await ControlService.audit(actor(req), 'group.delete', 'group', id, { name: group.name }, req.ip, client);
  });
  return ok(res, null, '站点分组已删除');
}));

router.get('/nodes', asyncRoute(async (_req, res) => {
  const result = await query(`SELECT n.*,
    COALESCE((SELECT array_agg(site_id) FROM node_site_targets WHERE node_id=n.id),'{}') AS site_ids,
    COALESCE((SELECT array_agg(group_id) FROM node_group_targets WHERE node_id=n.id),'{}') AS group_ids
    FROM nodes n ORDER BY n.sort_order DESC,n.id ASC`);
  return ok(res, result.rows);
}));
router.get('/sites/:id/nodes', asyncRoute(async (req, res) => {
  const siteId = numericId(req.params.id);
  const site = await one('SELECT id,name FROM sites WHERE id=$1', [siteId]);
  if (!site) throw notFound('站点不存在');
  const config = await ControlService.resolveSiteConfig(siteId);
  return ok(res, { site, revision: String(config.revisions.nodes_revision), nodes: config.nodes });
}));
router.post('/nodes', asyncRoute(async (req, res) => ok(res, await ControlService.saveNode(null, req.body || {}, actor(req), req.ip), '节点已创建', 201)));
router.put('/nodes/:id', asyncRoute(async (req, res) => ok(res, await ControlService.saveNode(numericId(req.params.id), req.body || {}, actor(req), req.ip), '节点已更新')));
router.delete('/nodes/:id', asyncRoute(async (req, res) => {
  const id = numericId(req.params.id);
  await transaction(async client => {
    const row = (await client.query('DELETE FROM nodes WHERE id=$1 RETURNING id,url', [id])).rows[0];
    if (!row) throw notFound('节点不存在');
    await ControlService.bumpRevisions('nodes', null, client);
    await ControlService.audit(actor(req), 'node.delete', 'node', id, { url: row.url }, req.ip, client);
  });
  return ok(res,null,'节点已删除');
}));

router.get('/ads', asyncRoute(async (_req, res) => {
  const result = await query(`SELECT a.*,
    COALESCE((SELECT array_agg(site_id) FROM ad_site_targets WHERE ad_id=a.id),'{}') AS site_ids,
    COALESCE((SELECT array_agg(group_id) FROM ad_group_targets WHERE ad_id=a.id),'{}') AS group_ids
    FROM ads a ORDER BY a.ad_position,a.priority DESC,a.id`);
  return ok(res, result.rows);
}));
router.get('/ad-policies', asyncRoute(async (_req, res) => {
  const sites = await query(`SELECT s.id,s.name,s.slug,s.enabled,s.status,s.applied_revision,r.ads_revision
    FROM sites s JOIN site_revisions r ON r.site_id=s.id ORDER BY s.name,s.id`);
  const policies = await query('SELECT site_id,slot,policy FROM ad_slot_policies ORDER BY site_id,slot');
  const bySite = new Map();
  for (const item of policies.rows) {
    if (!bySite.has(String(item.site_id))) bySite.set(String(item.site_id), []);
    bySite.get(String(item.site_id)).push({ slot: item.slot, policy: item.policy });
  }
  return ok(res, sites.rows.map(site => ({ ...site, policies: bySite.get(String(site.id)) || [] })));
}));
router.get('/sites/:id/ads', asyncRoute(async (req, res) => {
  const siteId = numericId(req.params.id);
  const site = await one('SELECT id,name FROM sites WHERE id=$1', [siteId]);
  if (!site) throw notFound('站点不存在');
  const config = await ControlService.resolveSiteConfig(siteId);
  return ok(res, { site, revision: String(config.revisions.ads_revision), ads: config.ads, policies: config.ad_policies });
}));
router.post('/ads', asyncRoute(async (req, res) => ok(res, await ControlService.saveAd(null, req.body || {}, actor(req), req.ip), '广告已创建', 201)));
router.put('/ads/:id', asyncRoute(async (req, res) => ok(res, await ControlService.saveAd(numericId(req.params.id), req.body || {}, actor(req), req.ip), '广告已更新')));
router.delete('/ads/:id', asyncRoute(async (req, res) => {
  const id = numericId(req.params.id);
  await transaction(async client => {
    const row = (await client.query('DELETE FROM ads WHERE id=$1 RETURNING id,namespace', [id])).rows[0];
    if (!row) throw notFound('广告不存在');
    await ControlService.bumpRevisions('ads', null, client);
    await ControlService.audit(actor(req), 'ad.delete', 'ad', id, { namespace: row.namespace }, req.ip, client);
  });
  return ok(res, null, '广告已删除');
}));

router.get('/sites/:id/ad-policies', asyncRoute(async (req,res)=>{
  const result=await query('SELECT slot,policy FROM ad_slot_policies WHERE site_id=$1 ORDER BY slot',[numericId(req.params.id)]); return ok(res,result.rows);
}));
router.put('/sites/:id/ad-policies', asyncRoute(async (req,res)=>{
  const siteId=numericId(req.params.id); const items=ControlService.parseAdPolicies(req.body?.policies);
  await transaction(async client=>{const site=(await client.query('SELECT id FROM sites WHERE id=$1',[siteId])).rows[0];if(!site)throw notFound('站点不存在');for(const item of items){await client.query(`INSERT INTO ad_slot_policies(site_id,slot,policy) VALUES($1,$2,$3) ON CONFLICT(site_id,slot) DO UPDATE SET policy=EXCLUDED.policy,updated_at=NOW()`,[siteId,item.slot,item.policy]);} await ControlService.bumpRevisions('ads',[siteId],client); await ControlService.audit(actor(req),'ad-policy.update','site',siteId,{policies:items},req.ip,client);});
  return ok(res,null,'广告策略已更新');
}));

router.get('/sites/:id/publish', asyncRoute(async(req,res)=>{
  const siteId=numericId(req.params.id);
  const row=await one(`SELECT p.*,j.id AS deployment_job_id,j.status AS deployment_status,j.payload AS deployment_payload,j.result AS deployment_result,j.last_error AS deployment_error,j.created_at AS deployment_created_at,j.started_at AS deployment_started_at,j.finished_at AS deployed_at
    FROM publish_pages p LEFT JOIN LATERAL (SELECT id,status,payload,result,last_error,created_at,started_at,finished_at FROM jobs WHERE type='publish.deploy' AND site_id=p.site_id ORDER BY id DESC LIMIT 1) j ON TRUE
    WHERE p.site_id=$1`,[siteId]);
  if(!row)throw notFound('站点不存在');
  row.platform_accounts=await SitePublishPlatformService.safeSettings(siteId);
  if(row?.npm_enabled&&row.npm_package_name){
    const settings=await PlatformSettingsService.safeSettings();
    const npmAccount=row.platform_accounts.npm;
    const inherited=npmAccount.mode==='site'?npmAccount.settings:settings.npm;
    const lines=row.npm_cdn_mode==='custom'?row.npm_cdn_lines:inherited.lines;
    const primary=row.npm_cdn_mode==='custom'?row.npm_primary_cdn:inherited.primary;
    row.npm_page_urls=npmCdnUrls(row.npm_package_name,'latest',lines,primary);
    row.npm_page_url=row.npm_page_urls.find(item=>item.entry_primary)?.url||npmPageUrl(row.npm_package_name);
    row.npm_effective_lines=lines; row.npm_effective_primary=primary;
    row.npm_cdn_checks=(await query(`SELECT provider,status,page_url,stable_url,http_status,content_type,last_error,checked_at FROM npm_cdn_checks WHERE site_id=$1 ORDER BY checked_at DESC`,[row.site_id])).rows;
  }
  return ok(res,row);
}));
router.get('/sites/:id/publish/preview', asyncRoute(async(req,res)=>{
  const html=await JobWorker.renderPublishPreview(numericId(req.params.id));
  res.set('content-type','text/html; charset=utf-8');
  res.set('cache-control','no-store');
  res.set('content-security-policy',"default-src 'self'; img-src 'self' https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src http: https:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  return res.send(html);
}));
router.get('/sites/:id/publish/history', asyncRoute(async(req,res)=>{
  const siteId=numericId(req.params.id);
  const site=await one('SELECT id,name FROM sites WHERE id=$1',[siteId]);
  if(!site)throw notFound('站点不存在');
  const result=await query(`SELECT id,status,payload,result,attempts,max_attempts,last_error,created_at,started_at,finished_at
    FROM jobs WHERE type='publish.deploy' AND site_id=$1 ORDER BY id DESC LIMIT 20`,[siteId]);
  return ok(res,{site,jobs:result.rows});
}));
router.put('/sites/:id/publish', asyncRoute(async(req,res)=>{
  const siteId=numericId(req.params.id); const permanent=req.body?.permanent_url?normalizeHttpUrl(req.body.permanent_url,'永久发布域名'):''; const github=req.body?.github_pages_url?normalizeHttpUrl(req.body.github_pages_url,'GitHub Pages 地址'):'';
  const currentPlatforms=await SitePublishPlatformService.safeSettings(siteId);
  const requestedPlatforms=req.body?.platforms&&typeof req.body.platforms==='object'?req.body.platforms:{};
  for(const [name,value] of Object.entries(requestedPlatforms)){if(!SitePublishPlatformService.PLATFORMS.includes(name)||!SitePublishPlatformService.MODES.has(value?.mode))throw badRequest('发布平台账号来源不合法');}
  const modes=Object.fromEntries(SitePublishPlatformService.PLATFORMS.map(name=>[name,SitePublishPlatformService.normalizeMode(requestedPlatforms[name]?.mode??currentPlatforms[name]?.mode)]));
  if(modes.cloudflare!=='disabled'&&!permanent)throw badRequest('启用 Cloudflare 时必须填写自定义永久发布域名');
  if(modes.github!=='disabled'&&!github)throw badRequest('启用 GitHub 时必须填写 GitHub Pages 地址');
  if(permanent&&new URL(permanent).hostname.toLowerCase().endsWith('.pages.dev'))throw badRequest('自定义永久发布域名不能使用 pages.dev 原生地址');
  if(github&&!new URL(github).hostname.toLowerCase().endsWith('.github.io'))throw badRequest('GitHub Pages 地址必须使用 github.io 原生地址');
  const repo=String(req.body?.github_repo||'').trim().slice(0,200); const cf=String(req.body?.cloudflare_project||'').trim().slice(0,120); const email=String(req.body?.contact_email||'').trim().slice(0,200); const payload=ControlService.parsePublishPayload(req.body?.payload); const npmEnabled=req.body?.npm_enabled===true; const npmMode=req.body?.npm_cdn_mode==='custom'?'custom':'inherit'; const notionEnabled=req.body?.notion_enabled===true; const notionSyncEnabled=req.body?.notion_sync_enabled===true; const notionPageId=notionEnabled?normalizePageId(req.body?.notion_page_id):''; const notionPublicUrl=notionEnabled?normalizePublicUrl(req.body?.notion_public_url):''; let npmPackage=''; let npmLines=[]; let npmPrimary='';
  if(repo&&!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))throw badRequest('GitHub 仓库请使用 owner/repository 格式');
  if(cf&&!/^[a-z0-9][a-z0-9-]{0,62}$/.test(cf))throw badRequest('Cloudflare 项目名仅支持小写字母、数字和连字符');
  if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw badRequest('防失联邮箱格式不正确');
  try{npmPackage=req.body?.npm_package_name?normalizePackageName(req.body.npm_package_name):'';}catch(error){throw badRequest(error.message);}
  try { npmLines=npmMode==='custom'?normalizeCdnLines(req.body?.npm_cdn_lines):[]; npmPrimary=npmMode==='custom'?String(req.body?.npm_primary_cdn||'').trim():''; if(npmMode==='custom'&&!npmLines.includes(npmPrimary))npmPrimary=''; } catch(error) { throw badRequest(error.message); }
  if(modes.github!=='disabled'&&!repo)throw badRequest('启用 GitHub 时必须填写 GitHub 仓库');
  if(modes.cloudflare!=='disabled'&&!cf)throw badRequest('启用 Cloudflare 时必须填写 Cloudflare 项目');
  if(modes.npm!=='disabled'&&!npmPackage)throw badRequest('启用 npm 发布时必须填写 npm 包名');
  if(modes.npm!=='disabled'&&modes.github==='disabled')throw badRequest('npm OIDC 发布依赖 GitHub，请同时启用 GitHub 平台');
  if(modes.npm!=='disabled'&&npmMode==='custom'&&!resolveNpmPageEntryProvider(npmLines,npmPrimary))throw badRequest('自定义 npm 线路至少选择 UNPKG 或 esm.sh 作为网页入口');
  if(modes.notion!=='disabled'&&!notionPublicUrl)throw badRequest('启用 Notion 发布页时，请填写有效的 Notion 公开地址');
  if(notionSyncEnabled&&modes.notion==='disabled')throw badRequest('启用自动同步前，请先启用 Notion 平台');
  if(notionSyncEnabled&&!notionPageId)throw badRequest('启用 Notion 自动同步时，请填写 Notion 页面 ID');
  const row = await transaction(async client => {
    const updated=(await client.query(`UPDATE publish_pages SET permanent_url=$2,github_pages_url=$3,github_repo=$4,cloudflare_project=$5,contact_email=$6,payload=$7::jsonb,npm_enabled=$8,npm_package_name=$9,npm_cdn_mode=$10,npm_cdn_lines=$11::jsonb,npm_primary_cdn=$12,notion_enabled=$13,notion_sync_enabled=$14,notion_page_id=$15,notion_public_url=$16,updated_at=NOW() WHERE site_id=$1 RETURNING *`,[siteId,permanent,github,repo,cf,email,JSON.stringify(payload),modes.npm!=='disabled',npmPackage,npmMode,JSON.stringify(npmLines),npmPrimary,modes.notion!=='disabled',notionSyncEnabled,notionPageId,notionPublicUrl])).rows[0];
    if(!updated)throw notFound('站点不存在');
    await SitePublishPlatformService.save(siteId,requestedPlatforms,client);
    await ControlService.bumpRevisions('publish',[siteId],client);
    await ControlService.audit(actor(req),'publish.update','site',siteId,{github_repo:repo,cloudflare_project:cf,npm_enabled:modes.npm!=='disabled',npm_package_name:npmPackage,npm_cdn_mode:npmMode,npm_cdn_lines:npmLines,npm_primary_cdn:npmPrimary,notion_enabled:modes.notion!=='disabled',notion_sync_enabled:notionSyncEnabled,notion_page_id:notionPageId,notion_public_url:notionPublicUrl,platform_modes:modes},req.ip,client);
    return updated;
  });
  return ok(res,row,'发布页配置已更新');
}));
router.post('/sites/:id/publish/jobs', asyncRoute(async(req,res)=>{
  const siteId=numericId(req.params.id);
  const resolved=await SitePublishPlatformService.resolveForDeployment(siteId);
  const enabled=resolved.platforms;
  const result=await transaction(async client=>{
    const config=(await client.query(`SELECT p.permanent_url,p.github_pages_url,p.github_repo,p.cloudflare_project,p.npm_enabled,p.npm_package_name,p.notion_sync_enabled,p.notion_page_id,p.notion_public_url,r.publish_revision,r.nodes_revision
      FROM publish_pages p JOIN site_revisions r ON r.site_id=p.site_id WHERE p.site_id=$1`,[siteId])).rows[0];
    if(!config)throw notFound('站点不存在');
    if(enabled.cloudflare.enabled&&(!config.permanent_url||!config.cloudflare_project))throw badRequest('请先配置 Cloudflare 自定义域名和项目');
    if(enabled.github.enabled&&(!config.github_pages_url||!config.github_repo))throw badRequest('请先配置 GitHub Pages 地址和仓库');
    if(enabled.npm.enabled&&(!enabled.github.enabled||!config.npm_package_name))throw badRequest('npm OIDC 发布需要启用 GitHub 并配置 npm 包名');
    if(config.notion_sync_enabled&&(!enabled.notion.enabled||!config.notion_page_id||!config.notion_public_url))throw badRequest('请先启用 Notion 并配置页面 ID 和公开地址');
    if(!enabled.cloudflare.enabled&&!enabled.github.enabled&&!enabled.npm.enabled&&!config.notion_sync_enabled)throw badRequest('请至少启用一个发布平台');
    const progressTotal=1+(enabled.cloudflare.enabled?1:0)+(enabled.github.enabled?1:0)+(enabled.npm.enabled?1:0)+(config.notion_sync_enabled?1:0);
    const inserted=await client.query(`INSERT INTO jobs(type,site_id,payload,progress_total) VALUES('publish.deploy',$1,$2::jsonb,$3)
      ON CONFLICT (type,site_id) WHERE type='publish.deploy' AND status IN ('queued','running') DO NOTHING RETURNING *`,[siteId,JSON.stringify({requested_by:req.admin.id,publish_revision:config.publish_revision,nodes_revision:config.nodes_revision,platform_bindings:resolved.bindings}),progressTotal]);
    const created=Boolean(inserted.rows[0]);
    const job=inserted.rows[0]||(await client.query(`SELECT * FROM jobs WHERE type='publish.deploy' AND site_id=$1 AND status IN ('queued','running') ORDER BY id DESC LIMIT 1`,[siteId])).rows[0];
    if(created)await ControlService.audit(actor(req),'publish.deploy.queue','site',siteId,{job_id:job.id},req.ip,client);
    return {job,created};
  });
  return ok(res,result.job,result.created?'发布任务已加入队列':'该站点已有发布任务在执行',result.created?202:200);
}));

router.get('/jobs', asyncRoute(async(_req,res)=>{const result=await query('SELECT j.*,s.name AS site_name FROM jobs j LEFT JOIN sites s ON s.id=j.site_id ORDER BY j.id DESC LIMIT 100');return ok(res,result.rows);}));
router.get('/jobs/overview', asyncRoute(async(_req,res)=>{
  const counts=await one(`SELECT
    COUNT(*) FILTER(WHERE status='queued')::int AS queued,
    COUNT(*) FILTER(WHERE status='running')::int AS running,
    COUNT(*) FILTER(WHERE status='failed')::int AS failed,
    COUNT(*) FILTER(WHERE status='succeeded' AND finished_at>=NOW()-INTERVAL '24 hours')::int AS succeeded_24h,
    COUNT(*) FILTER(WHERE type='alert.send' AND status='succeeded' AND finished_at>=NOW()-INTERVAL '24 hours')::int AS alerts_succeeded_24h,
    COUNT(*) FILTER(WHERE type='alert.send' AND status='failed' AND finished_at>=NOW()-INTERVAL '24 hours')::int AS alerts_failed_24h,
    COALESCE(EXTRACT(EPOCH FROM NOW()-MIN(created_at) FILTER(WHERE status='queued'))::int,0) AS oldest_queue_seconds
    FROM jobs`);
  const recentAlertError=await one(`SELECT id,last_error,error_code,finished_at FROM jobs
    WHERE type='alert.send' AND status='failed' ORDER BY finished_at DESC NULLS LAST,id DESC LIMIT 1`);
  const alertCompleted=Number(counts.alerts_succeeded_24h)+Number(counts.alerts_failed_24h);
  return ok(res,{
    counts,
    worker:JobWorker.getWorkerStatus(),
    channels:await AlertService.configuredChannelsAsync(),
    alert_success_rate:alertCompleted?Number(((Number(counts.alerts_succeeded_24h)/alertCompleted)*100).toFixed(1)):null,
    recent_alert_error:recentAlertError
  });
}));
router.post('/alerts/test', asyncRoute(async(req,res)=>{
  const channels=await AlertService.configuredChannelsAsync();
  if(!Object.values(channels).some(Boolean))throw badRequest('请先配置 Telegram 或 Bark 告警通道');
  const job=await JobAlertService.enqueueAlert({
    event_type:'alert_test',severity:'info',title:'告警通道测试',
    body:`总后台告警队列工作正常。\n触发管理员：${req.admin.username}\n测试时间：${new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'medium',timeStyle:'medium',hour12:false}).format(new Date())}`
  });
  await ControlService.audit(actor(req),'alert.test.queue','job',job.id,{channels},req.ip);
  return ok(res,job,'告警测试已加入队列',202);
}));
router.post('/jobs/:id/retry', asyncRoute(async(req,res)=>{
  const id=numericId(req.params.id);
  const job=await transaction(async client=>{
    const current=(await client.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!current)throw notFound('任务不存在');
    if(current.status!=='failed')throw conflict('只能重试已失败的任务');
    const active=(await client.query(`SELECT id FROM jobs WHERE type=$1 AND site_id IS NOT DISTINCT FROM $2 AND status IN ('queued','running') LIMIT 1`,[current.type,current.site_id])).rows[0];
    if(active)throw conflict('同类任务已在队列中或执行中');
    let nextResult=current.type==='publish.deploy'?(current.result||{}):{};let nextPayload=current.payload||{};
    if(current.type==='publish.deploy'){
      const revision=(await client.query('SELECT publish_revision,nodes_revision FROM site_revisions WHERE site_id=$1',[current.site_id])).rows[0];
      if(!revision)throw notFound('发布任务对应站点不存在');
      if(Number(nextPayload.publish_revision)!==Number(revision.publish_revision)||Number(nextPayload.nodes_revision)!==Number(revision.nodes_revision)){
        throw conflict('发布页或节点配置已变化，请创建新的发布任务');
      }
      const resolved=await SitePublishPlatformService.resolveForDeployment(current.site_id);
      if(!SitePublishPlatformService.bindingsMatch(nextPayload.platform_bindings||{},resolved.bindings))throw conflict('发布平台账号来源或配置版本已变化，请创建新的发布任务');
    }
    const updated=(await client.query(`UPDATE jobs SET status='queued',attempts=0,available_at=NOW(),started_at=NULL,finished_at=NULL,last_error='',error_code='',heartbeat_at=NULL,progress_current=0,progress_total=CASE WHEN type='publish.deploy' THEN GREATEST(1,progress_total) ELSE 1 END,result=$2::jsonb,payload=$3::jsonb WHERE id=$1 RETURNING *`,[id,JSON.stringify(nextResult),JSON.stringify(nextPayload)])).rows[0];
    await ControlService.audit(actor(req),'job.retry','job',id,{type:updated.type,site_id:updated.site_id},req.ip,client);
    return updated;
  });
  return ok(res,job,'任务已重新加入队列');
}));
router.post('/jobs/:id/cancel', asyncRoute(async(req,res)=>{
  const id=numericId(req.params.id);
  const job=await transaction(async client=>{
    const current=(await client.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!current)throw notFound('任务不存在');
    if(current.status!=='queued')throw conflict('只能取消尚未开始的任务');
    const updated=(await client.query(`UPDATE jobs SET status='cancelled',finished_at=NOW(),error_code='CANCELLED',last_error='管理员取消任务' WHERE id=$1 RETURNING *`,[id])).rows[0];
    await ControlService.audit(actor(req),'job.cancel','job',id,{type:updated.type,site_id:updated.site_id},req.ip,client);
    return updated;
  });
  return ok(res,job,'任务已取消');
}));
router.get('/audit-logs', asyncRoute(async(_req,res)=>{const result=await query('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200');return ok(res,result.rows);}));

module.exports = router;
