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

async function saveLocalAd(req, res, codeOnly = false) {
  const localAdId = Number(req.params.localAdId);
  if (!Number.isSafeInteger(localAdId) || localAdId <= 0) return fail(res, '本地广告编号不合法', 400);
  const title = String(req.body?.title || '').trim().slice(0, 120);
  const adType = codeOnly || req.body?.ad_type === 'code' ? 'code' : 'normal';
  const allowedPositions = adType === 'code'
    ? ['top_float', 'bottom_float', 'icon_float']
    : ['banner', 'icon'];
  const adPosition = String(req.body?.ad_position || allowedPositions[0]);
  if (!allowedPositions.includes(adPosition)) return fail(res, '本站广告位置与类型不匹配', 400);
  const allowedPlatforms = ['all', 'pc', 'ios', 'non_ios', 'android', 'harmony'];
  const platform = adType === 'code' ? 'all' : String(req.body?.platform || 'all');
  if (!allowedPlatforms.includes(platform)) return fail(res, '普通图文显示端不合法', 400);
  const adCode = adType === 'code' ? String(req.body?.ad_code || '') : '';
  const integrity = adType === 'code' ? String(req.body?.integrity_sha256 || '').toLowerCase() : '';
  const renderMode = adType === 'code' && req.body?.render_mode === 'sandbox' ? 'sandbox' : 'direct';
  const priority = Number(req.body?.priority || 0);
  if (!Number.isSafeInteger(priority) || Math.abs(priority) > 1_000_000) return fail(res, '本站广告排序权重不合法', 400);
  const rawSandbox = req.body?.sandbox_options && typeof req.body.sandbox_options === 'object' && !Array.isArray(req.body.sandbox_options) ? req.body.sandbox_options : {};
  const sandboxOptions = adType === 'code' && renderMode === 'sandbox' ? {
    initial_height: Math.min(800, Math.max(50, Number.parseInt(rawSandbox.initial_height, 10) || 120)),
    auto_height: rawSandbox.auto_height !== false,
    allow_popups: rawSandbox.allow_popups !== false,
    allow_forms: rawSandbox.allow_forms === true,
    timeout_ms: Math.min(30000, Math.max(1000, Number.parseInt(rawSandbox.timeout_ms, 10) || 10000))
  } : {};
  if (adType === 'code') {
    const expectedIntegrity = require('node:crypto').createHash('sha256').update(adCode).digest('hex');
    if (!adCode.trim()) return fail(res, '代码广告内容不能为空', 400);
    if (!/^[a-f0-9]{64}$/.test(integrity) || integrity !== expectedIntegrity) return fail(res, '代码广告完整性校验失败', 400);
  }
  const description = String(req.body?.description || '').slice(0, 500);
  const imageUrl = adType === 'normal' ? String(req.body?.image_url || '').trim().slice(0, 2048) : '';
  const targetUrl = adType === 'normal' ? String(req.body?.target_url || '').trim().slice(0, 2048) : '';
  await query(`INSERT INTO site_ad_payloads(site_id,local_ad_id,title,ad_type,description,platform,image_url,target_url,ad_code,integrity_sha256,render_mode,ad_position,priority,sandbox_options,enabled,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,NOW())
    ON CONFLICT(site_id,local_ad_id) DO UPDATE SET title=EXCLUDED.title,ad_code=EXCLUDED.ad_code,
      integrity_sha256=EXCLUDED.integrity_sha256,render_mode=EXCLUDED.render_mode,ad_position=EXCLUDED.ad_position,
      ad_type=EXCLUDED.ad_type,description=EXCLUDED.description,platform=EXCLUDED.platform,
      image_url=EXCLUDED.image_url,target_url=EXCLUDED.target_url,priority=EXCLUDED.priority,
      sandbox_options=EXCLUDED.sandbox_options,enabled=EXCLUDED.enabled,updated_at=NOW()`,
  [req.site.id, localAdId, title, adType, description, platform, imageUrl, targetUrl, adCode, integrity,
    renderMode, adPosition, priority, JSON.stringify(sandboxOptions), req.body?.enabled === true]);
  return ok(res, { local_ad_id: localAdId, ad_type: adType, integrity_sha256: integrity, render_mode: renderMode, ad_position: adPosition, priority }, '本站广告配置已同步');
}

router.put('/local-ads/:localAdId', asyncRoute((req, res) => saveLocalAd(req, res)));
router.put('/local-code-ads/:localAdId', asyncRoute((req, res) => saveLocalAd(req, res, true)));

async function deleteLocalAd(req, res) {
  const localAdId = Number(req.params.localAdId);
  if (!Number.isSafeInteger(localAdId) || localAdId <= 0) return fail(res, '本地广告编号不合法', 400);
  await query('DELETE FROM site_ad_payloads WHERE site_id=$1 AND local_ad_id=$2', [req.site.id, localAdId]);
  return ok(res, null, '本站广告同步记录已删除');
}

router.delete('/local-ads/:localAdId', asyncRoute(deleteLocalAd));
router.delete('/local-code-ads/:localAdId', asyncRoute(deleteLocalAd));

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
