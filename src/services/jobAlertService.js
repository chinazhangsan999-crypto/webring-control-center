'use strict';

const { one, query } = require('../db');
const AlertService = require('./alertService');
const { classifyJobError } = require('./jobQueueService');

function platformLine(name, value) {
  const labels = { succeeded: '\u5df2\u6210\u529f', failed: '\u5931\u8d25', running: '\u6267\u884c\u4e2d', pending: '\u672a\u6267\u884c' };
  return `${name}\uff1a${labels[value?.status] || '\u672a\u6267\u884c'}`;
}

async function enqueueAlert(payload, siteId = null, client = null) {
  if (!Object.values(AlertService.configuredChannels()).some(Boolean)) return null;
  const executor = client || { query };
  const result = await executor.query(`INSERT INTO jobs(type,site_id,status,payload,max_attempts,priority,progress_total)
    VALUES('alert.send',$1,'queued',$2::jsonb,1,100,1) RETURNING *`, [siteId, JSON.stringify(payload)]);
  return result.rows[0];
}

async function enqueueJobAlert(job, outcome, result = {}, error = null) {
  if (job.type === 'alert.send') return null;
  const site = job.site_id ? await one(`SELECT s.name,s.public_url,p.permanent_url,p.github_pages_url
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
  if (job.type === 'publish.deploy') {
    const platforms = result?.platforms || error?.progress?.platforms || {};
    lines.push(platformLine('Cloudflare', platforms.cloudflare), platformLine('GitHub', platforms.github));
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
