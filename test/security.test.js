'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanSlug, normalizeHttpUrl, sha256, parseCookies } = require('../src/lib/security');

test('站点标识仅接受稳定的小写安全格式', () => {
  assert.equal(cleanSlug('site-01'), 'site-01');
  assert.throws(() => cleanSlug('../site'), /站点标识/);
  assert.throws(() => cleanSlug('A'), /站点标识/);
});

test('管理地址只接受 HTTP 和 HTTPS', () => {
  assert.equal(normalizeHttpUrl('https://example.com/admin/'), 'https://example.com/admin');
  assert.throws(() => normalizeHttpUrl('javascript:alert(1)'), /HTTP\/HTTPS/);
});

test('Cookie 和摘要处理保持确定性', () => {
  assert.deepEqual(parseCookies('a=1; token=hello%20world'), { a: '1', token: 'hello world' });
  assert.equal(sha256('same'), sha256('same'));
  assert.notEqual(sha256('same'), sha256('other'));
});
