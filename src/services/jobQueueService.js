'use strict';

function classifyJobError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  const status = Number(error?.detail?.status || error?.status || 0);
  if (status === 401 || status === 403 || /token|credential|unauthor|forbidden|oidc|trusted publisher|e401|e403|\u51ed\u636e|\u5bc6\u94a5/.test(message)) return 'AUTH';
  if (status === 429 || /rate.?limit|too many|\u9650\u6d41/.test(message)) return 'RATE_LIMIT';
  if (/timeout|timed out|abort|\u8d85\u65f6/.test(message)) return 'TIMEOUT';
  if (/npm.*\u7248\u672c.*\u51b2\u7a81|\u7cbe\u786e\u7248\u672c\u5df2\u5b58\u5728/.test(message)) return 'NPM_VERSION_CONFLICT';
  if (/revision|\u4fee\u8ba2|\u914d\u7f6e\u5df2\u53d8\u5316|\u8282\u70b9\u5df2\u53d8\u5316/.test(message)) return 'STALE_REVISION';
  if (error?.retryable === false || /\u7f3a\u5c11|\u4e0d\u5408\u6cd5|\u683c\u5f0f/.test(message)) return 'CONFIG';
  if (/fetch|network|socket|dns|econn|enotfound|\u7f51\u7edc|\u8fde\u63a5/.test(message)) return 'NETWORK';
  return 'UNKNOWN';
}

function retryDelaySeconds(attempts) {
  const completedAttempts = Math.max(1, Number(attempts) || 1);
  return Math.min(600, 30 * (4 ** (completedAttempts - 1)));
}

function completedPublishSteps(platforms = {}) {
  const finished = ['succeeded', 'failed'];
  return 1 + ['cloudflare', 'github', 'npm'].filter(name => finished.includes(platforms[name]?.status)).length;
}

module.exports = { classifyJobError, retryDelaySeconds, completedPublishSteps };
