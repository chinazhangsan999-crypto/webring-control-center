'use strict';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1/test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAd, parseAdPolicies, parseNode, resourceScope } = require('../src/services/controlService');

test('联盟代码不改写并固定为全平台', () => {
  const code = '<script>window.test = "原样";</script>\n';
  const ad = parseAd({ namespace: 'central:test', title: '测试', ad_type: 'code', ad_position: 'top_float', platform: 'ios', ad_code: code });
  assert.equal(ad.adCode, code);
  assert.equal(ad.platform, 'all');
});

test('普通广告不会携带代码字段', () => {
  const ad = parseAd({ namespace: 'central:image', title: '图片', ad_type: 'normal', ad_position: 'banner', ad_code: '<script>bad()</script>', image_url: 'https://example.com/a.png', target_url: 'https://example.com' });
  assert.equal(ad.adCode, '');
});

test('定向广告要求有效范围和整数优先级', () => {
  assert.throws(() => parseAd({ namespace: 'central:empty', title: '空范围', ad_type: 'normal', ad_position: 'banner', scope_mode: 'selected' }), /至少需要选择一个站点/);
  assert.throws(() => parseAd({ namespace: 'central:priority', title: '错误权重', ad_type: 'normal', ad_position: 'banner', priority: 1.5 }), /广告优先级/);
});

test('单站广告策略要求覆盖全部广告位且不重复', () => {
  const policies = ['banner', 'icon', 'top_float', 'bottom_float', 'icon_float'].map(slot => ({ slot, policy: 'central_first' }));
  assert.equal(parseAdPolicies(policies).length, 5);
  assert.throws(() => parseAdPolicies(policies.slice(0, 4)), /全部广告位/);
  assert.throws(() => parseAdPolicies([...policies.slice(0, 4), policies[0]]), /不合法或重复/);
});

test('选定范围对站点和分组去重', () => {
  assert.deepEqual(resourceScope({ scope_mode: 'selected', site_ids: [1, 1, '2', -1], group_ids: [3, '3'] }), { scopeMode: 'selected', siteIds: [1, 2], groupIds: [3] });
});

test('统一节点要求有效排序且定向范围不能为空', () => {
  const node = parseNode({ speed_name: '主入口', partner_name: '示例站', url: 'https://example.com', sort_order: 90, scope_mode: 'global' });
  assert.equal(node.sortOrder, 90);
  assert.equal(node.scope.scopeMode, 'global');
  assert.throws(() => parseNode({ speed_name: '空范围', partner_name: '示例站', url: 'https://example.net', scope_mode: 'selected' }), /至少需要选择一个站点/);
  assert.throws(() => parseNode({ speed_name: '错误排序', partner_name: '示例站', url: 'https://example.org', sort_order: 1.5 }), /节点排序/);
});
