'use strict';

const fs = require('fs/promises');
const path = require('path');
const { query, one, transaction } = require('../db');
const { renderPublishBundle } = require('../../packages/publish-page-template/render');
const ControlService = require('./controlService');
const PublishDeploymentService = require('./publishDeploymentService');
const AlertService = require('./alertService');
const JobAlertService = require('./jobAlertService');
const PlatformSettingsService = require('./platformSettingsService');
const { classifyJobError, retryDelaySeconds, completedPublishSteps } = require('./jobQueueService');
const { npmVersionForJob, npmPageUrl, npmCdnUrls, npmPackageFiles } = require('./npmPublishService');

let stopped = true;
let timer = null;
let activeRun = null;
let startedAt = null;
let lastTickAt = null;
let lastWorkerError = '';

function publishEntries(site, nodes = []) {
  const manualEntries = Array.isArray(site.payload?.entries) ? site.payload.entries : [];
  const enabledNodes = nodes
    .filter(node => node.enabled !== false)
    .map(node => ({ name: node.speed_name, url: node.url, note: node.partner_name }));
  return [
    { name: '主站官方入口', url: site.public_url, note: site.name, official: true },
    ...enabledNodes,
    ...manualEntries
  ];
}

async function claimJob() {
  return transaction(async client => {
    const result = await client.query(`SELECT * FROM jobs WHERE status='queued' AND available_at<=NOW() AND attempts<max_attempts
      ORDER BY priority DESC,available_at,id FOR UPDATE SKIP LOCKED LIMIT 1`);
    const job = result.rows[0];
    if (!job) return null;
    await client.query("UPDATE jobs SET status='running',attempts=attempts+1,started_at=NOW(),heartbeat_at=NOW(),error_code='' WHERE id=$1", [job.id]);
    return { ...job, attempts: job.attempts + 1 };
  });
}

async function preparePublishPage(siteId, options = {}) {
  const site = await one(`SELECT s.name,s.slug,s.public_url,p.*,r.nodes_revision,r.publish_revision
    FROM sites s JOIN publish_pages p ON p.site_id=s.id JOIN site_revisions r ON r.site_id=s.id WHERE s.id=$1`, [siteId]);
  if (!site) throw new Error('发布页对应站点不存在');
  if (options.publishRevision && Number(options.publishRevision) !== Number(site.publish_revision)) {
    throw new PublishDeploymentService.DeploymentError('发布页配置已变化，请重新创建发布任务', { retryable: false });
  }
  if (options.nodesRevision && Number(options.nodesRevision) !== Number(site.nodes_revision)) {
    throw new PublishDeploymentService.DeploymentError('站点节点已变化，请重新创建发布任务', { retryable: false });
  }
  const effectiveConfig = await ControlService.resolveSiteConfig(siteId);
  const entries = publishEntries(site, effectiveConfig.nodes);
  const settings = await PlatformSettingsService.safeSettings();
  const npmLines = site.npm_cdn_mode === 'custom' ? site.npm_cdn_lines : settings.npm.lines;
  const npmPrimary = site.npm_cdn_mode === 'custom' ? site.npm_primary_cdn : settings.npm.primary;
  const npmUrls = site.npm_enabled ? npmCdnUrls(site.npm_package_name, 'latest', npmLines, npmPrimary) : [];
  const npmUrl = npmUrls.find(item => item.primary)?.url || '';
  const bundle = renderPublishBundle({ siteName: site.name, siteUrl: site.public_url, logoUrl: site.payload?.logo_url, headline: site.payload?.page_title, description: site.payload?.description, announcement: site.payload?.announcement, permanentUrl: site.permanent_url, githubPagesUrl: site.github_pages_url, npmPageUrl: npmUrl, npmPageUrls: npmUrls, contactEmail: site.contact_email, entries, generatedAt: options.generatedAt });
  return { site, bundle, npmLines, npmPrimary, npmUrls };
}

async function renderPublishPreview(siteId) {
  const { bundle } = await preparePublishPage(siteId);
  return bundle['index.html'];
}

