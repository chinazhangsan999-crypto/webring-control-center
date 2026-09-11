'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

test('浏览器接收器清除片段并保存站点本地管理员令牌', async () => {
  const values = new Map();
  let cleanedUrl = '';
  const window = {
    location: { hash: `#control-sso=${'z'.repeat(32)}`, pathname: '/admin', search: '?from=control' },
    history: { replaceState: (_state, _title, url) => { cleanedUrl = url; } },
    localStorage: { setItem: (key, value) => values.set(key, value) },
    fetch: async (_url, init) => {
      assert.equal(JSON.parse(init.body).code, 'z'.repeat(32));
      return new Response(JSON.stringify({ code: 200, data: { token: 'local-jwt' } }), { status: 200 });
    }
  };
  const code = fs.readFileSync(path.join(__dirname, '..', 'packages', 'site-agent', 'browser-sso.js'), 'utf8');
  vm.runInNewContext(code, { window, Response });
  assert.equal(await window.ControlCenterSso.consume(), true);
  assert.equal(cleanedUrl, '/admin?from=control');
  assert.equal(values.get('webring_admin_token'), 'local-jwt');
  assert.equal(values.get('webring_login_source'), 'control_center');
});
