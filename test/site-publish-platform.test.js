'use strict';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1/test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMode, normalizePlatformSettings, bindingsMatch } = require('../src/services/sitePublishPlatformService');

test('账号模式只接受 disabled、global、site', () => {
  assert.equal(normalizeMode('disabled'), 'disabled');
  assert.equal(normalizeMode('global'), 'global');
  assert.equal(normalizeMode('site'), 'site');
  assert.equal(normalizeMode('fallback'), 'disabled');
});

test('独立 npm 设置保留安全线路并确保主入口可打开网页', () => {
  const settings = normalizePlatformSettings('npm', { lines: ['npmmirror', 'esm', 'invalid'], primary: 'npmmirror' });
  assert.deepEqual(settings.lines, ['npmmirror', 'esm']);
  assert.equal(settings.primary, 'esm');
});

test('任务绑定只有账号模式与配置版本完全一致时才允许重试', () => {
  const expected = Object.fromEntries(['cloudflare', 'github', 'npm', 'notion'].map(platform => [platform, { mode: 'global', config_version: 2, config_key: 'same-global-config' }]));
  assert.equal(bindingsMatch(expected, structuredClone(expected)), true);
  const changed = structuredClone(expected);
  changed.github.mode = 'site';
  assert.equal(bindingsMatch(expected, changed), false);
  changed.github.mode = 'global';
  changed.notion.config_version = 3;
  assert.equal(bindingsMatch(expected, changed), false);
  changed.notion.config_version = 2;
  changed.npm.config_key = 'changed-global-config';
  assert.equal(bindingsMatch(expected, changed), false);
});
