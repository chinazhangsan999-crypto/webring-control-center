'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');

const execFileAsync = promisify(execFile);
const { npmPageUrl, npmCdnUrls, resolveNpmPageEntryProvider } = require('./npmPublishService');
const { syncNotionPage } = require('./notionPublishService');
const GITHUB_API = 'https://api.github.com';
const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const GITHUB_API_VERSION = '2026-03-10';

class DeploymentError extends Error {
  constructor(message, { platform = '', retryable = true, detail = null, progress = null } = {}) {
    super(message);
    this.name = 'DeploymentError';
    this.platform = platform;
    this.retryable = retryable;
    this.detail = detail;
    this.progress = progress;
  }
}

function deploymentCredentials(env = process.env) {
  return {
    githubToken: String(env.PUBLISH_GITHUB_TOKEN || '').trim(),
    githubBranch: String(env.PUBLISH_GITHUB_BRANCH || 'gh-pages').trim(),
    cloudflareToken: String(env.PUBLISH_CLOUDFLARE_API_TOKEN || '').trim(),
    cloudflareAccountId: String(env.PUBLISH_CLOUDFLARE_ACCOUNT_ID || '').trim(),
    cloudflareBranch: String(env.PUBLISH_CLOUDFLARE_BRANCH || 'main').trim(),
    notionToken: String(env.NOTION_INTEGRATION_TOKEN || '').trim()
  };
}

function parseGithubRepo(value) {
  const match = String(value || '').trim().match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) throw new DeploymentError('GitHub 仓库必须使用 owner/repository 格式', { platform: 'github', retryable: false });
  return { owner: match[1], repo: match[2] };
}

async function requestJson(fetchImpl, url, { method = 'GET', headers = {}, body, allowed = [] } = {}) {
  const response = await fetchImpl(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000)
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok && !allowed.includes(response.status)) {
    const message = data?.message || data?.errors?.[0]?.message || text || `HTTP ${response.status}`;
    throw new DeploymentError(String(message).slice(0, 500), { retryable: response.status === 429 || response.status >= 500, detail: { status: response.status } });
  }
  return { status: response.status, data };
}

function githubHeaders(token) {
  if (!token) throw new DeploymentError('缺少 PUBLISH_GITHUB_TOKEN', { platform: 'github', retryable: false });
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': 'webring-control-center'
  };
}

async function githubRequest(fetchImpl, token, endpoint, options = {}) {
  try {
    return await requestJson(fetchImpl, `${GITHUB_API}${endpoint}`, { ...options, headers: { ...githubHeaders(token), ...(options.headers || {}) } });
  } catch (error) {
    if (error instanceof DeploymentError) error.platform = 'github';
    throw error;
  }
}

async function readBundleFiles(directory, fileNames) {
  const files = [];
  for (const name of fileNames) {
    if (!/^(?:index\.html|404\.html|\.nojekyll|_headers|publish-manifest\.json|package\.json|README\.md|\.github\/workflows\/publish-npm\.yml)$/.test(name)) {
      throw new DeploymentError(`发布包包含不允许的文件：${name}`, { retryable: false });
    }
    files.push({ name, content: await fs.readFile(path.join(directory, name)) });
  }
  return files;
}

async function resolveGithubRepository(fetchImpl, githubToken, owner, repo) {
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const existing = await githubRequest(fetchImpl, githubToken, base, { allowed: [404] });
  if (existing.status === 200) return { repository: existing.data, created: false };

  const identity = (await githubRequest(fetchImpl, githubToken, '/user')).data;
  const personal = String(identity?.login || '').toLowerCase() === owner.toLowerCase();
  const endpoint = personal ? '/user/repos' : `/orgs/${encodeURIComponent(owner)}/repos`;
  try {
    const created = await githubRequest(fetchImpl, githubToken, endpoint, {
      method: 'POST',
      body: {
        name: repo,
        description: '永久发布页（由星环总控自动维护）',
        private: false,
        auto_init: true
      }
    });
    return { repository: created.data, created: true };
  } catch (error) {
    if (error instanceof DeploymentError && error.detail?.status === 422) {
      throw new DeploymentError(`GitHub 仓库 ${owner}/${repo} 已存在，但当前 Token 无权访问`, {
        platform: 'github', retryable: false, detail: error.detail
      });
    }
    if (error instanceof DeploymentError && error.detail?.status === 404 && !personal) {
      throw new DeploymentError(`GitHub 账号 ${owner} 不是当前 Token 用户或可管理的组织`, {
        platform: 'github', retryable: false, detail: error.detail
      });
    }
    throw error;
  }
}

