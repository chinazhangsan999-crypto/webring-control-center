'use strict';

const state = { csrf: '', user: null, view: 'dashboard', sites: [], groups: [], nodes: [], ads: [], adPolicies: [], jobsTimer: null };
const titles = { dashboard: '运行概览', sites: '导航站', groups: '站点分组', nodes: '节点管理', ads: '广告管理', publish: '永久发布页', jobs: '任务中心', audit: '审计日志', security: '安全设置' };
const adSlotLabels = { banner: '横幅', icon: '图标', top_float: '顶部代码', bottom_float: '底部代码', icon_float: '图标代码' };
const adPolicyLabels = { central_only: '仅中央', central_first: '中央优先', mixed: '混合排序', local_only: '仅本地' };
const $ = selector => document.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

function formatTime(value) {
  if (!value) return '尚未连接';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value));
}

function safeUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; }
}

function toast(message) {
  const element = $('#toast'); element.textContent = message; element.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { element.hidden = true; }, 4000);
}

async function api(path, options = {}) {
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  if (options.body && typeof options.body !== 'string') { headers['content-type'] = 'application/json'; options.body = JSON.stringify(options.body); }
  if (state.csrf && !['GET', 'HEAD'].includes(String(options.method || 'GET').toUpperCase())) headers['x-csrf-token'] = state.csrf;
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (response.status === 401) { showLogin(); throw new Error(payload?.message || '登录已过期'); }
  if (!response.ok) throw new Error(payload?.message || `请求失败（${response.status}）`);
  return payload?.data;
}

function showLogin() { $('#loginView').hidden = false; $('#appShell').hidden = true; state.csrf = ''; }
function showApp() { $('#loginView').hidden = true; $('#appShell').hidden = false; $('#currentUser').textContent = state.user.username; }

function pageHeader(_title, description, action = '') {
  return `<div class="page-header"><p>${escapeHtml(description)}</p><div class="actions">${action}</div></div>`;
}
function badge(value) { const text = String(value || '未知'); return `<span class="badge ${escapeHtml(text)}">${escapeHtml(text)}</span>`; }
function publishPlatformBadge(label,result){const status=result?.status||'pending',text=status==='succeeded'?'已发布':status==='failed'?'失败':status==='running'?'发布中':'待发布';return `<span class="badge ${escapeHtml(status)}">${escapeHtml(label)}：${text}</span>`;}
function jobStatusBadge(status){const labels={queued:'排队中',running:'执行中',succeeded:'已完成',failed:'执行失败',cancelled:'已取消'};return `<span class="badge ${escapeHtml(status||'pending')}">${escapeHtml(labels[status]||'未知状态')}</span>`;}
function empty(text) { return `<div class="empty">${escapeHtml(text)}</div>`; }
function link(value, label = value) { const href = safeUrl(value); return href ? `<a class="url" href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>` : escapeHtml(label || '—'); }

async function ensureTaxonomy() {
  if (!state.sites.length) state.sites = await api('/api/admin/sites');
  if (!state.groups.length) state.groups = await api('/api/admin/groups');
}

async function renderDashboard() {
  const data = await api('/api/admin/dashboard'); const c = data.counts;
  $('#content').innerHTML = `${pageHeader('全局运行状态','不同云厂商上的导航站，通过站点主动连接统一受控。')}
    <div class="metric-grid"><article class="metric"><span>登记站点</span><strong>${c.sites}</strong></article><article class="metric"><span>在线站点</span><strong>${c.online_sites}</strong></article><article class="metric"><span>启用节点</span><strong>${c.nodes}</strong></article><article class="metric"><span>中央广告</span><strong>${c.ads}</strong></article><article class="metric"><span>待执行任务</span><strong>${c.active_jobs}</strong></article></div>
    <section class="panel"><div class="panel-header"><h3>最近连接的站点</h3><button class="secondary" data-view-jump="sites">管理站点</button></div>${data.recent_sites.length ? `<div class="table-wrap"><table><thead><tr><th>站点</th><th>状态</th><th>Agent</th><th>最后心跳</th></tr></thead><tbody>${data.recent_sites.map(site=>`<tr><td><strong>${escapeHtml(site.name)}</strong><br>${link(site.public_url)}</td><td>${badge(site.status)}</td><td>${escapeHtml(site.agent_version||'未上报')}</td><td>${formatTime(site.last_seen_at)}</td></tr>`).join('')}</tbody></table></div>`:empty('尚未登记导航站')}</section>`;
}

async function renderSites() {
  state.sites = await api('/api/admin/sites');
  $('#content').innerHTML = `${pageHeader('导航站','登记不同域名和服务器上的导航站，并通过一次性票据进入后台。','<button class="primary" data-action="site-new">新增导航站</button>')}
    <section class="panel">${state.sites.length ? `<div class="table-wrap"><table><thead><tr><th>站点</th><th>连接</th><th>配置版本</th><th>凭据</th><th>操作</th></tr></thead><tbody>${state.sites.map(site=>`<tr><td><strong>${escapeHtml(site.name)}</strong><br>${link(site.public_url,site.slug)}</td><td>${badge(site.status)}<br><span class="muted">${formatTime(site.last_seen_at)}</span></td><td>N ${site.nodes_revision} · A ${site.ads_revision} · P ${site.publish_revision}</td><td>尾号 ${escapeHtml(site.secret_hint)}</td><td><div class="row-actions"><button data-action="site-enter" data-id="${site.id}">进入后台</button><button data-action="site-policy" data-id="${site.id}">广告策略</button><button data-action="site-edit" data-id="${site.id}">编辑</button><button data-action="site-rotate" data-id="${site.id}">换密钥</button></div></td></tr>`).join('')}</tbody></table></div>`:empty('尚未登记站点，先新增一个测试站点')}</section>`;
}

async function renderGroups() {
  await ensureTaxonomy(); state.groups = await api('/api/admin/groups');
  $('#content').innerHTML = `${pageHeader('站点分组','用一个分组给多个导航站统一下发节点或广告。','<button class="primary" data-action="group-new">新增分组</button>')}<div class="card-list">${state.groups.length?state.groups.map(group=>`<article class="item-card"><h3>${escapeHtml(group.name)}</h3><p class="muted">${escapeHtml(group.slug)}</p><div class="meta"><span class="badge">${group.site_ids.length} 个站点</span></div><footer><button class="secondary" data-action="group-edit" data-id="${group.id}">编辑成员</button></footer></article>`).join(''):empty('尚未创建站点分组')}</div>`;
}

