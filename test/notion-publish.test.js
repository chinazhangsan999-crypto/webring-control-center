'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePageId, normalizePublicUrl, buildManagedBlocks, syncNotionPage } = require('../src/services/notionPublishService');

test('Notion 页面 ID 和公开地址只接受安全格式', () => {
  assert.equal(normalizePageId('01234567-89ab-cdef-0123-456789abcdef'), '0123456789abcdef0123456789abcdef');
  assert.equal(normalizePageId('bad-id'), '');
  assert.equal(normalizePublicUrl('https://workspace.notion.site/publish'), 'https://workspace.notion.site/publish');
  assert.equal(normalizePublicUrl('https://example.com/publish'), '');
});

test('Notion 同步只写入受控区块并保留可点击入口', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if (String(url).endsWith('/pages/0123456789abcdef0123456789abcdef')) return new Response(JSON.stringify({ id: 'page' }), { status: 200 });
    if (String(url).includes('/blocks/old-block')) return new Response(JSON.stringify({ id: 'old-block' }), { status: 200 });
    if (String(url).includes('/children')) return new Response(JSON.stringify({ results: [{ id: 'new-block' }] }), { status: 200 });
    throw new Error(`未覆盖请求：${url}`);
  };
  const npmPageUrls = [
    { provider: 'unpkg', page_entry: true, entry_primary: true, url: 'https://unpkg.com/link-status-page@latest/index.html' },
    { provider: 'esm', page_entry: true, entry_primary: false, url: 'https://esm.sh/link-status-page@latest/index.html' }
  ];
  const result = await syncNotionPage({ token: 'secret', pageId: '0123456789abcdef0123456789abcdef', publicUrl: 'https://workspace.notion.site/publish', previousBlockId: 'old-block', siteName: '测试站', permanentUrl: 'https://go.example.com/', githubPagesUrl: 'https://owner.github.io/site/', npmPageUrls, entries: [{ name: '主站', url: 'https://site.example.com/' }], sha256: 'a'.repeat(64) }, { fetchImpl });
  assert.equal(result.sync_block_id, 'new-block');
  assert.equal(calls.filter(item => item.method === 'PATCH').length, 2);
  assert.match(JSON.stringify(calls.at(-1).body), /最新访问入口/);
  assert.match(JSON.stringify(calls.at(-1).body), /npm 网页入口/);
  assert.match(JSON.stringify(calls.at(-1).body), /esm\.sh 网页入口/);
  assert.match(JSON.stringify(calls.at(-1).body), /https:\/\/esm\.sh\/link-status-page@latest\/index\.html/);
  assert.match(JSON.stringify(buildManagedBlocks({ siteName: '测试站', entries: [{ name: '主站', url: 'https://site.example.com' }] })), /site\.example\.com/);
});