async function deployGithubPages(input, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || fetch;
  const { githubToken, githubBranch } = input.credentials;
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(githubBranch) || githubBranch.startsWith('/') || githubBranch.endsWith('/')) {
    throw new DeploymentError('PUBLISH_GITHUB_BRANCH 不合法', { platform: 'github', retryable: false });
  }
  const { owner, repo } = parseGithubRepo(input.githubRepo);
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const resolvedRepository = await resolveGithubRepository(fetchImpl, githubToken, owner, repo);
  const repository = resolvedRepository.repository;
  const targetRef = await githubRequest(fetchImpl, githubToken, `${base}/git/ref/heads/${githubBranch.split('/').map(encodeURIComponent).join('/')}`, { allowed: [404] });
  let parentSha = targetRef.status === 200 ? targetRef.data.object.sha : '';
  if (!parentSha) {
    const defaultBranch = repository.default_branch;
    const sourceRef = await githubRequest(fetchImpl, githubToken, `${base}/git/ref/heads/${encodeURIComponent(defaultBranch)}`);
    parentSha = sourceRef.data.object.sha;
  }

  const files = await readBundleFiles(input.directory, input.files);
  const blobs = await Promise.all(files.map(async file => {
    const result = await githubRequest(fetchImpl, githubToken, `${base}/git/blobs`, {
      method: 'POST', body: { content: file.content.toString('base64'), encoding: 'base64' }
    });
    return { path: file.name, mode: '100644', type: 'blob', sha: result.data.sha };
  }));
  const tree = await githubRequest(fetchImpl, githubToken, `${base}/git/trees`, { method: 'POST', body: { tree: blobs } });
  const commit = await githubRequest(fetchImpl, githubToken, `${base}/git/commits`, {
    method: 'POST', body: { message: `发布永久页 ${input.sha256.slice(0, 12)}`, tree: tree.data.sha, parents: [parentSha] }
  });
  const refBody = { ref: `refs/heads/${githubBranch}`, sha: commit.data.sha };
  if (targetRef.status === 200) {
    await githubRequest(fetchImpl, githubToken, `${base}/git/refs/heads/${githubBranch.split('/').map(encodeURIComponent).join('/')}`, { method: 'PATCH', body: { sha: commit.data.sha, force: false } });
  } else {
    await githubRequest(fetchImpl, githubToken, `${base}/git/refs`, { method: 'POST', body: refBody });
  }

  const pages = await githubRequest(fetchImpl, githubToken, `${base}/pages`, { allowed: [404] });
  if (pages.status === 404) {
    await githubRequest(fetchImpl, githubToken, `${base}/pages`, { method: 'POST', body: { build_type: 'legacy', source: { branch: githubBranch, path: '/' } } });
  } else if (pages.data?.source?.branch !== githubBranch || pages.data?.source?.path !== '/') {
    await githubRequest(fetchImpl, githubToken, `${base}/pages`, { method: 'PUT', body: { build_type: 'legacy', source: { branch: githubBranch, path: '/' } } });
  }
  await githubRequest(fetchImpl, githubToken, `${base}/pages/builds`, { method: 'POST', allowed: [409] });
  return { commit_sha: commit.data.sha, branch: githubBranch, url: input.githubPagesUrl, repository_created: resolvedRepository.created };
}

