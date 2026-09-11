'use strict';

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_RETRY_DELAY_MS = 1500;

class AlertDeliveryError extends Error {
  constructor(message, { channel = '', results = null } = {}) {
    super(message);
    this.name = 'AlertDeliveryError';
    this.channel = channel;
    this.results = results;
    this.retryable = false;
  }
}

function alertConfig(env = process.env) {
  const timeout = Number.parseInt(env.ALERT_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10);
  const retryDelay = Number.parseInt(env.ALERT_RETRY_DELAY_MS || String(DEFAULT_RETRY_DELAY_MS), 10);
  return {
    siteName: String(env.ALERT_SITE_NAME || '\u661f\u73af\u603b\u63a7').trim().slice(0, 100) || '\u661f\u73af\u603b\u63a7',
    telegramToken: String(env.ALERT_TELEGRAM_BOT_TOKEN || '').trim(),
    telegramChatId: String(env.ALERT_TELEGRAM_CHAT_ID || '').trim(),
    barkUrl: String(env.ALERT_BARK_URL || '').trim(),
    timeoutMs: Number.isSafeInteger(timeout) && timeout >= 1000 && timeout <= 30000 ? timeout : DEFAULT_TIMEOUT_MS,
    retryDelayMs: Number.isSafeInteger(retryDelay) && retryDelay >= 0 && retryDelay <= 10000 ? retryDelay : DEFAULT_RETRY_DELAY_MS
  };
}

function configuredChannels(config = alertConfig()) {
  return { telegram: Boolean(config.telegramToken && config.telegramChatId), bark: Boolean(config.barkUrl) };
}

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function splitText(text, maxCharacters = 3500) {
  const input = String(text || '');
  if (!input) return [''];
  const parts = [];
  let remaining = input;
  while (remaining.length > maxCharacters) {
    let point = remaining.lastIndexOf('\n', maxCharacters);
    if (point < Math.floor(maxCharacters * 0.55)) point = maxCharacters;
    parts.push(remaining.slice(0, point));
    remaining = remaining.slice(point).replace(/^\n+/, '');
  }
  if (remaining || !parts.length) parts.push(remaining);
  return parts;
}

function splitUtf8(text, maxBytes = 2500) {
  const parts = [];
  let current = '';
  for (const character of String(text || '')) {
    if (Buffer.byteLength(current + character, 'utf8') > maxBytes && current) {
      parts.push(current);
      current = character;
    } else current += character;
  }
  if (current || !parts.length) parts.push(current);
  return parts;
}

function markdownLinks(text) {
  return String(text || '').replace(/https?:\/\/[^\s<>()]+/g, value => `[${value}](${value})`);
}

async function requestJson(url, body, config, fetchImpl) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs)
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok || data?.ok === false || Number(data?.code || 200) >= 400) {
    throw new Error(String(data?.description || data?.message || text || `HTTP ${response.status}`).slice(0, 500));
  }
  return data;
}

async function sendTelegram(title, content, config, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || fetch;
  const waitImpl = dependencies.wait || wait;
  const parts = splitText(content, 3500);
  const messages = [];
  for (let index = 0; index < parts.length; index += 1) {
    const heading = parts.length > 1 ? `${title} (${index + 1}/${parts.length})` : title;
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const data = await requestJson(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
          chat_id: config.telegramChatId,
          text: `${heading}\n\n${parts[index]}`,
          link_preview_options: { is_disabled: true }
        }, config, fetchImpl);
        messages.push({ part: index + 1, message_id: data?.result?.message_id || null, attempts: attempt });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await waitImpl(config.retryDelayMs);
      }
    }
    if (lastError) throw lastError;
    if (index < parts.length - 1) await waitImpl(config.retryDelayMs);
  }
  return { status: 'succeeded', parts: messages.length, messages };
}

async function sendBark(title, content, config, dependencies = {}) {
  let url;
  try { url = new URL(config.barkUrl); } catch { throw new Error('ALERT_BARK_URL \u4e0d\u662f\u6709\u6548\u5730\u5740'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('ALERT_BARK_URL \u53ea\u5141\u8bb8 HTTP/HTTPS');
  const fetchImpl = dependencies.fetchImpl || fetch;
  const parts = splitUtf8(content, 2500);
  for (let index = 0; index < parts.length; index += 1) {
    const heading = parts.length > 1 ? `${title} (${index + 1}/${parts.length})` : title;
    await requestJson(url.href, { title: heading, body: parts[index], markdown: markdownLinks(parts[index]), group: '\u661f\u73af\u603b\u63a7', level: 'active' }, config, fetchImpl);
  }
  return { status: 'succeeded', parts: parts.length };
}

async function sendAlert(payload, dependencies = {}) {
  const config = dependencies.config || alertConfig();
  const channels = configuredChannels(config);
  const title = `\u3010${config.siteName}\u3011${String(payload?.title || '\u7cfb\u7edf\u901a\u77e5').trim().slice(0, 150)}`;
  const content = String(payload?.body || '').trim().slice(0, 50000);
  const results = {};
  if (channels.telegram) {
    try {
      results.telegram = await sendTelegram(title, content, config, dependencies);
      return { channel: 'telegram', title, results };
    } catch (error) {
      results.telegram = { status: 'failed', error: String(error.message || error).slice(0, 500) };
    }
  }
  if (channels.bark) {
    try {
      results.bark = await sendBark(title, content, config, dependencies);
      return { channel: 'bark', title, results };
    } catch (error) {
      results.bark = { status: 'failed', error: String(error.message || error).slice(0, 500) };
    }
  }
  const reason = !channels.telegram && !channels.bark ? '\u672a\u914d\u7f6e\u4efb\u4f55\u544a\u8b66\u901a\u9053' : 'Telegram \u4e0e Bark \u5747\u53d1\u9001\u5931\u8d25';
  throw new AlertDeliveryError(reason, { results });
}

module.exports = { AlertDeliveryError, alertConfig, configuredChannels, splitText, splitUtf8, markdownLinks, sendTelegram, sendBark, sendAlert };
