'use strict';

const bcrypt = require('bcryptjs');
const { one, query, transaction } = require('../db');
const { randomToken } = require('../lib/security');
const ControlService = require('./controlService');
const { badRequest, notFound } = require('../lib/errors');

function normalizeUsername(value) {
  const username = String(value || '').trim();
  if (!/^[\p{L}\p{N}_.-]{3,64}$/u.test(username)) throw badRequest('超级管理员用户名需为 3-64 位字母、数字、点、下划线或连字符');
  return username;
}

function validateNewPassword(value, username) {
  const password = String(value || '');
  if (password.length < 8 || password.length > 200) throw badRequest('新密码长度需为 8-200 位');
  if (password.toLocaleLowerCase().includes(username.toLocaleLowerCase())) throw badRequest('新密码不能包含管理员用户名');
  return password;
}

async function getSecurityOverview(adminId, currentSessionId) {
  const admin = await one(`SELECT id,username,created_at,updated_at,password_changed_at
    FROM admins WHERE id=$1 AND singleton_key=TRUE AND enabled=TRUE`, [adminId]);
  if (!admin) throw notFound('超级管理员账号不存在');
  const sessions = await query(`SELECT id,ip,user_agent,created_at,last_seen_at,expires_at,(id=$2) AS current
    FROM admin_sessions WHERE admin_id=$1 AND expires_at>NOW()
    ORDER BY current DESC,last_seen_at DESC`, [adminId, currentSessionId]);
  return { admin, sessions: sessions.rows };
}

async function updateAccount(adminId, currentSessionId, payload, ip) {
  const username = normalizeUsername(payload?.username);
  const currentPassword = String(payload?.current_password || '');
  if (!currentPassword) throw badRequest('请输入当前密码');
  const requestedPassword = String(payload?.new_password || '');
  const newPassword = requestedPassword ? validateNewPassword(requestedPassword, username) : '';

  return transaction(async client => {
    const current = (await client.query(`SELECT id,username,password_hash FROM admins
      WHERE id=$1 AND singleton_key=TRUE AND enabled=TRUE FOR UPDATE`, [adminId])).rows[0];
    if (!current || !(await bcrypt.compare(currentPassword, current.password_hash))) throw badRequest('当前密码错误');
    if (newPassword && await bcrypt.compare(newPassword, current.password_hash)) throw badRequest('新密码不能与当前密码相同');

    const passwordHash = newPassword ? await bcrypt.hash(newPassword, 12) : current.password_hash;
    const updated = (await client.query(`UPDATE admins SET username=$2,password_hash=$3,
      password_changed_at=CASE WHEN $4 THEN NOW() ELSE password_changed_at END,updated_at=NOW()
      WHERE id=$1 RETURNING id,username,updated_at,password_changed_at`, [adminId, username, passwordHash, Boolean(newPassword)])).rows[0];
    const revoked = (await client.query('DELETE FROM admin_sessions WHERE admin_id=$1 AND id<>$2 RETURNING id', [adminId, currentSessionId])).rowCount;
    const ticketsRevoked = (await client.query('DELETE FROM sso_tickets WHERE admin_id=$1 AND redeemed_at IS NULL RETURNING id', [adminId])).rowCount;
    const csrfToken = randomToken(24);
    await client.query('UPDATE admin_sessions SET csrf_token=$2,last_seen_at=NOW() WHERE id=$1', [currentSessionId, csrfToken]);
    await ControlService.audit({ type: 'admin', id: adminId }, 'super-admin.account.update', 'admin', adminId, {
      username_changed: username !== current.username,
      password_changed: Boolean(newPassword),
      sessions_revoked: revoked,
      sso_tickets_revoked: ticketsRevoked
    }, ip, client);
    return { user: { id: updated.id, username: updated.username, role: 'super_admin' }, csrf_token: csrfToken, sessions_revoked: revoked, sso_tickets_revoked: ticketsRevoked, password_changed_at: updated.password_changed_at };
  });
}

async function revokeOtherSessions(adminId, currentSessionId, ip) {
  return transaction(async client => {
    const revoked = (await client.query('DELETE FROM admin_sessions WHERE admin_id=$1 AND id<>$2 RETURNING id', [adminId, currentSessionId])).rowCount;
    const ticketsRevoked = (await client.query('DELETE FROM sso_tickets WHERE admin_id=$1 AND redeemed_at IS NULL RETURNING id', [adminId])).rowCount;
    await ControlService.audit({ type: 'admin', id: adminId }, 'super-admin.sessions.revoke', 'admin', adminId, { sessions_revoked: revoked, sso_tickets_revoked: ticketsRevoked }, ip, client);
    return { sessions_revoked: revoked, sso_tickets_revoked: ticketsRevoked };
  });
}

module.exports = { normalizeUsername, validateNewPassword, getSecurityOverview, updateAccount, revokeOtherSessions };