function nodeScopeText(node) {
  if (node.scope_mode === 'global') return '全部启用站点';
  const siteNames = new Map(state.sites.map(item => [Number(item.id), item.name]));
  const groupNames = new Map(state.groups.map(item => [Number(item.id), item.name]));
  const siteIds = Array.isArray(node.site_ids) ? node.site_ids : [];
  const groupIds = Array.isArray(node.group_ids) ? node.group_ids : [];
  const parts = [];
  if (siteIds.length) parts.push(`站点：${siteIds.map(id => siteNames.get(Number(id)) || `#${id}`).join('、')}`);
  if (groupIds.length) parts.push(`分组：${groupIds.map(id => groupNames.get(Number(id)) || `#${id}`).join('、')}`);
  return parts.join('；') || '未指定范围';
}

function nodeSyncCounts() {
  const enabledSites = state.sites.filter(site => site.enabled !== false);
  const synced = enabledSites.filter(site => String(site.applied_revision || '').split('-')[0] === String(site.nodes_revision)).length;
  return { total: enabledSites.length, synced, pending: enabledSites.length - synced };
}

async function renderNodes() {
  await ensureTaxonomy(); state.nodes = await api('/api/admin/nodes');
  const sync = nodeSyncCounts();
  $('#content').innerHTML = `${pageHeader('统一节点管理','节点由总后台统一维护，并按全部站点、指定站点或站点分组下发完整快照。','<button class="primary" data-action="node-new">新增节点</button>')}
    <div class="metric-grid"><article class="metric"><span>节点总数</span><strong>${state.nodes.length}</strong></article><article class="metric"><span>启用节点</span><strong>${state.nodes.filter(node=>node.enabled).length}</strong></article><article class="metric"><span>已同步站点</span><strong>${sync.synced}/${sync.total}</strong></article><article class="metric"><span>等待同步</span><strong>${sync.pending}</strong></article></div>
    <section class="panel">${state.nodes.length?`<div class="table-wrap"><table><thead><tr><th>节点</th><th>地址</th><th>投放范围</th><th>排序</th><th>状态</th><th>操作</th></tr></thead><tbody>${state.nodes.map(node=>`<tr><td><strong>${escapeHtml(node.speed_name)}</strong><br><span class="muted">${escapeHtml(node.partner_name)}</span></td><td>${link(node.url)}</td><td class="scope-cell" title="${escapeHtml(nodeScopeText(node))}">${escapeHtml(nodeScopeText(node))}</td><td>${Number(node.sort_order||0)}</td><td><span class="badge ${node.enabled?'enabled':'disabled'}">${node.enabled?'已启用':'已停用'}</span></td><td><div class="row-actions"><button data-action="node-edit" data-id="${node.id}">编辑</button><button data-action="node-delete" data-id="${node.id}">删除</button></div></td></tr>`).join('')}</tbody></table></div>`:empty('尚未配置中央节点')}</section>`;
}

function adScopeText(ad) {
  if (ad.scope_mode === 'global') return '全部启用站点';
  const siteNames = new Map(state.sites.map(item => [Number(item.id), item.name]));
  const groupNames = new Map(state.groups.map(item => [Number(item.id), item.name]));
  const siteIds = Array.isArray(ad.site_ids) ? ad.site_ids : [];
  const groupIds = Array.isArray(ad.group_ids) ? ad.group_ids : [];
  const parts = [];
  if (siteIds.length) parts.push(`站点：${siteIds.map(id => siteNames.get(Number(id)) || `#${id}`).join('、')}`);
  if (groupIds.length) parts.push(`分组：${groupIds.map(id => groupNames.get(Number(id)) || `#${id}`).join('、')}`);
  return parts.join('；') || '未指定范围';
}

function policySummary(items = []) {
  const policies = new Map(items.map(item => [item.slot, item.policy]));
  return Object.keys(adSlotLabels).map(slot => {
    const policy = policies.get(slot) || 'central_first';
    return `<span class="policy-chip"><span>${escapeHtml(adSlotLabels[slot])}</span><strong>${escapeHtml(adPolicyLabels[policy])}</strong></span>`;
  }).join('');
}

function adSiteSyncBadge(site) {
  if (site.enabled === false) return '<span class="badge disabled">站点已停用</span>';
  const applied = String(site.applied_revision || '').split('-')[1];
  const synced = applied === String(site.ads_revision);
  return `<span class="badge ${synced?'enabled':'pending'}">${synced?'已同步':`待同步（A${escapeHtml(site.ads_revision)}）`}</span>`;
}

async function previewSiteAds(siteId) {
  const data = await api(`/api/admin/sites/${siteId}/ads`);
  openModal(`${data.site.name}·广告快照`, `<p class="muted">该快照是导航站下次同步会收到的中央广告，不包含该站自己维护的本地广告。</p><div class="policy-list">${policySummary(data.policies)}</div>${data.ads.length?`<div class="table-wrap"><table><thead><tr><th>广告</th><th>广告位</th><th>类型</th><th>优先级</th></tr></thead><tbody>${data.ads.map(ad=>`<tr><td><strong>${escapeHtml(ad.title)}</strong><br><span class="muted">${escapeHtml(ad.namespace)}</span></td><td>${escapeHtml(adSlotLabels[ad.ad_position]||ad.ad_position)}</td><td>${ad.ad_type==='code'?'联盟代码':'普通图片'}</td><td>${Number(ad.priority||0)}</td></tr>`).join('')}</tbody></table></div>`:empty('该站当前没有命中任何中央广告')}<div class="modal-actions"><button class="primary" value="save">关闭</button></div>`, async()=>({message:'已关闭快照',refresh:false}), 'EFFECTIVE SNAPSHOT');
}

async function publishHistory(siteId) {
  const data=await api(`/api/admin/sites/${siteId}/publish/history`);
  const rows=data.jobs.map(job=>{const platforms=job.result?.platforms||{},manifest=job.result?.build?.manifest;return `<tr><td>#${job.id}<br><span class="muted">${formatTime(job.created_at)}</span></td><td>${jobStatusBadge(job.status)}</td><td><div class="meta">${publishPlatformBadge('CF',platforms.cloudflare)}${publishPlatformBadge('GH',platforms.github)}${platforms.npm?publishPlatformBadge('npm',platforms.npm):''}</div></td><td>${manifest?.sha256?`<span class="code-preview" title="${escapeHtml(manifest.sha256)}">${escapeHtml(manifest.sha256.slice(0,12))}…</span>`:'—'}</td><td>${Number(job.attempts||0)}/${Number(job.max_attempts||0)}</td><td>${job.status==='failed'?`<button type="button" class="secondary" data-action="publish-retry" data-id="${job.id}">重试</button>`:'—'}</td></tr>${job.last_error?`<tr class="history-error"><td colspan="6"><span>失败原因：</span>${escapeHtml(job.last_error)}</td></tr>`:''}`;}).join('');
  openModal(`${data.site.name}·发布历史`,`${data.jobs.length?`<div class="table-wrap"><table><thead><tr><th>任务 / 创建时间</th><th>状态</th><th>平台结果</th><th>内容摘要</th><th>尝试</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>`:empty('该站点还没有发布记录')}<div class="modal-actions"><button class="primary" value="save">关闭</button></div>`,async()=>({message:'已关闭发布历史',refresh:false}),'DEPLOYMENT HISTORY');
}

async function renderAds() {
  await ensureTaxonomy(); [state.ads,state.adPolicies] = await Promise.all([api('/api/admin/ads'),api('/api/admin/ad-policies')]);
  const enabledSites=state.adPolicies.filter(site=>site.enabled!==false);const synced=enabledSites.filter(site=>String(site.applied_revision||'').split('-')[1]===String(site.ads_revision)).length;
  $('#content').innerHTML = `${pageHeader('广告混合管理','中央广告与各导航站本地广告并存；联盟代码按原文保存和下发。','<button class="primary" data-action="ad-new">新增中央广告</button>')}
    <div class="metric-grid"><article class="metric"><span>中央广告</span><strong>${state.ads.length}</strong></article><article class="metric"><span>启用广告</span><strong>${state.ads.filter(ad=>ad.enabled).length}</strong></article><article class="metric"><span>代码广告</span><strong>${state.ads.filter(ad=>ad.ad_type==='code').length}</strong></article><article class="metric"><span>已同步站点</span><strong>${synced}/${enabledSites.length}</strong></article></div>
    <section class="panel"><div class="panel-header"><div><h3>中央广告</h3><p class="muted">排序数值越大越靠前；定向范围可为站点、分组或两者并集。</p></div></div>${state.ads.length?`<div class="table-wrap"><table><thead><tr><th>广告</th><th>类型/位置</th><th>投放范围</th><th>优先级</th><th>完整性</th><th>状态</th><th>操作</th></tr></thead><tbody>${state.ads.map(ad=>`<tr><td><strong>${escapeHtml(ad.title)}</strong><br><span class="muted">${escapeHtml(ad.namespace)}</span></td><td>${ad.ad_type==='code'?'联盟代码':'普通图片'} · ${escapeHtml(adSlotLabels[ad.ad_position]||ad.ad_position)}</td><td class="scope-cell" title="${escapeHtml(adScopeText(ad))}">${escapeHtml(adScopeText(ad))}</td><td>${Number(ad.priority||0)}</td><td class="code-preview" title="${escapeHtml(ad.integrity_sha256)}">${escapeHtml(ad.integrity_sha256.slice(0,14))}…</td><td><span class="badge ${ad.enabled?'enabled':'disabled'}">${ad.enabled?'已启用':'已停用'}</span></td><td><div class="row-actions"><button data-action="ad-edit" data-id="${ad.id}">编辑</button><button data-action="ad-delete" data-id="${ad.id}">删除</button></div></td></tr>`).join('')}</tbody></table></div>`:empty('尚未配置中央广告')}</section>
    <section class="panel"><div class="panel-header"><div><h3>各站混合策略</h3><p class="muted">每个广告位独立决定中央广告与本地广告的关系。</p></div></div>${state.adPolicies.length?`<div class="table-wrap"><table><thead><tr><th>导航站</th><th>五个广告位策略</th><th>同步状态</th><th>操作</th></tr></thead><tbody>${state.adPolicies.map(site=>`<tr><td><strong>${escapeHtml(site.name)}</strong><br><span class="muted">${escapeHtml(site.slug)}</span></td><td><div class="policy-list">${policySummary(site.policies)}</div></td><td>${adSiteSyncBadge(site)}</td><td><div class="row-actions"><button data-action="ad-site-policy" data-id="${site.id}">编辑策略</button><button data-action="ad-site-preview" data-id="${site.id}">查看快照</button></div></td></tr>`).join('')}</tbody></table></div>`:empty('尚未登记导航站')}</section>`;
}

function publishState(site,config){
  const ready=Boolean(config.permanent_url&&config.github_pages_url&&config.github_repo&&config.cloudflare_project&&(!config.npm_enabled||config.npm_package_name));
  const active=['queued','running'].includes(config.deployment_status);
  const built=config.deployment_result?.build;
  const current=Boolean(built&&Number(built.publish_revision)===Number(site.publish_revision)&&Number(built.nodes_revision)===Number(site.nodes_revision));
  if(!ready)return{ready,active,current,label:'配置未完成',className:'pending'};
  if(active)return{ready,active,current,label:config.deployment_status==='queued'?'等待发布':'正在发布',className:'running'};
  if(config.deployment_status==='failed')return{ready,active,current,label:'发布失败',className:'failed'};
  if(config.deployment_status==='succeeded'&&current)return{ready,active,current,label:'已是最新',className:'succeeded'};
  return{ready,active,current,label:'有更新待发布',className:'stale'};
}

function publishAddress(label,value){return `<div class="publish-address"><span>${escapeHtml(label)}</span><div>${link(value,value||'尚未配置')}${value?`<button type="button" data-copy="${escapeHtml(value)}">复制</button>`:''}</div></div>`;}

async function renderPublish() {
  state.sites = await api('/api/admin/sites');
  const configs = await Promise.all(state.sites.map(site=>api(`/api/admin/sites/${site.id}/publish`).then(config=>({site,config,state:publishState(site,config)}))));
  const counts={ready:configs.filter(item=>item.state.ready).length,current:configs.filter(item=>item.state.label==='已是最新').length,pending:configs.filter(item=>['有更新待发布','等待发布','正在发布'].includes(item.state.label)).length,failed:configs.filter(item=>item.state.label==='发布失败').length};
  $('#content').innerHTML = `${pageHeader('永久发布页','集中管理每个导航站在 Cloudflare、GitHub Pages 与 npm CDN 上的完整发布页。')}
    <div class="metric-grid publish-metrics"><article class="metric"><span>站点总数</span><strong>${configs.length}</strong></article><article class="metric"><span>配置完整</span><strong>${counts.ready}</strong></article><article class="metric"><span>已是最新</span><strong>${counts.current}</strong></article><article class="metric"><span>待发布 / 发布中</span><strong>${counts.pending}</strong></article><article class="metric"><span>需要处理</span><strong>${counts.failed}</strong></article></div>
    <section class="panel"><div class="panel-header"><div><h3>站点发布流水线</h3><p class="muted">预览展示完整页面；一键发布后，Cloudflare、GitHub Pages 与 npm CDN 都将托管同一份独立可访问的完整页面。</p></div></div>${configs.length?`<div class="publish-list">${configs.map(({site,config,state:status})=>{const platforms=config.deployment_result?.platforms||{};return `<article class="publish-row"><div class="publish-site"><div><h3>${escapeHtml(site.name)}</h3><p>${escapeHtml(site.slug)} · 发布版本 P${Number(site.publish_revision)} · 节点版本 N${Number(site.nodes_revision)}</p></div><span class="badge ${status.className}">${status.label}</span></div><div class="publish-addresses">${publishAddress('Cloudflare 自定义永久域名',config.permanent_url)}${publishAddress('GitHub Pages 完整发布页',config.github_pages_url)}${config.npm_enabled?publishAddress('npm CDN 完整发布页',config.npm_page_url):''}</div><div class="publish-platforms">${publishPlatformBadge('Cloudflare',platforms.cloudflare)}${publishPlatformBadge('GitHub Pages',platforms.github)}${config.npm_enabled?publishPlatformBadge('npm CDN',platforms.npm):''}<span class="publish-time">最近发布：${formatTime(config.deployed_at||config.deployment_created_at)}</span></div>${config.deployment_error?`<p class="error-text" role="status">最近错误：${escapeHtml(config.deployment_error)}</p>`:''}<footer><button class="secondary" data-action="publish-preview" data-id="${site.id}">预览完整页面</button><button class="secondary" data-action="publish-history" data-id="${site.id}">发布历史</button><button class="secondary" data-action="publish-edit" data-id="${site.id}">配置发布页</button>${config.deployment_status==='failed'?`<button class="secondary" data-action="publish-retry" data-id="${config.deployment_job_id}">重试失败平台</button>`:''}<button class="primary" data-action="publish-queue" data-id="${site.id}" ${status.ready&&!status.active?'':'disabled'}>${status.active?'发布进行中':config.npm_enabled?'发布完整页面到三平台':'发布完整页面到双平台'}</button></footer></article>`;}).join('')}</div>`:empty('请先登记导航站')}</section>`;
}

async function renderJobs() {
  clearTimeout(state.jobsTimer);
  const [jobs,overview]=await Promise.all([api('/api/admin/jobs'),api('/api/admin/jobs/overview')]);
  if(state.view!=='jobs')return;
  const counts=overview.counts;
  const channelBadge=(name,configured)=>`<span class="badge ${configured?'enabled':'disabled'}">${escapeHtml(name)}：${configured?'已配置':'未配置'}</span>`;
  const taskLabel=type=>type==='publish.deploy'?'永久页发布':type==='alert.send'?'发送告警':type;
  const platformResult=job=>job.type==='publish.deploy'
    ? `${publishPlatformBadge('CF',job.result?.platforms?.cloudflare)}${publishPlatformBadge('GH',job.result?.platforms?.github)}${job.result?.platforms?.npm?publishPlatformBadge('npm',job.result.platforms.npm):''}`
    : job.result?.channel?`<span class="badge succeeded">${escapeHtml(job.result.channel)} 已送达</span>`:'—';
  const rows=jobs.map(job=>{const current=Number(job.progress_current||0),total=Math.max(1,Number(job.progress_total||1)),percent=Math.min(100,Math.round(current/total*100)),detail=job.type==='alert.send'?job.payload?.title:job.type;return `<tr><td>#${job.id}<br><span class="muted">${formatTime(job.created_at)}</span></td><td><strong>${escapeHtml(taskLabel(job.type))}</strong><br><span class="muted">${escapeHtml(detail||job.type)}</span></td><td>${escapeHtml(job.site_name||'全局')}</td><td>${jobStatusBadge(job.status)}</td><td><progress class="job-progress" max="${total}" value="${current}" aria-label="进度 ${current}/${total}">${percent}%</progress><small>${current}/${total} · ${percent}%</small></td><td><div class="meta">${platformResult(job)}</div></td><td>${job.attempts}/${job.max_attempts}</td><td class="job-error-cell">${job.last_error?`<strong>${escapeHtml(job.error_code||'UNKNOWN')}</strong><br>${escapeHtml(job.last_error)}`:'—'}</td><td><div class="row-actions">${job.status==='failed'?`<button data-action="job-retry" data-id="${job.id}">重试</button>`:''}${job.status==='queued'?`<button data-action="job-cancel" data-id="${job.id}">取消</button>`:''}</div></td></tr>`;}).join('');
  $('#content').innerHTML=`${pageHeader('任务中心','任务持久保存在数据库中；发布失败自动退避重试，最终结果通过 Telegram 或 Bark 通知。','<button class="secondary" data-action="jobs-refresh">刷新</button><button class="primary" data-action="alert-test">测试告警</button>')}
    <div class="metric-grid"><article class="metric"><span>排队中</span><strong>${counts.queued}</strong></article><article class="metric"><span>执行中</span><strong>${counts.running}</strong></article><article class="metric"><span>24 小时完成</span><strong>${counts.succeeded_24h}</strong></article><article class="metric"><span>累计失败</span><strong>${counts.failed}</strong></article><article class="metric"><span>24 小时告警成功率</span><strong>${overview.alert_success_rate===null?'暂无数据':`${overview.alert_success_rate}%`}</strong></article></div>
    <section class="panel"><div class="panel-header"><div><h3>队列与告警通道</h3><p class="muted">执行器：${overview.worker.running?'运行中':'已停止'}${overview.worker.busy?'，正在处理任务':'，当前空闲'}；最老排队任务等待 ${Number(counts.oldest_queue_seconds||0)} 秒。</p></div><div class="channel-list">${channelBadge('Telegram',overview.channels.telegram)}${channelBadge('Bark',overview.channels.bark)}</div></div>${overview.recent_alert_error?`<div class="queue-warning" role="status"><strong>最近告警失败：</strong>${escapeHtml(overview.recent_alert_error.error_code||'UNKNOWN')} · ${escapeHtml(overview.recent_alert_error.last_error||'未知原因')} · ${formatTime(overview.recent_alert_error.finished_at)}</div>`:''}</section>
    <section class="panel"><div class="panel-header"><div><h3>最近 100 个任务</h3><p class="muted">页面每 5 秒自动更新。失败原因保留稳定错误码，便于判断凭据、限流、超时或网络问题。</p></div></div>${jobs.length?`<div class="table-wrap"><table><thead><tr><th>任务 / 创建时间</th><th>类型</th><th>站点</th><th>状态</th><th>进度</th><th>执行结果</th><th>尝试</th><th>失败原因</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>`:empty('尚无任务记录')}</section>`;
  state.jobsTimer=setTimeout(()=>{if(state.view==='jobs')renderJobs().catch(error=>toast(error.message));},5000);
}
async function renderAudit() {
  const logs=await api('/api/admin/audit-logs'); $('#content').innerHTML=`${pageHeader('审计日志','记录管理员与站点 Agent 的关键操作。')}<section class="panel">${logs.length?`<div class="table-wrap"><table><thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>对象</th><th>来源 IP</th></tr></thead><tbody>${logs.map(log=>`<tr><td>${formatTime(log.created_at)}</td><td>${escapeHtml(log.actor_type)}:${escapeHtml(log.actor_id)}</td><td>${escapeHtml(log.action)}</td><td>${escapeHtml(log.resource_type)} ${escapeHtml(log.resource_id)}</td><td>${escapeHtml(log.ip||'—')}</td></tr>`).join('')}</tbody></table></div>`:empty('尚无审计记录')}</section>`;
}

async function renderSecurity() {
  const data=await api('/api/admin/security');
  $('#content').innerHTML=`${pageHeader('超级管理员安全','系统仅允许一个超级管理员；账号变更会自动撤销其他会话和未使用的 SSO 票据。','<button class="secondary" data-action="security-edit">修改账号</button><button class="danger-button" data-action="security-revoke">退出其他设备</button>')}
    <div class="metric-grid"><article class="metric"><span>管理员账号</span><strong>${escapeHtml(data.admin.username)}</strong></article><article class="metric"><span>有效会话</span><strong>${data.sessions.length}</strong></article><article class="metric"><span>密码最近变更</span><strong class="small">${escapeHtml(formatTime(data.admin.password_changed_at))}</strong></article></div>
    <section class="panel"><div class="panel-header"><h3>已登录设备</h3></div><div class="table-wrap"><table><thead><tr><th>会话</th><th>来源 IP</th><th>客户端</th><th>最后活跃</th><th>过期时间</th></tr></thead><tbody>${data.sessions.map(item=>`<tr><td>${item.current?'<span class="badge online">当前设备</span>':'<span class="badge">其他设备</span>'}</td><td>${escapeHtml(item.ip||'—')}</td><td class="session-client" title="${escapeHtml(item.user_agent||'')}">${escapeHtml(item.user_agent||'未记录')}</td><td>${formatTime(item.last_seen_at)}</td><td>${formatTime(item.expires_at)}</td></tr>`).join('')}</tbody></table></div></section>`;
}

const renderers={dashboard:renderDashboard,sites:renderSites,groups:renderGroups,nodes:renderNodes,ads:renderAds,publish:renderPublish,jobs:renderJobs,audit:renderAudit,security:renderSecurity};
async function navigate(view,{focusTitle=true}={}){clearTimeout(state.jobsTimer);state.jobsTimer=null;state.view=renderers[view]?view:'dashboard';const pageTitle=$('#pageTitle');pageTitle.textContent=titles[state.view];$('#navCurrentLabel').textContent=titles[state.view];document.querySelectorAll('#mainNav button').forEach(button=>button.setAttribute('aria-current',button.dataset.view===state.view?'page':'false'));location.hash=state.view;$('#content').innerHTML=empty('正在加载…');try{await renderers[state.view]();}catch(error){$('#content').innerHTML=empty(error.message);toast(error.message);}if(focusTitle)pageTitle.focus({preventScroll:true});$('.sidebar').classList.remove('open');$('#navToggle').setAttribute('aria-expanded','false');}

function checkboxes(name, selected, items) { const set=new Set((selected||[]).map(Number)); return `<div class="choice-grid">${items.length?items.map(item=>`<label><input type="checkbox" name="${name}" value="${item.id}" ${set.has(Number(item.id))?'checked':''}>${escapeHtml(item.name)}</label>`).join(''):'<span class="muted">暂无可选项</span>'}</div>`; }
function scopeFields(item={}){return `<label>投放范围<select name="scope_mode"><option value="global" ${item.scope_mode!=='selected'?'selected':''}>全部站点</option><option value="selected" ${item.scope_mode==='selected'?'selected':''}>指定站点或分组</option></select></label><div class="span-2"><label>指定站点</label>${checkboxes('site_ids',item.site_ids,state.sites)}</div><div class="span-2"><label>指定分组</label>${checkboxes('group_ids',item.group_ids,state.groups)}</div>`;}

function normalizeModalMarkup(body){return body.replaceAll('[a-z0-9-]','[a-z0-9\\x2d]').replaceAll('[A-Za-z0-9_.-]','[A-Za-z0-9_.\\x2d]');}
function openModal(title, body, onSubmit, eyebrow='CONFIGURATION'){
  $('#modalTitle').textContent=title;$('#modalEyebrow').textContent=eyebrow;$('#modalBody').innerHTML=normalizeModalMarkup(body);const dialog=$('#modal');const form=dialog.querySelector('form');const errorBox=$('#modalError');errorBox.hidden=true;dialog.querySelectorAll('[value="cancel"]').forEach(button=>{button.type='button';button.dataset.modalClose='';});dialog.querySelectorAll('[data-modal-close]').forEach(button=>{button.onclick=()=>dialog.close();});form.onsubmit=async event=>{event.preventDefault();const submitter=event.submitter;if(!submitter)return;submitter.disabled=true;errorBox.hidden=true;try{const outcome=await onSubmit(new FormData(form));dialog.close();toast(outcome?.message||'保存成功');if(outcome?.refresh!==false)await navigate(state.view);outcome?.after?.();}catch(error){errorBox.textContent=error.message;errorBox.hidden=false;errorBox.focus();toast(error.message);submitter.disabled=false;}};dialog.showModal();setTimeout(()=>dialog.querySelector('input,select,textarea')?.focus(),0);
}
function bool(data,name){return data.get(name)==='on';} function ids(data,name){return data.getAll(name).map(Number);}

async function siteForm(item={}){openModal(item.id?'编辑导航站':'新增导航站',`<div class="form-grid"><label>站点名称<input name="name" value="${escapeHtml(item.name||'')}" required maxlength="100"></label><label>站点标识<input name="slug" value="${escapeHtml(item.slug||'')}" pattern="[a-z0-9][a-z0-9-]{1,62}" required></label><label class="span-2">前台地址<input name="public_url" type="url" value="${escapeHtml(item.public_url||'')}" required></label><label class="span-2">后台地址<input name="admin_url" type="url" value="${escapeHtml(item.admin_url||'')}" required></label><label class="checkbox-line span-2"><input name="enabled" type="checkbox" ${item.enabled!==false?'checked':''}>启用站点</label></div><div class="modal-actions"><button class="ghost" value="cancel">取消</button><button class="primary" value="save">保存</button></div>`,async data=>{const payload={name:data.get('name'),slug:data.get('slug'),public_url:data.get('public_url'),admin_url:data.get('admin_url'),enabled:bool(data,'enabled')};const result=await api(item.id?`/api/admin/sites/${item.id}`:'/api/admin/sites',{method:item.id?'PUT':'POST',body:payload});if(result?.credential)return{refresh:false,after:()=>credentialModal(result.credential)};return{};});}
function credentialModal(value){openModal('请立即保存站点凭据',`<p class="muted">总后台不会再次显示完整凭据。把它配置到该导航站的 Agent 环境变量中。</p><div class="credential">${escapeHtml(value)}</div><div class="modal-actions"><button type="button" class="secondary" data-copy="${escapeHtml(value)}">复制凭据</button><button value="save" class="primary">我已保存</button></div>`,async()=>({message:'凭据已确认保存'}),'ONE-TIME SECRET');}
async function policyForm(siteId){const items=await api(`/api/admin/sites/${siteId}/ad-policies`);const policies=Object.fromEntries(items.map(item=>[item.slot,item.policy]));const options=[['central_only','仅中央广告'],['central_first','中央优先，其后本地'],['mixed','中央与本地混合排序'],['local_only','仅本地广告']];openModal('配置单站广告策略',`<p class="muted">每个广告位独立决定中央广告与该导航站本地广告的关系。“混合排序”会按两端的优先级统一排序。</p><div class="form-grid">${Object.entries(adSlotLabels).map(([slot,label])=>`<label>${label}<select name="${slot}">${options.map(([value,text])=>`<option value="${value}" ${(policies[slot]||'central_first')===value?'selected':''}>${text}</option>`).join('')}</select></label>`).join('')}</div><div class="modal-actions"><button class="ghost" value="cancel">取消</button><button class="primary" value="save">保存策略</button></div>`,data=>api(`/api/admin/sites/${siteId}/ad-policies`,{method:'PUT',body:{policies:Object.keys(adSlotLabels).map(slot=>({slot,policy:data.get(slot)}))}}));}
async function groupForm(item={}){await ensureTaxonomy();openModal(item.id?'编辑站点分组':'新增站点分组',`<div class="form-grid"><label>分组名称<input name="name" value="${escapeHtml(item.name||'')}" required></label><label>分组标识<input name="slug" value="${escapeHtml(item.slug||'')}" pattern="[a-z0-9][a-z0-9-]{1,62}" required></label><div class="span-2"><label>成员站点</label>${checkboxes('site_ids',item.site_ids,state.sites)}</div></div><div class="modal-actions"><button class="ghost" value="cancel">取消</button><button class="primary" value="save">保存</button></div>`,data=>api(item.id?`/api/admin/groups/${item.id}`:'/api/admin/groups',{method:item.id?'PUT':'POST',body:{name:data.get('name'),slug:data.get('slug'),site_ids:ids(data,'site_ids')}}));}
async function nodeForm(item={}){await ensureTaxonomy();openModal(item.id?'编辑节点':'新增节点',`<div class="form-grid"><label>测速名称<input name="speed_name" value="${escapeHtml(item.speed_name||'')}" required maxlength="80"></label><label>展示名称<input name="partner_name" value="${escapeHtml(item.partner_name||'')}" required maxlength="80"></label><label class="span-2">节点地址<input name="url" type="url" value="${escapeHtml(item.url||'')}" required maxlength="2048"></label><label>排序权重 <span class="muted">数值越大越靠前</span><input name="sort_order" type="number" min="-1000000" max="1000000" step="1" value="${Number(item.sort_order||0)}"></label>${scopeFields(item)}<label class="checkbox-line span-2"><input name="enabled" type="checkbox" ${item.enabled!==false?'checked':''}>启用节点</label></div><div class="modal-actions"><button class="ghost" value="cancel">取消</button><button class="primary" value="save">保存</button></div>`,data=>api(item.id?`/api/admin/nodes/${item.id}`:'/api/admin/nodes',{method:item.id?'PUT':'POST',body:{speed_name:data.get('speed_name'),partner_name:data.get('partner_name'),url:data.get('url'),sort_order:Number(data.get('sort_order')||0),scope_mode:data.get('scope_mode'),site_ids:ids(data,'site_ids'),group_ids:ids(data,'group_ids'),enabled:bool(data,'enabled')}}));}
async function adForm(item={}){await ensureTaxonomy();openModal(item.id?'编辑广告':'新增广告',`<div class="form-grid"><label>命名空间<input name="namespace" value="${escapeHtml(item.namespace||'central:')}" required maxlength="120"></label><label>标题<input name="title" value="${escapeHtml(item.title||'')}" required maxlength="120"></label><label>类型<select name="ad_type"><option value="normal" ${item.ad_type!=='code'?'selected':''}>普通图片</option><option value="code" ${item.ad_type==='code'?'selected':''}>联盟代码</option></select></label><label>位置<select name="ad_position">${Object.keys(adSlotLabels).map(value=>`<option value="${value}" ${item.ad_position===value?'selected':''}>${escapeHtml(adSlotLabels[value])}</option>`).join('')}</select></label><label>平台<select name="platform">${['all','pc','ios','non_ios','android','harmony'].map(value=>`<option ${item.platform===value?'selected':''}>${value}</option>`).join('')}</select></label><label>优先级 <span class="muted">数值越大越靠前</span><input name="priority" type="number" min="-1000000" max="1000000" step="1" value="${Number(item.priority||0)}"></label><label class="span-2">图片地址<input name="image_url" type="url" maxlength="2048" value="${escapeHtml(item.image_url||'')}"></label><label class="span-2">跳转地址<input name="target_url" type="url" maxlength="2048" value="${escapeHtml(item.target_url||'')}"></label><label class="span-2">广告说明<textarea name="description" maxlength="500">${escapeHtml(item.description||'')}</textarea></label><label class="span-2">联盟代码（原文保存，不进行改写）<textarea name="ad_code">${escapeHtml(item.ad_code||'')}</textarea></label>${scopeFields(item)}<label class="checkbox-line span-2"><input name="enabled" type="checkbox" ${item.enabled!==false?'checked':''}>启用广告</label></div><div class="modal-actions"><button class="ghost" value="cancel">取消</button><button class="primary" value="save">保存</button></div>`,data=>api(item.id?`/api/admin/ads/${item.id}`:'/api/admin/ads',{method:item.id?'PUT':'POST',body:{namespace:data.get('namespace'),title:data.get('title'),ad_type:data.get('ad_type'),ad_position:data.get('ad_position'),platform:data.get('platform'),priority:Number(data.get('priority')),image_url:data.get('image_url'),target_url:data.get('target_url'),description:data.get('description'),ad_code:data.get('ad_code'),scope_mode:data.get('scope_mode'),site_ids:ids(data,'site_ids'),group_ids:ids(data,'group_ids'),enabled:bool(data,'enabled')}}));}
async function publishForm(siteId){const item=await api(`/api/admin/sites/${siteId}/publish`),page=item.payload||{};openModal('配置永久发布页',`<p class="muted">启用 npm 后，总后台会把与 Cloudflare、GitHub Pages 相同的完整页面发布到 npm CDN，不是跳转页。三个页面均可独立访问，不依赖总后台在线。</p><div class="form-grid"><label class="span-2">自定义永久发布域名<input name="permanent_url" type="url" value="${escapeHtml(item.permanent_url||'')}" placeholder="https://go.example.com" required></label><label class="span-2">GitHub Pages 完整发布页<input name="github_pages_url" type="url" value="${escapeHtml(item.github_pages_url||'')}" placeholder="https://owner.github.io/repository/" required></label><label>GitHub 仓库<input name="github_repo" value="${escapeHtml(item.github_repo||'')}" placeholder="owner/repository" pattern="[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"></label><label>Cloudflare 项目<input name="cloudflare_project" value="${escapeHtml(item.cloudflare_project||'')}" placeholder="publish-project" pattern="[a-z0-9][a-z0-9-]{0,62}"></label><label class="checkbox-line span-2"><input name="npm_enabled" type="checkbox" ${item.npm_enabled?'checked':''}>启用 npm CDN 完整发布页</label><label class="span-2">npm 包名<input name="npm_package_name" value="${escapeHtml(item.npm_package_name||'')}" placeholder="link-status-page" pattern="(?:@[a-z0-9][a-z0-9._-]{0,63}/)?[a-z0-9][a-z0-9._-]{0,119}"></label><label class="span-2">防失联邮箱<input name="contact_email" type="email" value="${escapeHtml(item.contact_email||'')}" placeholder="admin@example.com"></label><label class="span-2">Logo 地址<input name="logo_url" type="url" value="${escapeHtml(page.logo_url||'')}" placeholder="https://example.com/logo.png"></label><label class="span-2">页面标题<input name="page_title" maxlength="120" value="${escapeHtml(page.page_title||'')}" placeholder="留空时使用“网站名称永久发布页”"></label><label class="span-2">页面说明<textarea name="description" maxlength="300" placeholder="说明页面用途和收藏建议">${escapeHtml(page.description||'')}</textarea></label><label class="span-2">临时公告<textarea name="announcement" maxlength="300" placeholder="可留空，例如域名变更或维护通知">${escapeHtml(page.announcement||'')}</textarea></label></div><div class="modal-actions"><button class="ghost" value="cancel">取消</button><button class="primary" value="save">保存配置</button></div>`,data=>api(`/api/admin/sites/${siteId}/publish`,{method:'PUT',body:{permanent_url:data.get('permanent_url'),github_pages_url:data.get('github_pages_url'),github_repo:data.get('github_repo'),cloudflare_project:data.get('cloudflare_project'),npm_enabled:bool(data,'npm_enabled'),npm_package_name:data.get('npm_package_name'),contact_email:data.get('contact_email'),payload:{logo_url:data.get('logo_url'),page_title:data.get('page_title'),description:data.get('description'),announcement:data.get('announcement'),entries:Array.isArray(page.entries)?page.entries:[]}}}));}
function securityForm(){openModal('修改超级管理员',`<p class="muted">保存后会退出其他设备，当前设备继续保持登录。</p><div class="form-grid"><label class="span-2">管理员用户名<input name="username" value="${escapeHtml(state.user.username)}" required minlength="3" maxlength="64" autocomplete="username"></label><label class="span-2">当前密码<input name="current_password" type="password" required autocomplete="current-password"></label><label>新密码（不修改可留空）<input name="new_password" type="password" minlength="12" maxlength="200" autocomplete="new-password"></label><label>确认新密码<input name="confirm_password" type="password" minlength="12" maxlength="200" autocomplete="new-password"></label></div><div class="modal-actions"><button class="ghost" value="cancel">取消</button><button class="primary" value="save">保存账号</button></div>`,async data=>{const next=String(data.get('new_password')||'');if(next!==String(data.get('confirm_password')||''))throw new Error('两次输入的新密码不一致');const result=await api('/api/admin/security/account',{method:'PUT',body:{username:data.get('username'),current_password:data.get('current_password'),new_password:next}});state.user=result.user;state.csrf=result.csrf_token;$('#currentUser').textContent=state.user.username;return{message:'超级管理员账号已更新'};});}

document.addEventListener('click',async event=>{const button=event.target.closest('button');if(!button)return;if(button.dataset.view){navigate(button.dataset.view);return;}if(button.dataset.viewJump){navigate(button.dataset.viewJump);return;}if(button.dataset.copy){await navigator.clipboard.writeText(button.dataset.copy);toast('已复制');return;}const action=button.dataset.action,id=Number(button.dataset.id);let loginWindow=null;try{if(action==='site-new')siteForm();if(action==='site-edit')siteForm(state.sites.find(x=>Number(x.id)===id));if(action==='site-policy'||action==='ad-site-policy')policyForm(id);if(action==='ad-site-preview')await previewSiteAds(id);if(action==='site-enter'){loginWindow=window.open('about:blank','_blank');if(loginWindow)loginWindow.opener=null;const result=await api(`/api/admin/sites/${id}/sso-ticket`,{method:'POST'});if(loginWindow)loginWindow.location.replace(result.url);else window.location.assign(result.url);}if(action==='site-rotate'){if(confirm('旧凭据会立即失效，确定轮换吗？'))credentialModal((await api(`/api/admin/sites/${id}/rotate-secret`,{method:'POST'})).credential);}if(action==='group-new')groupForm();if(action==='group-edit')groupForm(state.groups.find(x=>Number(x.id)===id));if(action==='node-new')nodeForm();if(action==='node-edit')nodeForm(state.nodes.find(x=>Number(x.id)===id));if(action==='node-delete'&&confirm('确定删除这个节点吗？')){await api(`/api/admin/nodes/${id}`,{method:'DELETE'});toast('节点已删除');navigate('nodes');}if(action==='ad-new')adForm();if(action==='ad-edit')adForm(state.ads.find(x=>Number(x.id)===id));if(action==='ad-delete'&&confirm('确定删除这个广告吗？')){await api(`/api/admin/ads/${id}`,{method:'DELETE'});toast('广告已删除');navigate('ads');}if(action==='publish-preview')window.open(`/api/admin/sites/${id}/publish/preview`,'_blank','noopener');if(action==='publish-history')await publishHistory(id);if(action==='publish-edit')publishForm(id);if(action==='publish-queue'){await api(`/api/admin/sites/${id}/publish/jobs`,{method:'POST'});toast('任务已加入队列');navigate('publish');}if(action==='publish-retry'){await api(`/api/admin/jobs/${id}/retry`,{method:'POST'});$('#modal').close();toast('失败平台已重新加入队列');navigate('publish');}if(action==='jobs-refresh')await navigate('jobs');if(action==='alert-test'){await api('/api/admin/alerts/test',{method:'POST'});toast('告警测试已加入队列');await navigate('jobs');}if(action==='job-retry'){await api(`/api/admin/jobs/${id}/retry`,{method:'POST'});toast('任务已重新加入队列');navigate('jobs');}if(action==='job-cancel'&&confirm('确定取消这个尚未开始的任务吗？')){await api(`/api/admin/jobs/${id}/cancel`,{method:'POST'});toast('任务已取消');navigate('jobs');}if(action==='security-edit')securityForm();if(action==='security-revoke'&&confirm('确定退出除当前设备外的所有管理会话吗？')){const result=await api('/api/admin/security/revoke-sessions',{method:'POST'});toast(`已退出 ${result.sessions_revoked} 个其他会话`);navigate('security');}}catch(error){if(loginWindow&&!loginWindow.closed)loginWindow.close();toast(error.message);}});
$('#navToggle').addEventListener('click',()=>{const nav=$('#mainNav');const open=nav.classList.toggle('open');$('#navToggle').setAttribute('aria-expanded',String(open));});
$('#loginForm').addEventListener('submit',async event=>{event.preventDefault();const button=event.submitter,error=$('#loginError');button.disabled=true;error.hidden=true;try{const form=new FormData(event.currentTarget);const result=await api('/api/auth/login',{method:'POST',body:{username:form.get('username'),password:form.get('password')}});state.user=result.user;state.csrf=result.csrf_token;showApp();navigate(location.hash.slice(1)||'dashboard');}catch(err){error.textContent=err.message;error.hidden=false;}finally{button.disabled=false;}});
$('#logoutButton').addEventListener('click',async()=>{try{await api('/api/auth/logout',{method:'POST'});}finally{showLogin();}});
window.addEventListener('hashchange',()=>{const view=location.hash.slice(1);if(state.user&&view!==state.view)navigate(view);});

(async()=>{try{const result=await api('/api/auth/me');state.user=result.user;state.csrf=result.csrf_token;showApp();await navigate(location.hash.slice(1)||'dashboard',{focusTitle:false});}catch{showLogin();}})();
