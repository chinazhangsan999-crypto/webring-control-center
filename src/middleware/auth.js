'use strict';

const { one, query } = require('../db');
const { parseCookies, sha256 } = require('../lib/security');
const { fail } = require('../lib/http');
const { SESSION_COOKIE_NAME } = require('../config');
const ControlService = require('../services/controlService');
const { ERROR_CODES } = require('../../packages/shared-protocol');

async function requireAdmin(req, res, next) {
  res.set('cache-control', 'no-store');
  const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
  if (!raw) return fail(res, '请先登录', 401);
  const session = await one(`SELECT s.id AS session_id,s.admin_id,s.csrf_token,s.expires_at,a.username
    FROM admin_sessions s JOIN admins a ON a.id=s.admin_id
    WHERE s.token_hash=$1 AND s.expires_at>NOW() AND a.enabled=TRUE AND a.singleton_key=TRUE`, [sha256(raw)]);
  if (!session) return fail(res, '登录已过期', 401);
  req.admin = { id: session.admin_id, username: session.username, type: 'admin', sessionId: session.session_id, csrfToken: session.csrf_token };
  query('UPDATE admin_sessions SET last_seen_at=NOW() WHERE id=$1', [session.session_id]).catch(() => {});
  return next();
}

function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-csrf-token') !== req.admin?.csrfToken) return fail(res, '请求校验失败，请刷新页面后重试', 403);
  const origin = req.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) return fail(res, '拒绝跨站写入请求', 403);
    } catch {
      return fail(res, '请求来源不合法', 403);
    }
  }
  return next();
}

async function requireSite(req, res, next) {
  const site = await ControlService.authenticateSiteCredential(req.get('authorization'));
  if (!site) return fail(res, '站点凭据无效', 401, null, ERROR_CODES.invalidCredential);
  req.site = site;
  return next();
}

module.exports = { requireAdmin, requireCsrf, requireSite };
