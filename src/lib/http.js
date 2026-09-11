'use strict';

const { ERROR_CODES, createSuccessEnvelope, createErrorEnvelope } = require('../../packages/shared-protocol');

function ok(res, data = null, message = '成功', status = 200) {
  const payload = res.locals.sharedProtocol
    ? createSuccessEnvelope(data, message, status)
    : { code: status, message, data };
  return res.status(status).json(payload);
}

function fail(res, message, status = 400, details = null, errorCode = ERROR_CODES.invalidRequest) {
  const payload = res.locals.sharedProtocol
    ? createErrorEnvelope(errorCode, message, details, status)
    : { code: status, message, details };
  return res.status(status).json(payload);
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = { ok, fail, asyncRoute };
