'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PROTOCOL_VERSION,
  ERROR_CODES,
  ProtocolError,
  isCompatibleVersion,
  assertCompatibleVersion,
  buildSiteAuthorization,
  parseSiteAuthorization,
  formatRevision,
  parseRevision,
  revisionEtag,
  createHeartbeat,
  validateHeartbeat,
  validateConfigSnapshot,
  calculateAdIntegrity,
  createSuccessEnvelope,
  validateSuccessEnvelope,
  validateHeartbeatResult,
  validateSsoRedeemResult
} = require('../packages/shared-protocol');

function validSnapshot(overrides = {}) {
  const codeAd = { id: '2', namespace: 'network.top', title: '顶部联盟', ad_type: 'code', ad_position: 'banner', platform: 'all', ad_code: '<script>window.ad=1</script>', image_url: '', target_url: '' };
  codeAd.integrity_sha256 = calculateAdIntegrity(codeAd);
  return {
    protocol_version: PROTOCOL_VERSION,
    site_id: '7',
    revision: '2-3-4',
    revisions: { nodes_revision: '2', ads_revision: '3', publish_revision: '4' },
    nodes: [{ id: '1', speed_name: '主站', partner_name: '示例站', url: 'https://example.com/', enabled: true }],
    ads: [codeAd],
    ad_policies: [{ slot: 'banner', policy: 'central_first' }],
    publish: { permanent_url: 'https://go.example.com/', github_pages_url: 'https://owner.github.io/site/' },
    ...overrides
  };
}

test('协议版本只允许同主版本且 Agent 次版本不高于总控', () => {
  assert.equal(isCompatibleVersion('1.0'), true);
  assert.equal(isCompatibleVersion('1.1'), false);
  assert.equal(isCompatibleVersion('2.0'), false);
  assert.throws(() => assertCompatibleVersion('2.0'), error => error instanceof ProtocolError && error.code === ERROR_CODES.unsupportedProtocol);
});

test('站点凭据在协议层统一生成与解析', () => {
  const credential = '7.secret-value-abcdefghijklmnop';
  assert.equal(buildSiteAuthorization(credential), `Site ${credential}`);
  assert.deepEqual(parseSiteAuthorization(`Site ${credential}`), { siteId: '7', secret: 'secret-value-abcdefghijklmnop', credential });
});

test('分项修订号组成稳定版本和 ETag', () => {
  const revision = formatRevision({ nodes_revision: 2, ads_revision: '3', publish_revision: 4 });
  assert.equal(revision, '2-3-4');
  assert.deepEqual(parseRevision(revision), { nodes_revision: '2', ads_revision: '3', publish_revision: '4' });
  assert.equal(revisionEtag(revision), '"cc-2-3-4"');
});

test('心跳带协议版本、能力和已应用修订号', () => {
  const heartbeat = createHeartbeat({ agentVersion: '0.2.0', appliedRevision: '2-3-4', capabilities: ['config.etag', 'config.etag'], metadata: { runtime: 'node' } });
  assert.equal(heartbeat.protocol_version, '1.0');
  assert.deepEqual(heartbeat.capabilities, ['config.etag']);
  assert.equal(validateHeartbeat(heartbeat).applied_revision, '2-3-4');
});

test('快照校验保留联盟代码原文并拒绝修订号冲突', () => {
  const snapshot = validSnapshot();
  assert.equal(validateConfigSnapshot(snapshot).ads[0].ad_code, '<script>window.ad=1</script>');
  assert.throws(() => validateConfigSnapshot(validSnapshot({ revision: '2-3-5' })), error => error instanceof ProtocolError && error.code === ERROR_CODES.invalidSnapshot);
  const tampered = validSnapshot();
  tampered.ads[0].ad_code = '<script>window.ad=2</script>';
  assert.throws(() => validateConfigSnapshot(tampered), /完整性摘要不一致/);
});

test('心跳与 SSO 成功响应必须使用完整协议信封', () => {
  const heartbeat = validateSuccessEnvelope(createSuccessEnvelope({ server_time: '2026-09-11T00:00:00.000Z', protocol_version: '1.0', heartbeat_interval_seconds: 60 }));
  assert.equal(validateHeartbeatResult(heartbeat.data).heartbeat_interval_seconds, 60);
  const sso = { admin: { id: '1', username: 'admin' }, local_session_nonce: 'a'.repeat(32), expires_in: 120 };
  assert.equal(validateSsoRedeemResult(sso).admin.username, 'admin');
  assert.throws(() => validateSuccessEnvelope({ protocol: '1.0', ok: true, code: 200, message: '成功' }), /响应信封/);
});

test('节点快照接受安全排序并拒绝非整数排序', () => {
  const valid = validSnapshot();
  valid.nodes = [{ id: '1', speed_name: '北京入口', partner_name: '示例站', url: 'https://example.com/', enabled: true, sort_order: 90 }];
  assert.equal(validateConfigSnapshot(valid).nodes[0].sort_order, 90);
  const invalid = validSnapshot();
  invalid.nodes = [{ id: '1', speed_name: '北京入口', partner_name: '示例站', url: 'https://example.com/', enabled: true, sort_order: 1.5 }];
  assert.throws(() => validateConfigSnapshot(invalid), /节点排序/);
});

test('节点快照允许总后台下发停用状态', () => {
  const snapshot = validSnapshot();
  snapshot.nodes[0].enabled = false;
  assert.equal(validateConfigSnapshot(snapshot).nodes[0].enabled, false);
});

test('广告快照接受安全优先级并保留代码原文', () => {
  const valid = validSnapshot();
  valid.ads[0].priority = 90;
  assert.equal(validateConfigSnapshot(valid).ads[0].priority, 90);
  assert.equal(valid.ads[0].ad_code, '<script>window.ad=1</script>');
  const invalid = validSnapshot();
  invalid.ads[0].priority = 1.5;
  assert.throws(() => validateConfigSnapshot(invalid), /广告优先级/);
});
