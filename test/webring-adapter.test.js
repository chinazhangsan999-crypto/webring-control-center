'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWebringConfigApplier, normalizeCentralAd, policyEntries, selectAdsForSlot, consumeControlCenterSso } = require('../packages/site-agent/webring-adapter');

test('中央代码广告映射保留联盟代码和命名空间', () => {
  const code = '<script src="https://ads.example/code.js"></script>';
  const result = normalizeCentralAd({ id: 8, namespace: 'central:vendor-a', title: '联盟', ad_type: 'code', ad_position: 'bottom_float', ad_code: code, priority: 90, integrity_sha256: 'abc' });
  assert.equal(result.adCode, code);
  assert.equal(result.namespace, 'central:vendor-a');
  assert.equal(result.sortOrder, 90);
});

test('未单独配置的广告位使用 central_first', () => {
  const entries = Object.fromEntries(policyEntries([{ slot: 'banner', policy: 'local_only' }]));
  assert.equal(entries['central_ad_policy:banner'], 'local_only');
  assert.equal(entries['central_ad_policy:icon'], 'central_first');
});

test('单站广告策略不会删除本地广告来源', () => {
  const central = [{ id: 'central' }];
  const local = [{ id: 'local' }];
  assert.deepEqual(selectAdsForSlot({ centralAds: central, localAds: local, policy: 'central_only' }), central);
  assert.deepEqual(selectAdsForSlot({ centralAds: central, localAds: local, policy: 'local_only' }), local);
  assert.deepEqual(selectAdsForSlot({ centralAds: central, localAds: local, policy: 'central_first' }), [...central, ...local]);
});

test('混合排序同时识别中央和本地的优先级字段', () => {
  const central = [{ id: 'central', sortOrder: 100 }];
  const local = [{ id: 'local', sort_order: 80 }];
  assert.deepEqual(selectAdsForSlot({ centralAds: central, localAds: local, policy: 'mixed' }), [central[0], local[0]]);
  central[0].sortOrder = 10;
  assert.deepEqual(selectAdsForSlot({ centralAds: central, localAds: local, policy: 'mixed' }), [local[0], central[0]]);
});

test('中央广告快照只替换中央广告并保留联盟代码原文', async () => {
  const statements = [];
  const columns = {
    mirrors: ['speed_name', 'partner_name', 'url', 'status', 'managed_by', 'central_id', 'sort_order'],
    ads: ['managed_by', 'central_id', 'namespace', 'integrity_sha256']
  };
  const applier = createWebringConfigApplier({
    run: async (sql, params = []) => { statements.push({ sql, params }); },
    all: async sql => {
      const table = sql.match(/PRAGMA table_info\(([^)]+)\)/)?.[1];
      return (columns[table] || []).map(name => ({ name }));
    },
    withTransaction: async work => work({
      run: async (sql, params = []) => { statements.push({ sql, params }); },
      get: async () => null
    })
  });
  const code = '<script>window.vendor = "原文";</script>\n';
  await applier.initialize();
  await applier.applyConfig({
    revision: '1-2-1', nodes: [],
    ads: [{ id: '9', namespace: 'central:vendor', title: '联盟', ad_type: 'code', ad_position: 'top_float', platform: 'all', ad_code: code, image_url: '', target_url: '', priority: 60, integrity_sha256: 'a'.repeat(64) }],
    ad_policies: [{ slot: 'top_float', policy: 'mixed' }], publish: {}
  });
  assert.ok(statements.some(item => /DELETE FROM ads WHERE managed_by='central'/.test(item.sql)));
  assert.ok(!statements.some(item => /^DELETE FROM ads\s*$/i.test(item.sql.trim())));
  assert.ok(statements.some(item => item.params.includes(code)));
  assert.ok(statements.some(item => item.params.includes('mixed')));
});

