'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { one, transaction } = require('../db');
const { ok, fail, asyncRoute } = require('../lib/http');
const { randomToken, sha256, parseCookies } = require('../lib/security');
const { requireAdmin, requireCsrf } = require('../middleware/auth');
const { NODE_ENV, SESSION_COOKIE_NAME, SESSION_TTL_HOURS } = require('../config');
const ControlService = require('../services/controlService');

const router = express.Router();
const loginAttempts = new Map();
const DUMMY_PASSWORD_HASH = '$2a$12$aHO3ggFgk9eDDr7E6HFLQ..EeTpYRjpQYQwhySE.rMkIS2ToMOSpW';

function pruneLoginAttempts(now) {
  for (const [key, value] of loginAttempts) if (value.resetAt <= now) loginAttempts.delete(key);
  while (loginAttempts.size > 10_000) loginAttempts.delete(loginAttempts.keys().next().value);
}

function allowLogin(req, res, next) {
  const key = req.ip || 'unknown';
  const now = Date.now();
  if (loginAttempts.size > 10_000 || Math.random() < 0.01) pruneLoginAttempts(now);
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + 15 * 60_000 });
    return next();
  }
  current.count += 1;
  if (current.count > 8) return fail(res, '登录尝试过于频繁，请 15 分钟后重试', 429);
  return next();
}

function cookieOptions() {
  return { httpOnly: true, secure: NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: SESSION_TTL_HOURS * 3600 * 1000 };
}

router.post('/login', allowLogin, asyncRoute(async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!username || !password) return fail(res, '请输入用户名和密码');
  const admin = await one('SELECT id,username,password_hash FROM admins WHERE singleton_key=TRUE AND enabled=TRUE LIMIT 1');
  const passwordMatches = await bcrypt.compare(password, admin?.password_hash || DUMMY_PASSWORD_HASH);
  if (!admin || username !== admin.username || !passwordMatches) return fail(res, '用户名或密码错误', 401);
  loginAttempts.delete(req.ip || 'unknown');
  const token = randomToken(32);
  const csrf = randomToken(24);
  await transaction(async client => {
    await client.query(`INSERT INTO admin_sessions(admin_id,token_hash,csrf_token,expires_at,ip,user_agent)
      VALUES($1,$2,$3,NOW()+($4*INTERVAL '1 hour'),$5,$6)`, [admin.id, sha256(token), csrf, SESSION_TTL_HOURS, req.ip, String(req.get('user-agent') || '').slice(0, 500)]);
    await client.query('DELETE FROM admin_sessions WHERE expires_at<=NOW()');
    await client.query(`DELETE FROM admin_sessions WHERE admin_id=$1 AND id NOT IN
      (SELECT id FROM admin_sessions WHERE admin_id=$1 ORDER BY created_at DESC,id DESC LIMIT 5)`, [admin.id]);
    await ControlService.audit({ type: 'admin', id: admin.id }, 'super-admin.login', 'admin', admin.id, {}, req.ip, client);
  });
  res.cookie(SESSION_COOKIE_NAME, token, cookieOptions());
  return ok(res, { user: { id: admin.id, username: admin.username, role: 'super_admin' }, csrf_token: csrf }, '登录成功');
}));

router.get('/me', requireAdmin, asyncRoute(async (req, res) => ok(res, {
  user: { id: req.admin.id, username: req.admin.username, role: 'super_admin' },
  csrf_token: req.admin.csrfToken
})));

router.post('/logout', requireAdmin, requireCsrf, asyncRoute(async (req, res) => {
  await transaction(async client => {
    await ControlService.audit({ type: 'admin', id: req.admin.id }, 'super-admin.logout', 'admin', req.admin.id, {}, req.ip, client);
    await client.query('DELETE FROM admin_sessions WHERE id=$1', [req.admin.sessionId]);
  });
  const options = cookieOptions();
  delete options.maxAge;
  res.clearCookie(SESSION_COOKIE_NAME, options);
  return ok(res, null, '已退出登录');
}));

module.exports = router;