function cloudflareHeaders(token) {
  if (!token) throw new DeploymentError('缺少 PUBLISH_CLOUDFLARE_API_TOKEN', { platform: 'cloudflare', retryable: false });
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function redactSecret(value, secret) {
  const text = String(value || '');
  return secret ? text.split(secret).join('[REDACTED]') : text;
}

async function cloudflareRequest(fetchImpl, token, endpoint, options = {}) {
  try {
    const response = await requestJson(fetchImpl, `${CLOUDFLARE_API}${endpoint}`, { ...options, headers: { ...cloudflareHeaders(token), ...(options.headers || {}) } });
    if (response.data && response.data.success === false && !(options.allowed || []).includes(response.status)) {
      throw new DeploymentError(response.data.errors?.[0]?.message || 'Cloudflare API 请求失败', { platform: 'cloudflare' });
    }
    return response;
  } catch (error) {
    if (error instanceof DeploymentError) error.platform = 'cloudflare';
    throw error;
  }
}

function cloudflareZoneCandidates(hostname) {
  const labels = String(hostname || '').toLowerCase().split('.').filter(Boolean);
  return labels.slice(0, -1).map((_, index) => labels.slice(index).join('.'));
}

async function findCloudflareZone(fetchImpl, token, accountId, hostname) {
  for (const name of cloudflareZoneCandidates(hostname)) {
    const search = new URLSearchParams({ name, 'account.id': accountId, status: 'active', per_page: '1' });
    const response = await cloudflareRequest(fetchImpl, token, `/zones?${search}`);
    const zone = Array.isArray(response.data?.result) ? response.data.result[0] : null;
    if (zone?.id) return zone;
  }
  return null;
}

async function ensureCloudflareDnsRecord(fetchImpl, token, accountId, hostname, targetHostname) {
  const zone = await findCloudflareZone(fetchImpl, token, accountId, hostname);
  if (!zone) {
    return { dns_status: 'manual_required', dns_warning: '自定义域名不属于当前 Cloudflare 账号中的活动 Zone，无法自动创建 DNS 记录' };
  }
  const search = new URLSearchParams({ name: hostname, per_page: '100' });
  const recordsResponse = await cloudflareRequest(fetchImpl, token, `/zones/${encodeURIComponent(zone.id)}/dns_records?${search}`);
  const records = Array.isArray(recordsResponse.data?.result) ? recordsResponse.data.result : [];
  const cname = records.find(record => record.type === 'CNAME');
  const conflict = records.find(record => ['A', 'AAAA', 'NS'].includes(record.type));
  if (!cname && conflict) {
    throw new DeploymentError(`自定义域名已有 ${conflict.type} 记录，不能自动改为 Pages CNAME；请先人工确认并删除冲突记录`, { platform: 'cloudflare', retryable: false });
  }
  const record = { type: 'CNAME', name: hostname, content: targetHostname, ttl: 1, proxied: true, comment: 'Managed by Webring Control Center' };
  if (!cname) {
    const created = await cloudflareRequest(fetchImpl, token, `/zones/${encodeURIComponent(zone.id)}/dns_records`, { method: 'POST', body: record });
    return { dns_status: 'configured', dns_zone: zone.name, dns_record_id: created.data?.result?.id || '', dns_record_created: true, dns_target: targetHostname };
  }
  const matches = String(cname.content || '').toLowerCase() === targetHostname.toLowerCase() && cname.proxied === true;
  if (!matches) {
    await cloudflareRequest(fetchImpl, token, `/zones/${encodeURIComponent(zone.id)}/dns_records/${encodeURIComponent(cname.id)}`, { method: 'PATCH', body: record });
  }
  return { dns_status: 'configured', dns_zone: zone.name, dns_record_id: cname.id, dns_record_created: false, dns_record_updated: !matches, dns_target: targetHostname };
}

async function ensureCloudflareTarget(input, fetchImpl) {
  const { cloudflareToken, cloudflareAccountId, cloudflareBranch } = input.credentials;
  if (!cloudflareAccountId) throw new DeploymentError('缺少 PUBLISH_CLOUDFLARE_ACCOUNT_ID', { platform: 'cloudflare', retryable: false });
  const project = encodeURIComponent(input.cloudflareProject);
  const root = `/accounts/${encodeURIComponent(cloudflareAccountId)}/pages/projects`;
  const existing = await cloudflareRequest(fetchImpl, cloudflareToken, `${root}/${project}`, { allowed: [404] });
  const projectState = existing.status === 404
    ? (await cloudflareRequest(fetchImpl, cloudflareToken, root, { method: 'POST', body: { name: input.cloudflareProject, production_branch: cloudflareBranch } })).data?.result
    : existing.data?.result;
  const hostname = new URL(input.permanentUrl).hostname.toLowerCase();
  const domain = await cloudflareRequest(fetchImpl, cloudflareToken, `${root}/${project}/domains/${encodeURIComponent(hostname)}`, { allowed: [404] });
  const configured = domain.status === 404
    ? (await cloudflareRequest(fetchImpl, cloudflareToken, `${root}/${project}/domains`, { method: 'POST', body: { name: hostname } })).data?.result
    : domain.data?.result;
  const pagesHostname = String(projectState?.subdomain || `${input.cloudflareProject}.pages.dev`).toLowerCase();
  const dns = await ensureCloudflareDnsRecord(fetchImpl, cloudflareToken, cloudflareAccountId, hostname, pagesHostname);
  return { hostname, domain_status: configured?.status || 'pending', ...dns };
}

async function deployCloudflarePages(input, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || fetch;
  const run = dependencies.execFileImpl || execFileAsync;
  const target = await ensureCloudflareTarget(input, fetchImpl);
  const wrangler = require.resolve('wrangler');
  const wranglerState = path.resolve(process.env.PUBLISH_WRANGLER_STATE_DIR || path.join(process.cwd(), 'var', '.wrangler'));
  const wranglerLegacyState = path.join(wranglerState, '.wrangler');
  const wranglerCache = path.join(wranglerState, 'cache');
  await Promise.all([
    fs.mkdir(wranglerState, { recursive: true }),
    fs.mkdir(wranglerLegacyState, { recursive: true }),
    fs.mkdir(wranglerCache, { recursive: true })
  ]);
  const args = [wrangler, 'pages', 'deploy', input.directory, '--project-name', input.cloudflareProject, '--branch', input.credentials.cloudflareBranch, '--commit-hash', input.sha256.slice(0, 40), '--commit-message', `发布永久页 ${input.sha256.slice(0, 12)}`];
  try {
    const { stdout = '', stderr = '' } = await run(process.execPath, args, {
      cwd: input.directory,
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: input.credentials.cloudflareToken,
        CLOUDFLARE_ACCOUNT_ID: input.credentials.cloudflareAccountId,
        HOME: wranglerState,
        USERPROFILE: wranglerState,
        XDG_CONFIG_HOME: wranglerState,
        XDG_CACHE_HOME: wranglerCache,
        WRANGLER_SEND_METRICS: 'false'
      }
    });
    const output = `${stdout}\n${stderr}`;
    const deploymentUrl = output.match(/https:\/\/[^\s]+\.pages\.dev\/?/i)?.[0] || '';
    return { deployment_url: deploymentUrl, custom_url: input.permanentUrl, project: input.cloudflareProject, ...target };
  } catch (error) {
    const detail = redactSecret(error.stderr || error.message || error, input.credentials.cloudflareToken).slice(0, 500);
    throw new DeploymentError(`Wrangler 发布失败：${detail}`, { platform: 'cloudflare', retryable: true });
  }
}

