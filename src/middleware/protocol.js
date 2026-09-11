'use strict';

const crypto = require('crypto');
const {
  PROTOCOL_VERSION,
  HEADERS,
  ERROR_CODES,
  ProtocolError,
  assertCompatibleVersion
} = require('../../packages/shared-protocol');
const { fail } = require('../lib/http');

function requireAgentProtocol(req, res, next) {
  res.locals.sharedProtocol = true;
  res.set(HEADERS.protocol, PROTOCOL_VERSION);
  const incomingRequestId = String(req.get(HEADERS.requestId) || '');
  req.protocolRequestId = /^[A-Za-z0-9._:-]{8,128}$/.test(incomingRequestId) ? incomingRequestId : crypto.randomUUID();
  res.set(HEADERS.requestId, req.protocolRequestId);

  try {
    req.protocolVersion = assertCompatibleVersion(req.get(HEADERS.protocol));
    return next();
  } catch (error) {
    if (error instanceof ProtocolError) {
      return fail(res, error.message, 426, error.details, error.code);
    }
    return fail(res, '协议握手失败', 426, null, ERROR_CODES.unsupportedProtocol);
  }
}

module.exports = { requireAgentProtocol };
