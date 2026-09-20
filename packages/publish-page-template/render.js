'use strict';

const crypto = require('node:crypto');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

function validHttpUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; }
}

function cleanText(value, fallback = '', max = 300) {
  const text = String(value || '').trim();
  return (text || fallback).slice(0, max);
}

function normalizeEntries(entries = []) {
  const seen = new Set();
  return entries.map((item, index) => ({
    name: cleanText(item?.name, `访问入口 ${index + 1}`, 80),
    url: validHttpUrl(item?.url),
    note: cleanText(item?.note, '', 160),
    official: item?.official === true,
    order: index
  })).filter(item => {
    if (!item.url || seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

function brandMark(siteName, logoUrl) {
  const logo = validHttpUrl(logoUrl);
  if (logo) return `<img class="brand-logo" src="${escapeHtml(logo)}" width="64" height="64" alt="${escapeHtml(siteName)} Logo" referrerpolicy="no-referrer">`;
  return '<span class="brand-logo brand-fallback" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 2.8l2.3 6.3 6.2 2.4-6.2 2.4-2.3 6.3-2.3-6.3-6.2-2.4 6.2-2.4L12 2.8z"/></svg></span>';
}

function entryCards(entries) {
  if (!entries.length) return '<p class="empty-state">当前没有可用入口。请先收藏上方发布地址，稍后再来查看。</p>';
  return entries.map((item, index) => `<article class="route" data-route data-url="${escapeHtml(item.url)}" data-order="${index}">
      <span class="route-line" aria-hidden="true"></span>
      <div class="route-copy"><div class="route-title"><h2>${escapeHtml(item.name)}</h2>${item.official ? '<span class="official">主站</span>' : ''}</div><p>${escapeHtml(item.note || '正在检查这条线路的访问状态。')}</p><span class="route-url">${escapeHtml(item.url)}</span></div>
      <div class="route-actions"><span class="route-status checking" data-status>待检查</span><a class="visit" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">打开入口</a></div>
    </article>`).join('');
}

function savedAddress(label, url) {
  const safe = validHttpUrl(url);
  if (!safe) return `<div class="saved-row unavailable"><div><strong>${escapeHtml(label)}</strong><span>尚未配置</span></div></div>`;
  return `<div class="saved-row"><div><strong>${escapeHtml(label)}</strong><a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(safe)}</a></div><button type="button" data-copy="${escapeHtml(safe)}">复制地址</button></div>`;
}

function renderPublishPage({ siteName, siteUrl = '', logoUrl = '', headline = '', description = '', announcement = '', permanentUrl, githubPagesUrl, notionPublicUrl = '', npmPageUrl = '', npmPageUrls = [], contactEmail = '', entries = [], generatedAt = new Date().toISOString() }) {
  const name = cleanText(siteName, '导航站', 100);
  const title = cleanText(headline, `${name}永久发布页`, 120);
  const summary = cleanText(description, '这里持续提供主站与备用线路。请收藏本页，网址变更时仍可找到最新入口。', 300);
  const notice = cleanText(announcement, '', 300);
  const contact = cleanText(contactEmail, '', 200);
  const routes = normalizeEntries(entries);
  const npmLines = Array.isArray(npmPageUrls) && npmPageUrls.length ? npmPageUrls : (npmPageUrl ? [{ label: 'npm 网页入口', url: npmPageUrl, page_entry: true, entry_primary: true }] : []);
  const npmAddresses = npmLines.filter(item => item.page_entry === true);
  const npmDistributionLines = npmLines.filter(item => item.page_entry !== true);
  const canonical = validHttpUrl(permanentUrl) || validHttpUrl(githubPagesUrl) || validHttpUrl(siteUrl);
  const generated = new Date(generatedAt);
  const generatedLabel = Number.isNaN(generated.valueOf()) ? '' : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short', hour12: false }).format(generated);
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="theme-color" content="#091426"><meta name="description" content="${escapeHtml(summary)}"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src http: https:; base-uri 'none'; form-action 'none'"><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 64 64%22%3E%3Crect width=%2264%22 height=%2264%22 rx=%2216%22 fill=%22%233568e8%22/%3E%3Cpath d=%22M32 12l5 15 15 5-15 5-5 15-5-15-15-5 15-5z%22 fill=%22white%22/%3E%3C/svg%3E">${canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}">` : ''}<title>${escapeHtml(title)}</title><style>
:root{color-scheme:light;font-family:"Segoe UI Variable","Microsoft YaHei UI","Microsoft YaHei",sans-serif;--ink:#091426;--muted:#5b687d;--paper:#f7f9fc;--surface:#fff;--line:#dce3ee;--blue:#3568e8;--blue-dark:#244fc0;--green:#16845b;--orange:#b45f06;--soft-blue:#edf3ff;--soft-orange:#fff4df}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;min-height:100dvh;color:var(--ink);background:linear-gradient(180deg,#eaf1ff 0,#f7f9fc 340px);font-size:16px}a{color:inherit}button,a{touch-action:manipulation}.skip-link{position:fixed;left:16px;top:12px;z-index:20;transform:translateY(-150%);padding:10px 14px;border-radius:8px;background:var(--ink);color:#fff}.skip-link:focus{transform:none}.shell{width:min(920px,calc(100% - 32px));margin:0 auto;padding:54px 0 42px}.hero{display:grid;grid-template-columns:72px minmax(0,1fr);gap:20px;align-items:center}.brand-logo{width:64px;height:64px;border-radius:18px;object-fit:cover;background:var(--blue);box-shadow:0 12px 28px rgba(53,104,232,.18)}.brand-fallback{display:grid;place-items:center}.brand-fallback svg{width:34px;fill:#fff}.hero h1{margin:0;font-size:clamp(30px,6vw,50px);line-height:1.12;letter-spacing:-.035em;text-wrap:balance}.hero p{max-width:680px;margin:10px 0 0;color:var(--muted);line-height:1.75}.notice{margin:28px 0 0;padding:14px 17px;border-left:4px solid var(--orange);background:var(--soft-orange);color:#74420c;line-height:1.65}.route-head{display:flex;align-items:end;justify-content:space-between;gap:16px;margin:34px 0 14px}.route-head h2,.saved h2{margin:0;font-size:21px}.route-head p{margin:0;color:var(--muted)}.routes{position:relative;border:1px solid var(--line);border-radius:20px;background:rgba(255,255,255,.94);overflow:hidden;box-shadow:0 18px 60px rgba(24,48,89,.08)}.route{position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:24px;padding:22px 22px 22px 42px;border-bottom:1px solid var(--line)}.route:last-child{border-bottom:0}.route-line{position:absolute;left:20px;top:0;bottom:0;width:2px;background:var(--line)}.route-line:after{content:"";position:absolute;top:31px;left:50%;width:10px;height:10px;border:3px solid var(--surface);border-radius:50%;background:var(--blue);transform:translateX(-50%);box-shadow:0 0 0 1px var(--blue)}.route-title{display:flex;align-items:center;gap:9px}.route h2{margin:0;font-size:18px}.official{padding:3px 7px;border-radius:999px;background:var(--soft-blue);color:var(--blue-dark);font-size:12px;font-weight:750}.route p{margin:6px 0;color:var(--muted);line-height:1.55}.route-url{display:block;color:#52617a;font-size:13px;overflow-wrap:anywhere}.route-actions{display:flex;align-items:center;gap:10px}.route-status{min-width:70px;color:var(--muted);font-size:13px;text-align:center}.route-status.online{color:var(--green);font-weight:750}.route-status.offline{color:var(--orange);font-weight:750}.visit,.saved-row button,.mail-link{min-height:44px;display:inline-flex;align-items:center;justify-content:center;padding:9px 15px;border:1px solid transparent;border-radius:11px;background:var(--blue);color:#fff;font-weight:750;text-decoration:none;cursor:pointer}.visit:hover,.saved-row button:hover,.mail-link:hover{background:var(--blue-dark)}.visit:focus-visible,.saved-row button:focus-visible,.mail-link:focus-visible,.saved-row a:focus-visible{outline:3px solid rgba(53,104,232,.38);outline-offset:3px}.empty-state{margin:0;padding:34px;color:var(--muted);text-align:center;line-height:1.7}.saved{margin:28px 0 0;padding:24px;border:2px solid var(--blue);border-radius:20px;background:linear-gradient(135deg,#fff 0,#edf3ff 100%);box-shadow:0 18px 44px rgba(36,79,192,.14)}.saved-intro{margin:8px 0 18px;color:#44536b;line-height:1.65}.saved-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;align-items:center;padding:15px 0;border-top:1px solid #cddafd}.saved-row div{min-width:0}.saved-row strong,.saved-row a,.saved-row span{display:block}.saved-row strong{margin-bottom:5px}.saved-row a{color:var(--blue-dark);font-weight:650;overflow-wrap:anywhere}.saved-row.unavailable span{color:var(--muted)}.package-lines{margin-top:18px;padding:15px 0 0;border-top:1px solid #cddafd}.package-lines strong{display:block}.package-lines p{margin:6px 0 0;color:var(--muted);font-size:14px;line-height:1.6}.contact{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-top:18px;padding:18px;border-radius:14px;background:var(--ink);color:#fff}.contact p{margin:4px 0 0;color:#bec9da;overflow-wrap:anywhere}.contact-actions{display:flex;gap:8px;flex:none}.mail-link,.contact-actions button{min-height:44px;display:inline-flex;align-items:center;justify-content:center;padding:9px 15px;border:1px solid transparent;border-radius:11px;background:#fff;color:var(--ink);font:inherit;font-weight:750;text-decoration:none;cursor:pointer}.mail-link:hover,.contact-actions button:hover{background:#edf3ff}.page-footer{display:flex;justify-content:space-between;gap:18px;margin-top:22px;color:var(--muted);font-size:13px}.page-footer p{margin:0}@media(max-width:650px){.shell{width:min(100% - 24px,920px);padding-top:32px}.hero{grid-template-columns:54px minmax(0,1fr);gap:14px}.brand-logo{width:52px;height:52px;border-radius:14px}.hero h1{font-size:30px}.route-head{display:block}.route-head p{margin-top:6px}.route{grid-template-columns:1fr;padding:20px 16px 20px 36px}.route-line{left:17px}.route-actions{justify-content:space-between}.visit{flex:1}.saved{padding:20px 16px}.saved-row{grid-template-columns:1fr}.saved-row button{width:100%}.contact{align-items:stretch;flex-direction:column}.contact-actions{display:grid;grid-template-columns:1fr 1fr}.mail-link,.contact-actions button{width:100%}.page-footer{display:block}.page-footer p+p{margin-top:5px}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*{transition:none!important}}
.saved>.saved-row:first-child{padding-top:0;border-top:0}
</style></head><body><a class="skip-link" href="#main">跳到主要内容</a><main id="main" class="shell"><header class="hero">${brandMark(name, logoUrl)}<div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(summary)}</p></div></header>${notice ? `<aside class="notice" aria-label="站点通知">${escapeHtml(notice)}</aside>` : ''}<section class="saved" aria-label="永久发布地址">${savedAddress('自定义永久发布域名', permanentUrl)}${savedAddress('GitHub Pages 发布地址', githubPagesUrl)}${savedAddress('Notion 公告发布页', notionPublicUrl)}${npmAddresses.map(item => savedAddress(`${item.entry_primary ? '主网页入口 · ' : ''}${cleanText(item.label || 'npm 网页入口', 'npm 网页入口', 80)}`, item.url)).join('')}${npmDistributionLines.length ? `<div class="package-lines"><strong>npm 包分发</strong><p>${npmDistributionLines.map(item => `${cleanText(item.label || item.provider, item.provider, 80)}：仅用于包分发，不作为网页入口`).join('；')}</p></div>` : ''}${contact ? `<div class="contact"><div><strong>防失联邮箱</strong><p>${escapeHtml(contact)}</p></div><div class="contact-actions"><button type="button" data-copy="${escapeHtml(contact)}">复制邮箱</button><a class="mail-link" href="mailto:${escapeHtml(contact)}">发送邮件</a></div></div>` : ''}</section><div class="route-head"><div><h2>选择访问入口</h2><p>页面打开后会在后台并行检查各条线路，不阻塞您直接访问。</p></div><p id="check-summary" role="status" aria-atomic="true">准备检查线路</p></div><section id="routes" class="routes" aria-label="可用访问入口">${entryCards(routes)}</section><footer class="page-footer"><p>${escapeHtml(name)} · 永久发布页</p>${generatedLabel ? `<p>更新于 ${escapeHtml(generatedLabel)}（北京时间）</p>` : ''}</footer></main><script>
(()=>{'use strict';const routes=[...document.querySelectorAll('[data-route]')],summary=document.querySelector('#check-summary'),container=document.querySelector('#routes');async function copy(value,button){try{await navigator.clipboard.writeText(value)}catch{const area=document.createElement('textarea');area.value=value;area.style.position='fixed';area.style.opacity='0';document.body.append(area);area.select();document.execCommand('copy');area.remove()}const old=button.textContent;button.textContent='已复制';setTimeout(()=>{button.textContent=old},1600)}function checkRoute(card,index){return new Promise(resolve=>{const status=card.querySelector('[data-status]'),probeUrl=new URL('/.well-known/route-health.gif',card.dataset.url),image=new Image(),started=performance.now();let finished=false;probeUrl.searchParams.set('_t',Date.now().toString());probeUrl.searchParams.set('_r',Math.random().toString(36).slice(2));function finish(ok,reason){if(finished)return;finished=true;clearTimeout(timer);const elapsed=Math.max(1,Math.round(performance.now()-started));status.textContent=ok?'正常':'检查超时';status.className='route-status '+(ok?'online':'offline');image.onload=null;image.onerror=null;resolve({card,ok,ms:ok?elapsed:999999,index,reason})}image.referrerPolicy='no-referrer';image.onload=()=>finish(image.naturalWidth===1&&image.naturalHeight===1,'invalid_image');image.onerror=()=>finish(false,'load_error');const timer=setTimeout(()=>finish(false,'timeout'),5000);image.src=probeUrl.href})}document.querySelectorAll('[data-copy]').forEach(button=>button.addEventListener('click',()=>copy(button.dataset.copy,button)));if(!routes.length){summary.textContent='当前无可检查线路';return}summary.textContent='正在检查 '+routes.length+' 条线路';Promise.all(routes.map(checkRoute)).then(results=>{results.sort((a,b)=>Number(b.ok)-Number(a.ok)||a.ms-b.ms||a.index-b.index).forEach(item=>container.append(item.card));const online=results.filter(item=>item.ok).length,timeouts=results.length-online;summary.textContent='访客线路检测完成：'+online+' 条正常，'+timeouts+' 条检查超时'})})();
</script></body></html>`;
}

function renderPublishBundle(options) {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const html = renderPublishPage({ ...options, generatedAt });
  const sha256 = crypto.createHash('sha256').update(html).digest('hex');
  const manifest = {
    format: 'webring-publish-page-v1',
    site: cleanText(options.siteName, '导航站', 100),
    generated_at: generatedAt,
    sha256,
    addresses: { permanent: validHttpUrl(options.permanentUrl), github_pages: validHttpUrl(options.githubPagesUrl), notion: validHttpUrl(options.notionPublicUrl), npm_cdn: validHttpUrl(options.npmPageUrl), npm_cdns: Array.isArray(options.npmPageUrls) ? options.npmPageUrls.map(item => ({ provider: cleanText(item.provider, '', 30), role: item.page_entry === true ? 'page' : 'package', url: validHttpUrl(item.url) })).filter(item => item.url) : [] }
  };
  const headers = `/*\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  Referrer-Policy: no-referrer\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n  Content-Security-Policy: default-src 'self'; img-src 'self' https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src http: https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\n`;
  return { 'index.html': html, '404.html': html, '.nojekyll': '', '_headers': headers, 'publish-manifest.json': `${JSON.stringify(manifest, null, 2)}\n` };
}

module.exports = { renderPublishPage, renderPublishBundle, validHttpUrl, normalizeEntries };
