'use strict';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2026-03-11';

class NotionPublishError extends Error {
  constructor(message, { retryable = true, status = 0 } = {}) {
    super(message);
    this.name = 'NotionPublishError';
    this.retryable = retryable;
    this.detail = { status };
  }
}

function normalizePageId(value) {
  const id = String(value || '').trim().replace(/-/g, '').toLowerCase();
  return /^[a-f0-9]{32}$/.test(id) ? id : '';
}

function normalizePublicUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    const hostname = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (hostname === 'notion.site' || hostname.endsWith('.notion.site') || hostname === 'notion.so' || hostname.endsWith('.notion.so')) ? url.href : '';
  } catch { return ''; }
}

function richText(content, href = '') {
  const text = String(content || '').slice(0, 1900);
  return { type: 'text', text: { content: text, ...(href ? { link: { url: href } } : {}) } };
}

function buildManagedBlocks({ siteName, permanentUrl, githubPagesUrl, npmPageUrl, npmPageUrls = [], entries = [], generatedAt, sha256 }) {
  const npmLinks = Array.isArray(npmPageUrls)
    ? npmPageUrls.filter(item => item?.page_entry === true && /^https:\/\//i.test(String(item.url || ''))).map(item => [
      item.provider === 'esm' ? 'esm.sh 网页入口' : item.provider === 'unpkg' ? 'npm 网页入口' : String(item.label || 'npm 网页入口').slice(0, 80),
      item.url
    ])
    : [];
  if (!npmLinks.length && /^https:\/\//i.test(String(npmPageUrl || ''))) npmLinks.push(['npm 网页入口', npmPageUrl]);
  const links = [
    ['自定义永久发布域名', permanentUrl],
    ['GitHub Pages 发布地址', githubPagesUrl],
    ...npmLinks
  ].filter(([, url]) => /^https:\/\//i.test(String(url || '')));
  const entryBlocks = entries.slice(0, 80).filter(item => /^https?:\/\//i.test(String(item?.url || ''))).map(item => ({
    object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [richText(`${String(item.name || '访问入口').slice(0, 120)}：`, ''), richText(String(item.url), String(item.url))] }
  }));
  return [{
    object: 'block', type: 'toggle', toggle: {
      rich_text: [richText(`最新访问入口 · ${String(sha256 || '').slice(0, 12) || '待生成'}`)],
      children: [
        { object: 'block', type: 'heading_2', heading_2: { rich_text: [richText(`${String(siteName || '导航站').slice(0, 100)} · 最新访问入口`)] } },
        ...links.map(([label, url]) => ({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [richText(`${label}：`), richText(url, url)] } })),
        { object: 'block', type: 'heading_3', heading_3: { rich_text: [richText('可用线路')] } },
        ...entryBlocks,
        { object: 'block', type: 'paragraph', paragraph: { rich_text: [richText(`同步时间：${generatedAt || new Date().toISOString()}（由总后台生成）`)] } }
      ]
    }
  }];
}

function headers(token) {
  if (!String(token || '').trim()) throw new NotionPublishError('缺少 Notion Integration Token', { retryable: false, status: 401 });
  return { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' };
}

async function request(fetchImpl, token, endpoint, options = {}) {
  const response = await fetchImpl(`${NOTION_API}${endpoint}`, { method: options.method || 'GET', headers: headers(token), body: options.body ? JSON.stringify(options.body) : undefined, signal: AbortSignal.timeout(20_000) });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
  if (!response.ok) throw new NotionPublishError(String(data?.message || raw || `HTTP ${response.status}`).slice(0, 500), { retryable: response.status === 429 || response.status >= 500, status: response.status });
  return data;
}

async function verifyNotionConnection({ token, pageId }, dependencies = {}) {
  const id = normalizePageId(pageId);
  if (!id) throw new NotionPublishError('Notion 页面 ID 必须是 32 位十六进制字符', { retryable: false });
  const page = await request(dependencies.fetchImpl || fetch, token, `/pages/${id}`);
  return { page_id: id, title: page?.url || '', message: 'Notion Integration 已获得该页面访问权限' };
}

async function verifyNotionToken({ token }, dependencies = {}) {
  const user = await request(dependencies.fetchImpl || fetch, token, '/users/me');
  return { account: user?.name || user?.bot?.owner?.workspace_name || '', message: 'Notion Integration Token 有效' };
}

async function syncNotionPage(input, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || fetch;
  const pageId = normalizePageId(input.pageId);
  if (!pageId) throw new NotionPublishError('Notion 页面 ID 必须是 32 位十六进制字符', { retryable: false });
  const publicUrl = normalizePublicUrl(input.publicUrl);
  if (!publicUrl) throw new NotionPublishError('Notion 公开地址必须是 https://*.notion.site 或 https://*.notion.so', { retryable: false });
  await request(fetchImpl, input.token, `/pages/${pageId}`);
  if (input.previousBlockId) {
    try { await request(fetchImpl, input.token, `/blocks/${encodeURIComponent(input.previousBlockId)}`, { method: 'PATCH', body: { in_trash: true } }); }
    catch (error) { if (error?.detail?.status !== 404) throw error; }
  }
  const created = await request(fetchImpl, input.token, `/blocks/${pageId}/children`, { method: 'PATCH', body: { children: buildManagedBlocks(input) } });
  const blockId = created?.results?.[0]?.id;
  if (!blockId) throw new NotionPublishError('Notion 未返回自动同步区块编号');
  return { page_id: pageId, public_url: publicUrl, sync_block_id: blockId, status: 'succeeded', finished_at: new Date().toISOString() };
}

module.exports = { NOTION_API, NOTION_VERSION, NotionPublishError, normalizePageId, normalizePublicUrl, buildManagedBlocks, verifyNotionToken, verifyNotionConnection, syncNotionPage };
