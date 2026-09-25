'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { normalizePackageName, npmPageUrl } = require('./npmPublishService');
const { verifyPublishedManifest } = require('./publishDeploymentService');

const activeSites = new Set();
const NPM_REGISTRY = 'https://registry.npmjs.org';

function cleanToken(value) {
  const token = String(value || '').trim();
  if (token.length < 20 || token.length > 500 || /\s/.test(token)) throw new Error('请填写有效的短效 npm Granular Token');
  return token;
}

function parseRepo(value) {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(String(value || '').trim());
  if (!match) throw new Error('GitHub 仓库格式不合法');
  return { organization: match[1], repository: match[2] };
}

function trustedPublisherInstructions(packageName, githubRepo, workflowFile = 'publish-npm.yml') {
  const name = normalizePackageName(packageName);
  const repo = parseRepo(githubRepo);
  const workflow = String(workflowFile || 'publish-npm.yml').trim();
  if (!/^[A-Za-z0-9_.-]+\.ya?ml$/.test(workflow)) throw new Error('OIDC 工作流文件名不合法');
  return {
    package_settings_url: `https://www.npmjs.com/package/${encodeURIComponent(name)}/access`,
    organization: repo.organization,
    repository: repo.repository,
    workflow_file: workflow,
    environment: '留空',
    allowed_action: 'npm publish'
  };
}

function registryPackageUrl(registry, packageName) {
  return `${registry.replace(/\/$/, '')}/${encodeURIComponent(packageName)}`;
}

async function inspectPackage(packageName, version, registry = NPM_REGISTRY, fetchImpl = fetch) {
  const response = await fetchImpl(registryPackageUrl(registry, packageName), {
    headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000)
  });
  if (response.status === 404) return { exists: false, exactVersionExists: false };
  if (!response.ok) throw new Error(`npm 包查询失败：HTTP ${response.status}`);
  const metadata = await response.json();
  return { exists: true, exactVersionExists: Boolean(metadata?.versions?.[version]) };
}

async function verifyIdentity(token, registry = NPM_REGISTRY, fetchImpl = fetch) {
  const response = await fetchImpl(`${registry.replace(/\/$/, '')}/-/whoami`, {
    headers: { accept: 'application/json', authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.username) throw new Error(`npm Token 身份验证失败：${data?.error || `HTTP ${response.status}`}`);
  return String(data.username);
}

function runProcess({ command, args, cwd, env, timeoutMs = 120_000 }) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, signal: controller.signal });
    let stdout = '', stderr = '';
    const append = (current, chunk) => (current + chunk.toString()).slice(-16_000);
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`npm 首次发布失败：${(stderr || stdout || `退出码 ${code}`).slice(-2000)}`));
    });
  });
}

async function publishWithToken({ token, registry, directory }, dependencies = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'control-center-npm-'));
  const npmrc = path.join(temporary, '.npmrc');
  const cache = path.join(temporary, 'cache');
  try {
    await fs.chmod(temporary, 0o700);
    await fs.mkdir(cache, { mode: 0o700 });
    await fs.writeFile(npmrc, `registry=${registry}\n//registry.npmjs.org/:_authToken=\${NODE_AUTH_TOKEN}\nprovenance=false\n`, { mode: 0o600 });
    const runner = dependencies.runProcess || runProcess;
    return await runner({
      command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
      args: ['publish', '--access', 'public', '--provenance=false', '--ignore-scripts', '--registry', registry],
      cwd: directory,
      env: {
        ...process.env,
        HOME: temporary,
        USERPROFILE: temporary,
        NODE_AUTH_TOKEN: token,
        NPM_CONFIG_USERCONFIG: npmrc,
        NPM_CONFIG_CACHE: cache,
        npm_config_cache: cache,
        NPM_CONFIG_PROVENANCE: 'false',
        NPM_CONFIG_UPDATE_NOTIFIER: 'false'
      },
      timeoutMs: 120_000
    });
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function verifyRegistryVersion(packageName, version, registry = NPM_REGISTRY, fetchImpl = fetch) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const state = await inspectPackage(packageName, version, registry, fetchImpl);
    if (state.exactVersionExists) return true;
    if (attempt < 14) await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  throw new Error('npm 首次发布完成，但 Registry 尚未出现精确版本');
}

