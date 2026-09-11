'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const authRouter = require('./routes/auth');
const adminRouter = require('./routes/admin');
const agentRouter = require('./routes/agent');
const { fail } = require('./lib/http');
const { query } = require('./db');
const { TRUST_PROXY } = require('./config');
const { PROTOCOL_VERSION, HEADERS, ERROR_CODES, ProtocolError } = require('../packages/shared-protocol');
const { AppError } = require('./lib/errors');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY);
app.use((req, res, next) => {
  res.set({
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  });
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/agent', agentRouter);
app.get('/api/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/api/ready', async (_req, res) => {
  try {
    await query('SELECT 1');
    return res.json({ status: 'ready', database: 'ok', time: new Date().toISOString() });
  } catch {
    return res.status(503).json({ status: 'unavailable', database: 'error', time: new Date().toISOString() });
  }
});
app.use(express.static(path.join(__dirname, '..', 'public'), { etag: true, maxAge: '5m' }));
app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
app.use((req, res) => fail(res, '接口不存在', 404));
app.use((error, req, res, _next) => {
  console.error(error);
  if (req.path.startsWith('/api/agent/') && !res.locals.sharedProtocol) {
    res.locals.sharedProtocol = true;
    res.set(HEADERS.protocol, PROTOCOL_VERSION);
    res.set(HEADERS.requestId, crypto.randomUUID());
  }
  if (error instanceof ProtocolError) {
    const status = error.code === ERROR_CODES.unsupportedProtocol ? 426 : 400;
    return fail(res, error.message, status, error.details, error.code);
  }
  if (error instanceof AppError) return fail(res, error.message, error.status, error.details, error.code);
  if (error?.type === 'entity.parse.failed') return fail(res, 'JSON 请求体格式不合法', 400, null, ERROR_CODES.invalidRequest);
  const known = /不合法|不存在|请填写|格式|仅支持|已使用|已过期|不可用|重复|唯一|duplicate/i.test(error.message || '');
  return fail(res, known ? error.message : '服务器处理失败', known ? 400 : 500, null, known ? ERROR_CODES.invalidRequest : ERROR_CODES.internal);
});

module.exports = app;