async function buildPublishPage(job, options = {}) {
  const { site, bundle, npmLines, npmPrimary } = await preparePublishPage(job.site_id, {
    publishRevision: job.payload?.publish_revision,
    nodesRevision: job.payload?.nodes_revision,
    generatedAt: options.generatedAt
  });
  const npmVersion = site.npm_enabled ? npmVersionForJob(job.id) : '';
  if (site.npm_enabled) Object.assign(bundle, npmPackageFiles({ packageName: site.npm_package_name, version: npmVersion, githubRepo: site.github_repo, siteName: site.name }));
  const outputRoot = path.join(__dirname, '..', '..', 'var', 'publish-pages');
  const siteDirectory = path.join(outputRoot, site.slug);
  await fs.rm(siteDirectory, { recursive: true, force: true });
  await fs.mkdir(siteDirectory, { recursive: true });
  const names = Object.keys(bundle).filter(name => name !== 'publish-manifest.json');
  names.push('publish-manifest.json');
  for (const name of names) {
    const destination = path.join(siteDirectory, name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const temporary = path.join(path.dirname(destination), `.${path.basename(name)}.${process.pid}.tmp`);
    await fs.writeFile(temporary, bundle[name], 'utf8');
    await fs.rename(temporary, destination);
  }
  const html = bundle['index.html'];
  return { output: path.join(siteDirectory, 'index.html'), directory: siteDirectory, files: names, bytes: Buffer.byteLength(html), manifest: JSON.parse(bundle['publish-manifest.json']), github_repo: site.github_repo, cloudflare_project: site.cloudflare_project, permanent_url: site.permanent_url, github_pages_url: site.github_pages_url, npm_package_name: site.npm_enabled ? site.npm_package_name : '', npm_version: npmVersion, npm_page_url: site.npm_enabled ? npmPageUrl(site.npm_package_name, 'latest', npmPrimary) : '', npm_cdn_lines: site.npm_enabled ? npmLines : [], npm_primary_cdn: site.npm_enabled ? npmPrimary : '', publish_revision: site.publish_revision, nodes_revision: site.nodes_revision };
}

async function saveJobProgress(jobId, result, current = null, total = null) {
  await query(`UPDATE jobs SET result=$2::jsonb,heartbeat_at=NOW(),
    progress_current=COALESCE($3,progress_current),progress_total=COALESCE($4,progress_total) WHERE id=$1`, [jobId, JSON.stringify(result), current, total]);
}

async function runPublishWorkflow(job, dependencies = {}) {
  const previous = job.result && typeof job.result === 'object' ? job.result : {};
  const build = await buildPublishPage(job, { generatedAt: previous.build?.manifest?.generated_at });
  const expectedRevisions = {
    publish_revision: job.payload?.publish_revision ?? build.publish_revision,
    nodes_revision: job.payload?.nodes_revision ?? build.nodes_revision
  };
  if (job.payload?.publish_revision === undefined || job.payload?.nodes_revision === undefined) {
    job.payload = { ...(job.payload || {}), ...expectedRevisions };
    await query('UPDATE jobs SET payload=$2::jsonb WHERE id=$1', [job.id, JSON.stringify(job.payload)]);
  }
  const progress = { ...previous, build };
  const progressTotal = build.npm_package_name ? 4 : 3;
  await saveJobProgress(job.id, progress, 1, progressTotal);
  try {
    const platforms = await PublishDeploymentService.deployDualPlatform({
      directory: build.directory,
      files: build.files,
      sha256: build.manifest.sha256,
      githubRepo: build.github_repo,
      githubPagesUrl: build.github_pages_url,
      cloudflareProject: build.cloudflare_project,
      npmPackageName: build.npm_package_name,
      npmVersion: build.npm_version,
      permanentUrl: build.permanent_url,
      npmCdnLines: build.npm_cdn_lines,
      npmPrimaryCdn: build.npm_primary_cdn,
      credentials: await PlatformSettingsService.deploymentCredentials()
    }, previous.platforms || {}, {
      ...dependencies,
      onProgress: async platforms => saveJobProgress(job.id, { ...progress, platforms }, completedPublishSteps(platforms), progressTotal)
    });
    const current = await one('SELECT publish_revision,nodes_revision FROM site_revisions WHERE site_id=$1', [job.site_id]);
    if (!current || Number(current.publish_revision) !== Number(expectedRevisions.publish_revision) || Number(current.nodes_revision) !== Number(expectedRevisions.nodes_revision)) {
      throw new PublishDeploymentService.DeploymentError('发布期间站点配置发生变化，请创建新任务发布最新版本', { retryable: false, progress: platforms });
    }
    const cdns = platforms.npm?.cdns || [];
    if (cdns.length && build.npm_version) {
      await transaction(async client => {
        for (const item of cdns) {
          await client.query(`INSERT INTO npm_cdn_checks(site_id,package_version,provider,page_url,stable_url,status,http_status,content_type,manifest_sha256,attempts,last_error,checked_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,NOW())
            ON CONFLICT(site_id,package_version,provider) DO UPDATE SET page_url=EXCLUDED.page_url,stable_url=EXCLUDED.stable_url,status=EXCLUDED.status,http_status=EXCLUDED.http_status,content_type=EXCLUDED.content_type,manifest_sha256=EXCLUDED.manifest_sha256,attempts=npm_cdn_checks.attempts+1,last_error=EXCLUDED.last_error,checked_at=NOW()`, [job.site_id, build.npm_version, item.provider, item.url, npmPageUrl(build.npm_package_name, 'latest', item.provider), item.status, item.http_status, item.content_type || '', item.manifest_sha256 || '', item.last_error || '']);
        }
      });
    }
    return { ...progress, platforms };
  } catch (error) {
    error.progress = { ...progress, platforms: error.progress || {} };
    throw error;
  }
}

async function runJob(job) {
  const heartbeat = setInterval(() => query("UPDATE jobs SET heartbeat_at=NOW() WHERE id=$1 AND status='running'", [job.id]).catch(() => {}), 10_000);
  heartbeat.unref();
  try {
    const result = job.type === 'publish.deploy'
      ? await runPublishWorkflow(job)
      : job.type === 'alert.send'
        ? await AlertService.sendAlert(job.payload)
        : (() => { throw new Error(`没有任务处理器：${job.type}`); })();
    await query("UPDATE jobs SET status='succeeded',result=$2::jsonb,progress_current=progress_total,heartbeat_at=NOW(),finished_at=NOW(),last_error='',error_code='' WHERE id=$1", [job.id, JSON.stringify(result)]);
    if (job.type === 'publish.deploy') {
      await ControlService.audit({ type: 'system', id: 'publish-worker' }, 'publish.deploy.succeeded', 'site', job.site_id, { job_id: job.id, sha256: result.build.manifest.sha256 })
        .catch(auditError => console.error('发布成功审计写入失败', auditError));
    }
    await JobAlertService.enqueueJobAlert(job, 'succeeded', result).catch(alertError => console.error('任务成功告警入队失败', alertError));
  } catch (error) {
    const retry = error.retryable !== false && job.attempts < job.max_attempts;
    const result = error.results ? { channels: error.results } : error.progress || job.result || {};
    const errorCode = classifyJobError(error);
    const delay = retryDelaySeconds(job.attempts);
    await query(`UPDATE jobs SET status=$2,result=$3::jsonb,last_error=$4,error_code=$5,heartbeat_at=NOW(),started_at=CASE WHEN $2='queued' THEN NULL ELSE started_at END,
      finished_at=CASE WHEN $2='failed' THEN NOW() ELSE NULL END,available_at=CASE WHEN $2='queued' THEN NOW()+($6*INTERVAL '1 second') ELSE available_at END WHERE id=$1`, [job.id, retry ? 'queued' : 'failed', JSON.stringify(result), String(error.message || error).slice(0, 2000), errorCode, delay]);
    if (!retry && job.type === 'publish.deploy') {
      await ControlService.audit({ type: 'system', id: 'publish-worker' }, 'publish.deploy.failed', 'site', job.site_id, { job_id: job.id, error: String(error.message || error).slice(0, 500) })
        .catch(auditError => console.error('发布失败审计写入失败', auditError));
    }
    if (!retry) await JobAlertService.enqueueJobAlert(job, 'failed', result, error).catch(alertError => console.error('任务失败告警入队失败', alertError));
  } finally {
    clearInterval(heartbeat);
  }
}

async function recoverStaleJobs() {
  const recovered = await query(`UPDATE jobs SET
    status=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'queued' END,
    available_at=NOW(),started_at=NULL,heartbeat_at=NOW(),
    finished_at=CASE WHEN attempts>=max_attempts THEN NOW() ELSE NULL END,
    error_code='WORKER_INTERRUPTED',last_error='工作进程中断，任务已自动恢复'
    WHERE status='running' AND COALESCE(heartbeat_at,started_at,created_at)<NOW()-INTERVAL '5 minutes'
    RETURNING *`);
  for (const job of recovered.rows.filter(item => item.status === 'failed')) {
    await JobAlertService.enqueueJobAlert(job, 'failed', job.result, new Error(job.last_error)).catch(() => {});
  }
  return recovered.rows;
}

async function tick() {
  lastTickAt = new Date();
  try {
    const job = await claimJob();
    if (job) {
      activeRun = runJob(job);
      await activeRun;
    }
  }
  catch (error) { lastWorkerError = String(error.message || error).slice(0, 500); console.error('任务执行器错误', error); }
  finally { activeRun = null; if (!stopped) timer = setTimeout(tick, 1500); }
}

function startJobWorker() {
  if (!stopped) return;
  stopped = false;
  startedAt = new Date();
  recoverStaleJobs().then(tick).catch(error => { lastWorkerError = String(error.message || error).slice(0, 500); console.error('卡死任务恢复失败', error); tick(); });
}
async function stopJobWorker() {
  stopped = true;
  if (timer) clearTimeout(timer);
  if (activeRun) await activeRun;
}

function getWorkerStatus() {
  return { running: !stopped, busy: Boolean(activeRun), started_at: startedAt?.toISOString() || null, last_tick_at: lastTickAt?.toISOString() || null, last_error: lastWorkerError };
}

module.exports = { startJobWorker, stopJobWorker, getWorkerStatus, recoverStaleJobs, claimJob, publishEntries, preparePublishPage, renderPublishPreview, buildPublishPage, runPublishWorkflow, runJob };