async function triggerNpmPublish(input, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || fetch;
  const { githubToken, githubBranch } = input.credentials;
  const { owner, repo } = parseGithubRepo(input.githubRepo);
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const branchPath = githubBranch.split('/').map(encodeURIComponent).join('/');
  const targetRef = await githubRequest(fetchImpl, githubToken, `${base}/git/ref/heads/${branchPath}`);
  const parentSha = targetRef.data?.object?.sha;
  if (!parentSha) throw new DeploymentError('GitHub Pages 分支不存在，无法触发 npm 发布', { platform: 'npm', retryable: true });
  const parent = await githubRequest(fetchImpl, githubToken, `${base}/git/commits/${encodeURIComponent(parentSha)}`);
  const blob = await githubRequest(fetchImpl, githubToken, `${base}/git/blobs`, {
    method: 'POST',
    body: { content: `${input.npmVersion}\n${input.sha256}\n${new Date().toISOString()}\n`, encoding: 'utf-8' }
  });
  const tree = await githubRequest(fetchImpl, githubToken, `${base}/git/trees`, {
    method: 'POST',
    body: { base_tree: parent.data.tree.sha, tree: [{ path: '.npm-publish-trigger', mode: '100644', type: 'blob', sha: blob.data.sha }] }
  });
  const commit = await githubRequest(fetchImpl, githubToken, `${base}/git/commits`, {
    method: 'POST',
    body: { message: `触发 npm 发布 ${input.npmVersion}`, tree: tree.data.sha, parents: [parentSha] }
  });
  await githubRequest(fetchImpl, githubToken, `${base}/git/refs/heads/${branchPath}`, {
    method: 'PATCH', body: { sha: commit.data.sha, force: false }
  });
  return { trigger_commit_sha: commit.data.sha };
}

