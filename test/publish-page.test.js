'use strict';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1/test';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { renderPublishPage, renderPublishBundle, normalizeEntries } = require('../packages/publish-page-template/render');
const { parsePublishPayload } = require('../src/services/controlService');

test('发布页同时展示自定义域名与 GitHub Pages 地址', () => {
  const html = renderPublishPage({ siteName: '测试站', permanentUrl: 'https://publish.example.com', githubPagesUrl: 'https://owner.github.io/site/', entries: [{ name: '主入口', url: 'https://site.example.com' }] });
  assert.match(html, /https:\/\/publish\.example\.com/);
  assert.match(html, /https:\/\/owner\.github\.io\/site\//);
  assert.doesNotMatch(html, /pages\.dev/);
});

test('发布页转义站点提供的文本', () => {
  const html = renderPublishPage({ siteName: '<script>alert(1)</script>', announcement: '<img src=x onerror=alert(2)>', logoUrl: 'javascript:alert(3)', permanentUrl: 'https://example.com', githubPagesUrl: 'https://owner.github.io/repo/' });
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /javascript:alert/);
  assert.match(html, /&lt;script&gt;/);
});

test('发布页过滤危险协议和重复入口', () => {
  const entries = normalizeEntries([
    { name: '主站', url: 'https://site.example.com' },
    { name: '重复', url: 'https://site.example.com/' },
    { name: '危险', url: 'javascript:alert(1)' },
    { name: '备用', url: 'http://backup.example.com' }
  ]);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(item => item.name), ['主站', '备用']);
});

test('发布页静态包可独立部署且包含完整性清单', () => {
  const bundle = renderPublishBundle({
    siteName: '小星星爱导航',
    permanentUrl: 'https://go.example.com/',
    githubPagesUrl: 'https://owner.github.io/publish/',
    contactEmail: 'admin@example.com',
    entries: [{ name: '主站', url: 'https://site.example.com' }],
    generatedAt: '2026-09-11T02:00:00.000Z'
  });
  assert.deepEqual(Object.keys(bundle).sort(), ['.nojekyll', '404.html', '_headers', 'index.html', 'publish-manifest.json'].sort());
  assert.equal(bundle['404.html'], bundle['index.html']);
  assert.match(bundle['index.html'], /复制邮箱/);
  assert.match(bundle['index.html'], /new URL\('\/.well-known\/route-health\.gif',card\.dataset\.url\)/);
  assert.match(bundle['index.html'], /new Image\(\)/);
  assert.match(bundle['index.html'], /image\.naturalWidth===1&&image\.naturalHeight===1/);
  assert.match(bundle['index.html'], /setTimeout\(\(\)=>finish\(false,'timeout'\),5000\)/);
  assert.doesNotMatch(bundle['index.html'], /fetch\(healthUrl/);
  assert.doesNotMatch(bundle['index.html'], /mode:'no-cors'/);
  assert.match(bundle['index.html'], /跳到主要内容/);
  assert.doesNotMatch(bundle['index.html'], /<script[^>]+src=/);
  assert.doesNotMatch(bundle['index.html'], /<link[^>]+stylesheet/);
  assert.match(bundle['index.html'], /rel="icon" href="data:image\/svg\+xml/);
  const metaCsp = bundle['index.html'].match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  assert.doesNotMatch(metaCsp, /frame-ancestors/);
  assert.match(bundle['_headers'], /frame-ancestors 'none'/);
  const manifest = JSON.parse(bundle['publish-manifest.json']);
  assert.equal(manifest.sha256, crypto.createHash('sha256').update(bundle['index.html']).digest('hex'));
  assert.equal(manifest.addresses.github_pages, 'https://owner.github.io/publish/');
});

test('发布页后台配置只保留受支持字段并校验地址', () => {
  const payload = parsePublishPayload({
    page_title: '自定义标题',
    description: '页面说明',
    announcement: '维护公告',
    logo_url: 'https://cdn.example.com/logo.png',
    ignored_secret: '不能保存',
    entries: [{ name: '入口', url: 'https://site.example.com', note: '主线路', official: true }]
  });
  assert.equal(payload.logo_url, 'https://cdn.example.com/logo.png');
  assert.equal(payload.entries.length, 1);
  assert.equal(payload.ignored_secret, undefined);
  assert.throws(() => parsePublishPayload({ logo_url: 'javascript:alert(1)' }), /Logo 地址/);
});
