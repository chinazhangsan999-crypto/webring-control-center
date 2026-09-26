'use strict';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1/test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUsername, validateNewPassword } = require('../src/services/superAdminService');

test('超级管理员用户名支持中英文但拒绝空格和过短值', () => {
  assert.equal(normalizeUsername('星环_admin'), '星环_admin');
  assert.throws(() => normalizeUsername('ab'), /3-64/);
  assert.throws(() => normalizeUsername('admin user'), /3-64/);
});

test('超级管理员新密码至少 8 位且不包含用户名', () => {
  assert.equal(validateNewPassword('Safe-Pass-2026!', 'rootadmin'), 'Safe-Pass-2026!');
  assert.equal(validateNewPassword('admin123', 'rootadmin'), 'admin123');
  assert.throws(() => validateNewPassword('short', 'rootadmin'), /8-200/);
  assert.throws(() => validateNewPassword('xxROOTADMINxx-2026', 'rootadmin'), /不能包含/);
});
