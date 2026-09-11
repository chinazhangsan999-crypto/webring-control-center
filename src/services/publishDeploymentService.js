'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');

const execFileAsync = promisify(execFile);
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
    cloudflareBranch: String(env.PUBLISH_CLOUDFLARE_BRANCH || 'main').trim()
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
    if (!/^(?:index\.html|404\.html|\.nojekyll|_headers|publish-manifest\.json)$/.test(name)) {
      throw new DeploymentError(`发布包包含不允许的文件：${name}`, { retryable: false });
    }
    files.push({ name, content: await fs.readFile(path.join(directory, name)) });
  }
  return files;
}

async function deployGithubPages(input, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || fetch;
  const { githubToken, githubBranch } = input.credentials;
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(githubBranch) || githubBranch.startsWith('/') || githubBranch.endsWith('/')) {
    throw new DeploymentError('PUBLISH_GITHUB_BRANCH 不合法', { platform: 'github', retryable: false });
  }
  const { owner, repo } = parseGithubRepo(input.githubRepo);
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const repository = (await githubRequest(fetchImpl, githubToken, base)).data;
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
  return { commit_sha: commit.data.sha, branch: githubBranch, url: input.githubPagesUrl };
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

async function ensureCloudflareTarget(input, fetchImpl) {
  const { cloudflareToken, cloudflareAccountId, cloudflareBranch } = input.credentials;
  if (!cloudflareAccountId) throw new DeploymentError('缺少 PUBLISH_CLOUDFLARE_ACCOUNT_ID', { platform: 'cloudflare', retryable: false });
  const project = encodeURIComponent(input.cloudflareProject);
  const root = `/accounts/${encodeURIComponent(cloudflareAccountId)}/pages/projects`;
  const existing = await cloudflareRequest(fetchImpl, cloudflareToken, `${root}/${project}`, { allowed: [404] });
  if (existing.status === 404) {
    await cloudflareRequest(fetchImpl, cloudflareToken, root, { method: 'POST', body: { name: input.cloudflareProject, production_branch: cloudflareBranch } });
  }
  const hostname = new URL(input.permanentUrl).hostname.toLowerCase();
  const domain = await cloudflareRequest(fetchImpl, cloudflareToken, `${root}/${project}/domains/${encodeURIComponent(hostname)}`, { allowed: [404] });
  const configured = domain.status === 404
    ? (await cloudflareRequest(fetchImpl, cloudflareToken, `${root}/${project}/domains`, { method: 'POST', body: { name: hostname } })).data?.result
    : domain.data?.result;
  return { hostname, domain_status: configured?.status || 'pending' };
}

async function deployCloudflarePages(input, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || fetch;
  const run = dependencies.execFileImpl || execFileAsync;
  const target = await ensureCloudflareTarget(input, fetchImpl);
  const wrangler = require.resolve('wrangler');
  const wranglerState = path.resolve(process.env.PUBLISH_WRANGLER_STATE_DIR || path.join(process.cwd(), 'var', '.wrangler'));
  await fs.mkdir(wranglerState, { recursive: true });
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
        XDG_CONFIG_HOME: wranglerState,
        WRANGLER_SEND_METRICS: 'false'
      }
    });
    const output = `${stdout}\n${stderr}`;
    const deploymentUrl = output.match(/https:\/\/[^\s]+\.pages\.dev\/?/i)?.[0] || '';
    return { deployment_url: deploymentUrl, custom_url: input.permanentUrl, project: input.cloudflareProject, domain_status: target.domain_status };
  } catch (error) {
    const detail = redactSecret(error.stderr || error.message || error, input.credentials.cloudflareToken).slice(0, 500);
    throw new DeploymentError(`Wrangler 发布失败：${detail}`, { platform: 'cloudflare', retryable: true });
  }
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
  const progress = {
    github: previous.github?.status === 'succeeded' ? previous.github : { status: 'running', started_at: startedAt },
    cloudflare: previous.cloudflare?.status === 'succeeded' ? previous.cloudflare : { status: 'running', started_at: startedAt }
  };
  await dependencies.onProgress?.(progress);
  const tasks = [];
  if (progress.github.status !== 'succeeded') tasks.push(['github', async () => {
    const deployed = await (dependencies.deployGithub || deployGithubPages)(input, dependencies);
    const verified = await (dependencies.verify || verifyPublishedManifest)(input.githubPagesUrl, input.sha256, dependencies);
    return { status: 'succeeded', ...deployed, ...verified, finished_at: new Date().toISOString() };
  }]);
  if (progress.cloudflare.status !== 'succeeded') tasks.push(['cloudflare', async () => {
    const deployed = await (dependencies.deployCloudflare || deployCloudflarePages)(input, dependencies);
    const verified = await (dependencies.verify || verifyPublishedManifest)(input.permanentUrl, input.sha256, dependencies);
    return { status: 'succeeded', ...deployed, ...verified, finished_at: new Date().toISOString() };
  }]);
  const settled = await Promise.all(tasks.map(([, task]) => task().then(value => ({ value }), error => ({ error }))));
  settled.forEach((item, index) => {
    const platform = tasks[index][0];
    progress[platform] = item.error
      ? { status: 'failed', error: String(item.error.message || item.error).slice(0, 500), retryable: item.error.retryable !== false, finished_at: new Date().toISOString() }
      : item.value;
  });
  await dependencies.onProgress?.(progress);
  const failures = Object.entries(progress).filter(([, result]) => result.status !== 'succeeded');
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
  redactSecret,
  verifyPublishedManifest,
  deployDualPlatform
};