async function bootstrapNpmPackage(input, dependencies = {}) {
  const token = cleanToken(input.token);
  const packageName = normalizePackageName(input.packageName);
  const version = String(input.version || '').trim();
  const registry = String(input.registry || NPM_REGISTRY).replace(/\/$/, '');
  if (registry !== NPM_REGISTRY) throw new Error('首次发布只允许使用 npm 官方 Registry');
  if (!/^0\.0\.[1-9]\d*$/.test(version)) throw new Error('npm 首次发布版本不合法');
  if (!/^[a-f0-9]{64}$/i.test(String(input.expectedSha256 || ''))) throw new Error('发布清单摘要不合法');

  const [metadata, manifest] = await Promise.all([
    fs.readFile(path.join(input.directory, 'package.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(input.directory, 'publish-manifest.json'), 'utf8').then(JSON.parse)
  ]);
  if (metadata.name !== packageName || metadata.version !== version) throw new Error('发布包名称或版本与任务不一致');
  if (manifest.sha256 !== input.expectedSha256) throw new Error('发布清单与任务摘要不一致');
  if (metadata.scripts && Object.keys(metadata.scripts).length) throw new Error('首次发布包不能包含 npm 生命周期脚本');

  const inspector = dependencies.inspectPackage || ((name, release, targetRegistry) => inspectPackage(name, release, targetRegistry, dependencies.fetchImpl));
  const existing = await inspector(packageName, version, registry);
  const instructions = trustedPublisherInstructions(packageName, input.githubRepo, input.workflowFile);
  const exactBaseUrl = npmPageUrl(packageName, version, 'unpkg').replace(/index\.html$/, '');
  const verifyManifest = dependencies.verifyManifest || verifyPublishedManifest;
  if (existing.exactVersionExists) {
    const verified = await verifyManifest(exactBaseUrl, input.expectedSha256, { fetchImpl: dependencies.fetchImpl, attempts: 10, intervalMs: 2_000 });
    return { status: 'published', already_published: true, package: packageName, version, manifest_url: verified.manifest_url, instructions };
  }
  if (existing.exists) throw new Error('该 npm 包已经存在，不属于首次发布；请改用 OIDC 发布新版本');

  const identity = dependencies.verifyIdentity || ((secret, targetRegistry) => verifyIdentity(secret, targetRegistry, dependencies.fetchImpl));
  const username = await identity(token, registry);
  if (input.expectedUsername && username.toLowerCase() !== String(input.expectedUsername).trim().toLowerCase()) {
    throw new Error(`npm Token 属于 ${username}，与配置账号 ${input.expectedUsername} 不一致`);
  }
  await (dependencies.publishWithToken || publishWithToken)({ token, registry, directory: input.directory }, dependencies);
  const verifyVersion = dependencies.verifyRegistryVersion || ((name, release, targetRegistry) => verifyRegistryVersion(name, release, targetRegistry, dependencies.fetchImpl));
  await verifyVersion(packageName, version, registry);
  const verified = await verifyManifest(exactBaseUrl, input.expectedSha256, { fetchImpl: dependencies.fetchImpl, attempts: 30, intervalMs: 2_000 });
  return { status: 'published', already_published: false, package: packageName, version, manifest_url: verified.manifest_url, instructions };
}

async function runExclusive(siteId, operation) {
  const key = Number(siteId);
  if (activeSites.has(key)) throw new Error('该站点的 npm 首次发布正在进行中');
  activeSites.add(key);
  try { return await operation(); }
  finally { activeSites.delete(key); }
}

module.exports = {
  NPM_REGISTRY,
  cleanToken,
  trustedPublisherInstructions,
  inspectPackage,
  verifyIdentity,
  publishWithToken,
  verifyRegistryVersion,
  bootstrapNpmPackage,
  runExclusive
};
