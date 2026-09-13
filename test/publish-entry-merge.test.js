'use strict';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1/test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { publishEntries } = require('../src/services/jobWorker');
const { normalizeEntries, renderPublishPage } = require('../packages/publish-page-template/render');

test('永久发布页合并主站、启用的统一节点和手工补充入口', () => {
  const entries = normalizeEntries(publishEntries({
    name: '示例导航',
    public_url: 'https://site.example.com',
    payload: {
      entries: [
        { name: '旧主站入口', url: 'https://site.example.com/', official: true },
        { name: '手工备用', url: 'https://manual.example.com' }
      ]
    }
  }, [
    { speed_name: '统一节点', partner_name: '线路一', url: 'https://node.example.com', enabled: true },
    { speed_name: '停用节点', partner_name: '线路二', url: 'https://disabled.example.com', enabled: false }
  ]));

  assert.deepEqual(entries.map(entry => entry.name), ['主站官方入口', '统一节点', '手工备用']);
  assert.deepEqual(entries.map(entry => entry.url), [
    'https://site.example.com/',
    'https://node.example.com/',
    'https://manual.example.com/'
  ]);
});

test('永久发布地址显示在线路列表之前且不重复显示收藏说明', () => {
  const html = renderPublishPage({
    siteName: '示例导航',
    permanentUrl: 'https://publish.example.com',
    githubPagesUrl: 'https://owner.github.io/publish/',
    entries: [{ name: '主站', url: 'https://site.example.com' }]
  });

  assert.ok(html.indexOf('aria-label="永久发布地址"') < html.indexOf('class="route-head"'));
  assert.match(html, /<section class="saved" aria-label="永久发布地址">/);
  assert.doesNotMatch(html, /请同时收藏这两个地址|任意一个地址可用时/);
});