async function deployNpmPackage(input, dependencies = {}) {
  const verify = dependencies.verify || verifyPublishedManifest;
  const primary = resolveNpmPageEntryProvider(input.npmCdnLines || ['unpkg'], input.npmPrimaryCdn) || 'unpkg';
  // UNPKG remains the registry-publication confirmation source; selected CDNs may sync later.
  const exactUrl = npmPageUrl(input.npmPackageName, input.npmVersion, 'unpkg');
  const stableUrl = npmPageUrl(input.npmPackageName, 'latest', primary);
  const verificationStableUrl = npmPageUrl(input.npmPackageName, 'latest', 'unpkg');
  const exactBaseUrl = exactUrl.replace(/index\.html$/, '');
  const stableBaseUrl = verificationStableUrl.replace(/index\.html$/, '');
  const existing = await readPublishedManifest(exactBaseUrl, dependencies);
  if (existing && existing.sha256 !== input.sha256) {
    throw new DeploymentError('npm 版本内容冲突：该精确版本已存在且清单摘要不同，请创建新的发布任务', { platform: 'npm', retryable: false });
  }
  let triggered = {};
  let exact;
  try {
    if (existing) exact = { verified: true, manifest_url: existing.manifest_url };
    else {
      triggered = await (dependencies.triggerNpm || triggerNpmPublish)(input, dependencies);
      exact = await verify(exactBaseUrl, input.sha256, { ...dependencies, attempts: dependencies.npmAttempts || 60, intervalMs: dependencies.npmIntervalMs || 10_000 });
    }
    const stable = await verifyNpmStable(stableBaseUrl, input.sha256, dependencies);
    const cdns = await verifyNpmCdnLines(input, dependencies);
    return { ...triggered, package: input.npmPackageName, version: input.npmVersion, url: stableUrl, exact_url: exactUrl, exact_manifest_url: exact.manifest_url, manifest_url: stable.manifest_url || exact.manifest_url, stable_status: stable.status, stable_error: stable.error || '', cdns, already_published: Boolean(existing) };
  } catch (error) {
    if (error instanceof DeploymentError) error.platform = 'npm';
    throw error;
  }
}

