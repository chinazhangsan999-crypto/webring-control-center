'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createControlCenterAgent } = require('../packages/site-agent');
const { PROTOCOL_VERSION, HEADERS } = require('../packages/shared-protocol');

test('站点 Agent 使用凭据并通过 ETag 避免重复落库', async () => {
  const calls = [];
  let applied = 0;
  const fakeFetch = async (_url, init) => {
    calls.push(init);
    if (init.headers['if-none-match']) return new Response(null, { status: 304, headers: { [HEADERS.protocol]: PROTOCOL_VERSION, [HEADERS.configRevision]: '1-1-1' } });
    const snapshot = {
      protocol_version: PROTOCOL_VERSION,
      site_id: '1',
      revision: '1-1-1',
      revisions: { nodes_revision: '1', ads_revision: '1', publish_revision: '1' },
      nodes: [],
      ads: [],
      ad_policies: [],
      publish: { permanent_url: '', github_pages_url: '' }
    };
    return new Response(JSON.stringify({ protocol: PROTOCOL_VERSION, ok: true, code: 200, message: '成功', data: snapshot }), { status: 200, headers: { 'content-type': 'application/json', [HEADERS.protocol]: PROTOCOL_VERSION, [HEADERS.configRevision]: '1-1-1', etag: '"cc-1-1-1"' } });
  };
  const agent = createControlCenterAgent({ controlCenterUrl: 'https://control.example.com', credential: '1.secret-value-abcdefghijklmnop', fetch: fakeFetch, applyConfig: async () => { applied += 1; }, issueAdminToken: async () => 'token' });
  const first = await agent.syncConfig();
  const second = await agent.syncConfig();
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(applied, 1);
  assert.equal(calls[0].headers.authorization, 'Site 1.secret-value-abcdefghijklmnop');
  assert.equal(calls[0].headers[HEADERS.protocol], PROTOCOL_VERSION);
  assert.equal(calls[1].headers['if-none-match'], '"cc-1-1-1"');
  assert.equal(agent.getAppliedRevision(), '1-1-1');
});

test('站点 Agent 拒绝串站快照且不调用落库回调', async () => {
  let applied = 0;
  const snapshot = {
    protocol_version: PROTOCOL_VERSION,
    site_id: '2',
    revision: '1-1-1',
    revisions: { nodes_revision: '1', ads_revision: '1', publish_revision: '1' },
    nodes: [], ads: [], ad_policies: [], publish: { permanent_url: '', github_pages_url: '' }
  };
  const fakeFetch = async () => new Response(JSON.stringify({ protocol: PROTOCOL_VERSION, ok: true, code: 200, message: '成功', data: snapshot }), {
    status: 200,
    headers: { [HEADERS.protocol]: PROTOCOL_VERSION, [HEADERS.configRevision]: '1-1-1', etag: '"cc-1-1-1"' }
  });
  const agent = createControlCenterAgent({ controlCenterUrl: 'https://control.example.com', credential: '1.secret-value-abcdefghijklmnop', fetch: fakeFetch, applyConfig: async () => { applied += 1; }, issueAdminToken: async () => 'token' });
  await assert.rejects(agent.syncConfig(), /与当前站点凭据不匹配/);
  assert.equal(applied, 0);
});

test('统一登录票据只生成一次本地交换结果且交换码只能消费一次', async () => {
  const ticket = 't'.repeat(32);
  const fakeFetch = async url => {
    assert.match(String(url), /\/api\/agent\/sso\/redeem$/);
    return new Response(JSON.stringify({
      protocol: PROTOCOL_VERSION,
      ok: true,
      code: 200,
      message: '成功',
      data: {
        admin: { id: '1', username: 'admin' },
        local_session_nonce: 'n'.repeat(32),
        expires_in: 120
      }
    }), { status: 200, headers: { 'content-type': 'application/json', [HEADERS.protocol]: PROTOCOL_VERSION } });
  };
  let issuedContext;
  const agent = createControlCenterAgent({
    controlCenterUrl: 'https://control.example.com',
    credential: '1.secret-value-abcdefghijklmnop',
    fetch: fakeFetch,
    applyConfig: async () => {},
    issueAdminToken: async (_admin, context) => { issuedContext = context; return 'local-admin-token'; }
  });
  const app = express();
  app.use('/api/admin/control-center', agent.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const landing = await fetch(`${origin}/api/admin/control-center/login`);
    assert.equal(landing.status, 200);
    assert.equal(landing.headers.get('cache-control').includes('no-store'), true);
    assert.equal(landing.headers.get('referrer-policy'), 'no-referrer');
    assert.match(landing.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal((await landing.text()).includes(ticket), false);
    const redeemed = await fetch(`${origin}/api/admin/control-center/sso`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ ticket })
    });
    const redeemedPayload = await redeemed.json();
    assert.equal(redeemed.status, 200);
    const code = decodeURIComponent(redeemedPayload.data.redirect.match(/#control-sso=([^&]+)/)[1]);
    const exchange = await fetch(`${origin}/api/admin/control-center/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ code })
    });
    assert.deepEqual(await exchange.json(), { code: 200, data: { token: 'local-admin-token', source: 'control_center' } });
    const replay = await fetch(`${origin}/api/admin/control-center/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code })
    });
    assert.equal(replay.status, 401);
    assert.deepEqual(issuedContext, { source: 'control_center', nonce: 'n'.repeat(32) });
  } finally {
    agent.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});
