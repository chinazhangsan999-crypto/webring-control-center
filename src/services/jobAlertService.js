'use strict';

const { one, query } = require('../db');
const { classifyJobError } = require('./jobQueueService');
const { npmCdnUrls } = require('./npmPublishService');

function platformLine(name, value) {
  const labels = { succeeded: '\u5df2\u6210\u529f', failed: '\u5931\u8d25', running: '\u6267\u884c\u4e2d', pending: '\u672a\u6267\u884c', skipped: '\u672a\u542f\u7528' };
  const sources = { global: '\u5168\u5c40\u8d26\u53f7', site: '\u672c\u7ad9\u72ec\u7acb\u8d26\u53f7', disabled: '\u672a\u542f\u7528' };
  const source = value?.account_source ? `\uff08${sources[value.account_source] || value.account_source}\uff09` : '';
  return `${name}\uff1a${labels[value?.status] || '\u672a\u6267\u884c'}${source}`;
}

async function enqueueAlert(payload, siteId = null, client = null) {
  const executor = client || { query };
  const result = await executor.query(`INSERT INTO jobs(type,site_id,status,payload,max_attempts,priority,progress_total)
    VALUES('alert.send',$1,'queued',$2::jsonb,1,100,1) RETURNING *`, [siteId, JSON.stringify(payload)]);
  return result.rows[0];
}

async function enqueueJobAlert(job, outcome, result = {}, error = null) {
  if (job.type === 'alert.send') return null;
  const site = job.site_id ? await one(`SELECT s.name,s.public_url,p.permanent_url,p.github_pages_url,p.npm_enabled,p.npm_package_name,p.npm_cdn_lines,p.npm_primary_cdn
    FROM sites s LEFT JOIN publish_pages p ON p.site_id=s.id WHERE s.id=$1`, [job.site_id]) : null;
  const success = outcome === 'succeeded';
  const lines = [
    `\u4efb\u52a1编号\uff1a#${job.id}`,
    `\u4efb\u52a1类型\uff1a${job.type}`,
    `\u5904\u7406结果\uff1a${success ? '\u6267\u884c\u6210\u529f' : '\u6700\u7ec8\u5931\u8d25'}`,
    `\u76ee\u6807站点\uff1a${site?.name || '\u5168\u5c40任\u52a1'}`
  ];
  if (site?.public_url) lines.push(`\u7ad9\u70b9地址\uff1a${site.public_url}`);
  if (site?.permanent_url) lines.push(`\u6c38\u4e45发布地址\uff1a${site.permanent_url}`);
  if (site?.github_pages_url) lines.push(`GitHub \u53d1\u5e03地址\uff1a${site.github_pages_url}`);
  if (site?.npm_enabled && site?.npm_package_name) {
    const cdns = result?.platforms?.npm?.cdns || npmCdnUrls(site.npm_package_name, 'latest', site.npm_cdn_lines, site.npm_primary_cdn);
    for (const item of cdns) {
      const prefix = item.page_entry ? 'npm 网页入口' : 'npm 包分发';
      lines.push(item.page_entry
        ? `${prefix} ${item.label || item.provider}：${item.url || ''}${item.status ? `（${item.status}）` : ''}`
        : `${prefix} ${item.label || item.provider}：不作为网页入口${item.status ? `（${item.status}）` : ''}`);
    }
  }
  if (job.type === 'publish.deploy') {
    const platforms = result?.platforms || error?.progress?.platforms || {};
    lines.push(platformLine('Cloudflare', platforms.cloudflare), platformLine('GitHub', platforms.github), platformLine('npm', platforms.npm), platformLine('Notion', platforms.notion));
  }
  if (!success) {
    lines.push(`错误分类：${classifyJobError(error)}`);
    lines.push(`失败原因：${String(error?.message || error || '未知错误').slice(0, 1500)}`);
  }
  lines.push(`执行次数：${Number(job.attempts || 0)}/${Number(job.max_attempts || 0)}`);
  lines.push(`\u68c0\u6d4b时间\uff1a${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'medium', hour12: false }).format(new Date())}`);
  return enqueueAlert({ event_type: success ? 'job_succeeded' : 'job_failed', severity: success ? 'info' : 'error', title: success ? '\u4efb\u52a1执行完成' : '\u4efb\u52a1执行失\u8d25', body: lines.join('\n'), source_job_id: job.id }, job.site_id);
}

module.exports = { enqueueAlert, enqueueJobAlert };