test('统一登录交换写入导航站现用令牌键并立即清除地址片段', async () => {
  const values = new Map();
  let cleanedUrl = '';
  const consumed = await consumeControlCenterSso({
    request: async (path, options) => {
      assert.equal(path, '/api/admin/control-center/session');
      assert.deepEqual(options, { method: 'POST', body: { code: 'x'.repeat(32) } });
      return { token: 'site-admin-jwt', source: 'control_center' };
    },
    storage: { setItem: (key, value) => values.set(key, value) },
    historyApi: { replaceState: (_state, _title, url) => { cleanedUrl = url; } },
    locationApi: { hash: `#control-sso=${'x'.repeat(32)}`, pathname: '/admin', search: '' }
  });
  assert.equal(consumed, true);
  assert.equal(values.get('webring_admin_token'), 'site-admin-jwt');
  assert.equal(values.get('webring_login_source'), 'control_center');
  assert.equal(cleanedUrl, '/admin');
});

test('中央节点快照只替换中央节点并保留本地节点', async () => {
  const statements = [];
  const columns = {
    mirrors: ['speed_name', 'partner_name', 'url', 'status', 'managed_by', 'central_id', 'sort_order'],
    ads: ['managed_by', 'central_id', 'namespace', 'integrity_sha256']
  };
  const applier = createWebringConfigApplier({
    run: async (sql, params = []) => { statements.push({ sql, params }); },
    all: async sql => {
      const table = sql.match(/PRAGMA table_info\(([^)]+)\)/)?.[1];
      return (columns[table] || []).map(name => ({ name }));
    },
    withTransaction: async work => work({
      run: async (sql, params = []) => { statements.push({ sql, params }); },
      get: async () => null
    })
  });
  await applier.initialize();
  await applier.applyConfig({
    revision: '2-1-1',
    nodes: [{ id: '7', speed_name: '北京入口', partner_name: '总站', url: 'https://node.example.com/', sort_order: 80 }],
    ads: [], ad_policies: [], publish: {}
  });
  assert.ok(statements.some(item => /DELETE FROM mirrors WHERE managed_by='central'/.test(item.sql)));
  assert.ok(!statements.some(item => /^DELETE FROM mirrors\s*$/i.test(item.sql.trim())));
  assert.ok(statements.some(item => /INSERT INTO mirrors[\s\S]+managed_by,central_id,sort_order/.test(item.sql)));
});

test('中央节点快照同步禁用状态', async () => {
  const statements = [];
  const applier = createWebringConfigApplier({
    run: async () => {},
    all: async sql => {
      const table = sql.match(/PRAGMA table_info\(([^)]+)\)/)?.[1];
      const columns = {
        mirrors: ['speed_name', 'partner_name', 'url', 'status', 'managed_by', 'central_id', 'sort_order'],
        ads: ['managed_by', 'central_id', 'namespace', 'integrity_sha256']
      };
      return (columns[table] || []).map(name => ({ name }));
    },
    withTransaction: async work => work({
      run: async (sql, params = []) => { statements.push({ sql, params }); },
      get: async () => null
    })
  });

  await applier.initialize();
  await applier.applyConfig({
    revision: '3-1-1',
    nodes: [{ id: '8', speed_name: '备用入口', partner_name: '总站', url: 'https://disabled.example.com/', enabled: false, sort_order: 10 }],
    ads: [], ad_policies: [], publish: {}
  });
  const insert = statements.find(item => /INSERT INTO mirrors/.test(item.sql));
  assert.equal(insert.params[3], 0);
});

test('中央节点接管同地址的旧本地节点', async () => {
  const statements = [];
  const applier = createWebringConfigApplier({
    run: async () => {},
    all: async sql => {
      const table = sql.match(/PRAGMA table_info\(([^)]+)\)/)?.[1];
      const columns = {
        mirrors: ['speed_name', 'partner_name', 'url', 'status', 'managed_by', 'central_id', 'sort_order'],
        ads: ['managed_by', 'central_id', 'namespace', 'integrity_sha256']
      };
      return (columns[table] || []).map(name => ({ name }));
    },
    withTransaction: async work => work({
      run: async (sql, params = []) => { statements.push({ sql, params }); },
      get: async () => ({ managed_by: 'local' })
    })
  });

  await applier.initialize();
  await applier.applyConfig({
    revision: '2-1-1',
    nodes: [{ id: '7', speed_name: '北京入口', partner_name: '总站', url: 'https://node.example.com/', sort_order: 80 }],
    ads: [], ad_policies: [], publish: {}
  });
  assert.ok(statements.some(item => /DELETE FROM mirrors WHERE url=\?/.test(item.sql)));
  assert.ok(statements.some(item => /INSERT INTO mirrors/.test(item.sql)));
});
