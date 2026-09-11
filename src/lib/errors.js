'use strict';

class AppError extends Error {
  constructor(message, status = 400, code = 'INVALID_REQUEST', details = null) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function badRequest(message, details = null) { return new AppError(message, 400, 'INVALID_REQUEST', details); }
function notFound(message) { return new AppError(message, 404, 'NOT_FOUND'); }
function conflict(message) { return new AppError(message, 409, 'CONFLICT'); }

module.exports = { AppError, badRequest, notFound, conflict };
