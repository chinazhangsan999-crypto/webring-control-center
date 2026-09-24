'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
const { publishPageLinks } = require('../src/services/controlService');
const { validateConfigSnapshot, ProtocolError } = require('../packages/shared-protocol');

test('总后台只向对应导航站下发五类可打开的永久发布页', () => {
  const publish = {
    permanent_url: 'https://permanent.example/',
    github_repo_name: 'site',
    github_pages_url: 'https://owner.github.io/site/',
    notion_enabled: true,
    notion_public_url: 'https://workspace.notion.site/page',
    npm_enabled: true,
    npm_package_name: 'publish-example',
    npm_cdn_mode: 'inherit',
    npm_cdn_lines: [],
    npm_primary_cdn: '',
    publish_link_weights: { cloudflare: 900, github: 800, notion: 700, 'npm:unpkg': 600, 'npm:esm': 500 }
  };
  const accounts = {
    cloudflare: { mode: 'global' }, github: { mode: 'global', settings: {} }, notion: { mode: 'global' }, npm: { mode: 'global' }
  };
  const settings = { github: { username: 'owner' }, npm: { lines: ['npmmirror', 'jsdelivr', 'unpkg', 'esm'], primary: 'unpkg' } };
  const pages = publishPageLinks(publish, accounts, settings);

  assert.deepEqual(pages.map(item => item.id), ['cloudflare', 'github', 'notion', 'npm:unpkg', 'npm:esm']);
  assert.deepEqual(pages.map(item => item.sort_weight), [900, 800, 700, 600, 500]);
  assert.equal(pages.some(item => /jsdelivr|npmmirror/.test(item.id)), false);
});

test('配置协议接受发布页列表并拒绝重复标识', () => {
  const snapshot = {
    protocol_version: '1.0', site_id: '1', revision: '1-1-1',
    revisions: { nodes_revision: '1', ads_revision: '1', publish_revision: '1' },
    nodes: [], ads: [], ad_policies: [],
    publish: {
      permanent_url: '', github_pages_url: '',
      pages: [{ id: 'github', label: 'GitHub Pages', url: 'https://owner.github.io/site/', enabled: true, sort_order: 20, sort_weight: 400 }]
    }
  };
  assert.equal(validateConfigSnapshot(snapshot), snapshot);
  assert.throws(() => validateConfigSnapshot({ ...snapshot, publish: { ...snapshot.publish, pages: [...snapshot.publish.pages, { ...snapshot.publish.pages[0] }] } }), ProtocolError);
});
