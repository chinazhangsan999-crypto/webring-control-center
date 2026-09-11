'use strict';

const crypto = require('crypto');

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function timingSafeEqualText(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(header = '') {
  return String(header).split(';').reduce((result, pair) => {
    const index = pair.indexOf('=');
    if (index <= 0) return result;
    result[decodeURIComponent(pair.slice(0, index).trim())] = decodeURIComponent(pair.slice(index + 1).trim());
    return result;
  }, {});
}

function normalizeHttpUrl(value, label = '地址') {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new Error(`${label}格式不正确`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${label}仅支持 HTTP/HTTPS`);
  parsed.hash = '';
  return parsed.href.replace(/\/$/, '');
}

function cleanSlug(value) {
  const slug = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) throw new Error('站点标识只能包含小写字母、数字和连字符，长度 2-63 位');
  return slug;
}

module.exports = { randomToken, sha256, timingSafeEqualText, parseCookies, normalizeHttpUrl, cleanSlug };