async function readPublishedManifest(baseUrl, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || fetch;
  const manifestUrl = new URL('publish-manifest.json', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  manifestUrl.searchParams.set('check', 'exact');
  const response = await fetchImpl(manifestUrl, { cache: 'no-store', redirect: 'follow', signal: AbortSignal.timeout(10_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new DeploymentError(`npm 精确版本检查返回 HTTP ${response.status}`, { platform: 'npm', retryable: response.status >= 500 });
  let manifest;
  try { manifest = await response.json(); } catch { throw new DeploymentError('npm 精确版本返回的发布清单无效', { platform: 'npm', retryable: false }); }
  if (!/^[a-f0-9]{64}$/i.test(String(manifest?.sha256 || ''))) {
    throw new DeploymentError('npm 精确版本已存在但不包含有效发布清单', { platform: 'npm', retryable: false });
  }
  return { sha256: manifest.sha256, manifest_url: manifestUrl.origin + manifestUrl.pathname };
}

async function verifyNpmStable(baseUrl, expectedSha, dependencies = {}) {
  const verify = dependencies.verify || verifyPublishedManifest;
  try {
    const result = await verify(baseUrl, expectedSha, { ...dependencies, attempts: dependencies.npmStableAttempts || 3, intervalMs: dependencies.npmStableIntervalMs || 2_000 });
    return { status: 'available', manifest_url: result.manifest_url };
  } catch (error) {
    return { status: 'syncing', error: String(error.message || error).slice(0, 300) };
  }
}

async function verifyNpmCdnLine(item, expectedSha, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || fetch;
  const verify = dependencies.verify || verifyPublishedManifest;
  if (!item.page_entry) {
    if (item.provider === 'npmmirror') {
      return { ...item, status: 'package_mirror', http_status: null, content_type: '', last_error: '仅作为 npm 安装镜像，不参与网页入口检测', checked_at: new Date().toISOString() };
    }
    try {
      const baseUrl = item.url.replace(/index\.html$/, '');
      const manifest = await verify(baseUrl, expectedSha, { ...dependencies, attempts: dependencies.cdnAttempts || 3, intervalMs: dependencies.cdnIntervalMs || 2_000 });
      const response = await fetchImpl(item.url, { cache: 'no-store', redirect: 'follow', signal: AbortSignal.timeout(10_000) });
      const contentType = String(response.headers?.get?.('content-type') || '');
      if (!response.ok) return { ...item, status: 'syncing', http_status: response.status, content_type: contentType, last_error: `静态文件返回 HTTP ${response.status}` };
      return { ...item, status: 'package_available', http_status: response.status, content_type: contentType, manifest_sha256: expectedSha, manifest_url: manifest.manifest_url, checked_at: new Date().toISOString() };
    } catch (error) {
      return { ...item, status: 'syncing', http_status: null, content_type: '', last_error: String(error.message || error).slice(0, 300), checked_at: new Date().toISOString() };
    }
  }
  const baseUrl = item.url.replace(/index\.html$/, '');
  try {
    const manifest = await verify(baseUrl, expectedSha, { ...dependencies, attempts: dependencies.cdnAttempts || 3, intervalMs: dependencies.cdnIntervalMs || 2_000 });
    const response = await fetchImpl(item.url, { cache: 'no-store', redirect: 'follow', signal: AbortSignal.timeout(10_000) });
    const contentType = String(response.headers?.get?.('content-type') || '');
    const body = await response.text();
    if (!response.ok) return { ...item, status: 'syncing', http_status: response.status, content_type: contentType, last_error: `页面返回 HTTP ${response.status}` };
    if (!/text\/html/i.test(contentType) || !/<!doctype html/i.test(body)) return { ...item, status: 'incompatible', http_status: response.status, content_type: contentType, last_error: '未返回完整 HTML 页面' };
    return { ...item, status: 'available', http_status: response.status, content_type: contentType, manifest_sha256: expectedSha, manifest_url: manifest.manifest_url, checked_at: new Date().toISOString() };
  } catch (error) {
    return { ...item, status: 'syncing', http_status: null, content_type: '', last_error: String(error.message || error).slice(0, 300), checked_at: new Date().toISOString() };
  }
}

async function verifyNpmCdnLines(input, dependencies = {}) {
  const lines = npmCdnUrls(input.npmPackageName, input.npmVersion, input.npmCdnLines || ['unpkg'], input.npmPrimaryCdn || 'unpkg');
  return Promise.all(lines.map(item => verifyNpmCdnLine(item, input.sha256, dependencies)));
}

async function verifyPublishedManifest(baseUrl, expectedSha, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || fetch;
  const wait = dependencies.wait || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const attempts = dependencies.attempts || 18;
  const intervalMs = dependencies.intervalMs || 5_000;
  const manifestUrl = new URL('publish-manifest.json', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  manifestUrl.searchParams.set('verify', expectedSha.slice(0, 16));
  let lastError = '尚未读取到发布清单';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(manifestUrl, { cache: 'no-store', redirect: 'follow', signal: AbortSignal.timeout(10_000) });
      if (response.ok) {
        const manifest = await response.json();
        if (manifest?.sha256 === expectedSha) return { verified: true, manifest_url: manifestUrl.origin + manifestUrl.pathname };
        lastError = '远端清单版本尚未更新';
      } else lastError = `远端返回 HTTP ${response.status}`;
    } catch (error) { lastError = String(error.message || error).slice(0, 300); }
    if (attempt + 1 < attempts) await wait(intervalMs);
  }
  throw new DeploymentError(`发布后校验失败：${lastError}`, { retryable: true });
}

async function deployDualPlatform(input, previous = {}, dependencies = {}) {
  const startedAt = new Date().toISOString();
  const enabled = input.enabledPlatforms || { github: true, cloudflare: true, npm: Boolean(input.npmPackageName), notion: Boolean(input.notionSyncEnabled) };
  const source = input.accountSources || {};
  const skipReasons = input.platformSkipReasons || {};
  const initial = platform => enabled[platform]
    ? (previous[platform]?.status === 'succeeded' ? previous[platform] : { status: platform === 'github' || platform === 'cloudflare' ? 'running' : 'pending', account_source: source[platform] || 'global', started_at: startedAt })
    : { status: 'skipped', account_source: skipReasons[platform] ? (source[platform] || 'global') : 'disabled', reason: skipReasons[platform]?.reason || '该站点未启用此平台', ...(skipReasons[platform]?.code ? { reason_code: skipReasons[platform].code } : {}) };
  const progress = {
    github: initial('github'),
    cloudflare: initial('cloudflare'),
    npm: initial('npm'),
    notion: initial('notion')
  };
  await dependencies.onProgress?.(progress);
  const tasks = [];
  if (enabled.github && progress.github.status !== 'succeeded') tasks.push(['github', async () => {
    const deployed = await (dependencies.deployGithub || deployGithubPages)(input, dependencies);
    const verified = await (dependencies.verify || verifyPublishedManifest)(input.githubPagesUrl, input.sha256, dependencies);
    return { status: 'succeeded', account_source: source.github || 'global', ...deployed, ...verified, finished_at: new Date().toISOString() };
  }]);
  if (enabled.cloudflare && progress.cloudflare.status !== 'succeeded') tasks.push(['cloudflare', async () => {
    const deployed = await (dependencies.deployCloudflare || deployCloudflarePages)(input, dependencies);
    if (!deployed.deployment_url) {
      throw new DeploymentError('Cloudflare 未返回本次部署地址，无法校验发布内容', { platform: 'cloudflare', retryable: true });
    }
    const verified = await (dependencies.verify || verifyPublishedManifest)(deployed.deployment_url, input.sha256, dependencies);
    let customDomain = {};
    if (deployed.domain_status === 'active') {
      const customVerified = await (dependencies.verify || verifyPublishedManifest)(input.permanentUrl, input.sha256, dependencies);
      customDomain = { custom_domain_verified: true, custom_manifest_url: customVerified.manifest_url };
    } else {
      customDomain = { custom_domain_verified: false, custom_domain_warning: '页面已发布，自定义域名仍在等待 DNS/Cloudflare 验证' };
    }
    return { status: 'succeeded', account_source: source.cloudflare || 'global', ...deployed, ...verified, ...customDomain, finished_at: new Date().toISOString() };
  }]);
  const settled = await Promise.all(tasks.map(([, task]) => task().then(value => ({ value }), error => ({ error }))));
  settled.forEach((item, index) => {
    const platform = tasks[index][0];
    progress[platform] = item.error
      ? { status: 'failed', account_source: source[platform] || 'global', error: String(item.error.message || item.error).slice(0, 500), retryable: item.error.retryable !== false, finished_at: new Date().toISOString() }
      : item.value;
  });
  await dependencies.onProgress?.(progress);
  if (enabled.npm && input.npmPackageName && progress.npm.status !== 'succeeded') {
    if (progress.github.status !== 'succeeded') {
      progress.npm = { status: 'failed', account_source: source.npm || 'global', error: 'GitHub Pages 发布失败，未触发 npm OIDC 工作流', retryable: progress.github.retryable !== false, finished_at: new Date().toISOString() };
    } else {
      progress.npm = { status: 'running', account_source: source.npm || 'global', started_at: new Date().toISOString() };
      await dependencies.onProgress?.(progress);
      try {
        const deployed = await (dependencies.deployNpm || deployNpmPackage)(input, dependencies);
        progress.npm = { status: 'succeeded', account_source: source.npm || 'global', ...deployed, finished_at: new Date().toISOString() };
      } catch (error) {
        progress.npm = { status: 'failed', account_source: source.npm || 'global', error: String(error.message || error).slice(0, 500), retryable: error.retryable !== false, finished_at: new Date().toISOString() };
      }
      await dependencies.onProgress?.(progress);
    }
  }
  if (enabled.notion && input.notionSyncEnabled && progress.notion.status !== 'succeeded') {
    progress.notion = { status: 'running', account_source: source.notion || 'global', started_at: new Date().toISOString() };
    await dependencies.onProgress?.(progress);
    try {
      const synced = await (dependencies.syncNotion || syncNotionPage)({
        token: input.credentials.notionToken,
        pageId: input.notionPageId,
        publicUrl: input.notionPublicUrl,
        previousBlockId: input.notionSyncBlockId,
        siteName: input.notionSiteName,
        permanentUrl: input.permanentUrl,
        githubPagesUrl: input.githubPagesUrl,
        npmPageUrl: input.npmPageUrl,
        npmPageUrls: input.npmPageUrls,
        entries: input.notionEntries,
        generatedAt: input.generatedAt,
        sha256: input.sha256
      }, dependencies);
      progress.notion = { status: 'succeeded', account_source: source.notion || 'global', ...synced, finished_at: new Date().toISOString() };
    } catch (error) {
      progress.notion = { status: 'failed', account_source: source.notion || 'global', error: String(error.message || error).slice(0, 500), retryable: error.retryable !== false, finished_at: new Date().toISOString() };
    }
    await dependencies.onProgress?.(progress);
  }
  const failures = Object.entries(progress).filter(([, result]) => result.status === 'failed');
  if (failures.length) {
    throw new DeploymentError(failures.map(([platform, result]) => `${platform}: ${result.error}`).join('；'), {
      retryable: failures.some(([, result]) => result.retryable !== false), progress
    });
  }
  return progress;
}

module.exports = {
  DeploymentError,
  deploymentCredentials,
  parseGithubRepo,
  readBundleFiles,
  deployGithubPages,
  deployCloudflarePages,
  triggerNpmPublish,
  deployNpmPackage,
  verifyNpmCdnLine,
  verifyNpmCdnLines,
  readPublishedManifest,
  redactSecret,
  verifyPublishedManifest,
  deployDualPlatform
};
