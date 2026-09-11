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
