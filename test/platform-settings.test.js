'use strict';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1/test';
process.env.SETTINGS_ENCRYPTION_KEY = 'test-settings-encryption-key';
const test = require('node:test');
const assert = require('node:assert/strict');
const { encrypt, decrypt, normalizeLines, normalizeSettings } = require('../src/services/platformSettingsService');
const { npmCdnUrls, npmPageUrl } = require('../src/services/npmPublishService');

test('平台密钥以可逆的加密载荷保存，不暴露明文', () => {
  const encrypted = encrypt('sensitive-token-value');
  assert.notEqual(JSON.stringify(encrypted), 'sensitive-token-value');
  assert.equal(decrypt(encrypted), 'sensitive-token-value');
  assert.equal(decrypt({ ...encrypted, tag: 'broken' }), '');
});

test('npm 默认线路只接受四个允许的提供方，并确保主线路属于已选线路', () => {
  assert.deepEqual(normalizeLines(['npmmirror', 'invalid', 'jsdelivr', 'npmmirror']), ['npmmirror', 'jsdelivr']);
  const settings = normalizeSettings({ npm: { lines: ['esm'], primary: 'unpkg' } });
  assert.deepEqual(settings.npm.lines, ['esm']);
  assert.equal(settings.npm.primary, 'esm');
});

test('npm 发布页为每个选定线路生成固定版本和 latest 地址', () => {
  const urls = npmCdnUrls('link-status-page', '0.0.42', ['npmmirror', 'jsdelivr', 'unpkg', 'esm'], 'jsdelivr');
  assert.equal(urls.length, 4);
  assert.equal(urls.filter(item => item.primary).map(item => item.provider)[0], 'jsdelivr');
  assert.equal(urls.find(item => item.provider === 'npmmirror').url, 'https://registry.npmmirror.com/link-status-page/0.0.42/files/index.html');
  assert.equal(npmPageUrl('link-status-page', 'latest', 'esm'), 'https://esm.sh/link-status-page@latest/index.html');
});
