'use strict';

const express = require('express');
const { query } = require('../db');
const { ok, fail, asyncRoute } = require('../lib/http');
const { requireSite } = require('../middleware/auth');
const { requireAgentProtocol } = require('../middleware/protocol');
const ControlService = require('../services/controlService');
const {
  PROTOCOL_VERSION,
  HEADERS,
  ERROR_CODES,
  formatRevision,
  revisionEtag,
  validateHeartbeat,
  validateConfigSnapshot,
  validateSsoRedeemRequest,
  ProtocolError
} = require('../../packages/shared-protocol');

const router = express.Router();
router.use(requireAgentProtocol);
router.use(requireSite);

router.post('/heartbeat', asyncRoute(async (req, res) => {
  const heartbeat = validateHeartbeat(req.body);
  await query(`UPDATE sites SET status='online',agent_version=$2,protocol_version=$3,capabilities=$4::jsonb,
    applied_revision=$5,last_seen_at=NOW(),last_ip=$6,metadata=$7::jsonb,updated_at=NOW() WHERE id=$1`, [
    req.site.id,
    heartbeat.agent_version,
    heartbeat.protocol_version,
    JSON.stringify(heartbeat.capabilities),
    heartbeat.applied_revision,
    req.ip,
    JSON.stringify(heartbeat.metadata)
  ]);
  return ok(res, {
    server_time: new Date().toISOString(),
    protocol_version: PROTOCOL_VERSION,
    heartbeat_interval_seconds: 60
  }, '心跳已接收');
}));

router.get('/config', asyncRoute(async (req, res) => {
  const config = await ControlService.resolveSiteConfig(req.site.id);
  const revision = formatRevision(config.revisions);
  const etag = revisionEtag(revision);
  const snapshot = validateConfigSnapshot({
    protocol_version: PROTOCOL_VERSION,
    site_id: req.site.id,
    revision,
    ...config
  });
  res.set(HEADERS.configRevision, revision);
  if (req.get('if-none-match') === etag) return res.status(304).end();
  res.set('etag', etag);
  return ok(res, snapshot);
}));

router.put('/local-code-ads/:localAdId', asyncRoute(async (req, res) => {
  const localAdId = Number(req.params.localAdId);
  if (!Number.isSafeInteger(localAdId) || localAdId <= 0) return fail(res, '本地广告编号不合法', 400);
  const title = String(req.body?.title || '').trim().slice(0, 80);
  const adCode = String(req.body?.ad_code || '');
  const integrity = String(req.body?.integrity_sha256 || '').toLowerCase();
  const renderMode = req.body?.render_mode === 'sandbox' ? 'sandbox' : 'direct';
  const expectedIntegrity = require('node:crypto').createHash('sha256').update(adCode).digest('hex');
  if (!adCode.trim()) return fail(res, '代码广告内容不能为空', 400);
  if (!/^[a-f0-9]{64}$/.test(integrity) || integrity !== expectedIntegrity) return fail(res, '代码广告完整性校验失败', 400);
  await query(`INSERT INTO site_ad_payloads(site_id,local_ad_id,title,ad_code,integrity_sha256,render_mode,enabled,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,NOW())
    ON CONFLICT(site_id,local_ad_id) DO UPDATE SET title=EXCLUDED.title,ad_code=EXCLUDED.ad_code,
      integrity_sha256=EXCLUDED.integrity_sha256,render_mode=EXCLUDED.render_mode,enabled=EXCLUDED.enabled,updated_at=NOW()`,
  [req.site.id, localAdId, title, adCode, integrity, renderMode, req.body?.enabled === true]);
  return ok(res, { local_ad_id: localAdId, integrity_sha256: integrity, render_mode: renderMode }, '本地代码广告载荷已同步');
}));

router.delete('/local-code-ads/:localAdId', asyncRoute(async (req, res) => {
  const localAdId = Number(req.params.localAdId);
  if (!Number.isSafeInteger(localAdId) || localAdId <= 0) return fail(res, '本地广告编号不合法', 400);
  await query('DELETE FROM site_ad_payloads WHERE site_id=$1 AND local_ad_id=$2', [req.site.id, localAdId]);
  return ok(res, null, '本地代码广告载荷已删除');
}));

router.post('/sso/redeem', asyncRoute(async (req, res) => {
  const { ticket } = validateSsoRedeemRequest(req.body);
  let result;
  try {
    result = await ControlService.redeemSsoTicket(req.site, ticket, req.ip);
  } catch (error) {
    if (/票据|管理员账号/.test(error.message || '')) {
      throw new ProtocolError(ERROR_CODES.invalidTicket, error.message);
    }
    throw error;
  }
  return ok(res, result, '票据验证成功');
}));

module.exports = router;
