'use strict';

const zlib = require('node:zlib');
const { normalizePackageName } = require('./npmPublishService');

const NPM_REGISTRY = 'https://registry.npmjs.org';

function registryPackageUrl(registry, packageName) {
  return `${String(registry || NPM_REGISTRY).replace(/\/$/, '')}/${encodeURIComponent(normalizePackageName(packageName))}`;
}

function tarEntry(buffer, wantedName) {
  for (let offset = 0; offset + 512 <= buffer.length;) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) return null;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeText || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('npm tarball 文件尺寸无效');
    const start = offset + 512;
    const end = start + size;
    if (end > buffer.length) throw new Error('npm tarball 内容不完整');
    if (fullName === wantedName || fullName.endsWith(`/${wantedName}`)) return buffer.subarray(start, end);
    offset = start + Math.ceil(size / 512) * 512;
  }
  return null;
}

function manifestFromTarball(value) {
  let archive;
  try { archive = zlib.gunzipSync(value); }
  catch { throw new Error('npm Registry 返回的 tarball 无法解压'); }
  const entry = tarEntry(archive, 'publish-manifest.json');
  if (!entry) throw new Error('npm tarball 缺少 publish-manifest.json');
  let manifest;
  try { manifest = JSON.parse(entry.toString('utf8')); }
  catch { throw new Error('npm tarball 中的发布清单无效'); }
  if (!/^[a-f0-9]{64}$/i.test(String(manifest?.sha256 || ''))) throw new Error('npm tarball 中的发布摘要无效');
  return manifest;
}

async function inspectRegistryVersion(packageName, version, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const registry = String(options.registry || NPM_REGISTRY).replace(/\/$/, '');
  const metadataResponse = await fetchImpl(registryPackageUrl(registry, packageName), {
    headers: { accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(15_000)
  });
  if (metadataResponse.status === 404) return null;
  if (!metadataResponse.ok) throw new Error(`npm Registry 查询失败：HTTP ${metadataResponse.status}`);
  const metadata = await metadataResponse.json();
  const release = metadata?.versions?.[version];
  if (!release) return null;
  const tarballUrl = String(release?.dist?.tarball || '');
  if (!/^https:\/\//i.test(tarballUrl)) throw new Error('npm Registry 未返回有效 tarball 地址');
  const tarballResponse = await fetchImpl(tarballUrl, { cache: 'no-store', redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  if (!tarballResponse.ok) throw new Error(`npm tarball 下载失败：HTTP ${tarballResponse.status}`);
  const manifest = manifestFromTarball(Buffer.from(await tarballResponse.arrayBuffer()));
  return { package: normalizePackageName(packageName), version, tarball_url: tarballUrl, manifest };
}

async function verifyRegistryVersion(packageName, version, expectedSha256, options = {}) {
  const attempts = Number(options.attempts || 30);
  const intervalMs = Number(options.intervalMs || 2_000);
  const wait = options.wait || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  let lastError = 'npm Registry 尚未出现该精确版本';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const release = await inspectRegistryVersion(packageName, version, options);
      if (release) {
        if (release.manifest.sha256 !== expectedSha256) throw new Error('npm 精确版本已存在，但发布清单摘要不一致');
        return { verified: true, package: release.package, version, tarball_url: release.tarball_url, manifest_sha256: release.manifest.sha256 };
      }
    } catch (error) { lastError = String(error.message || error); }
    if (attempt + 1 < attempts) await wait(intervalMs);
  }
  throw new Error(lastError);
}

module.exports = { NPM_REGISTRY, registryPackageUrl, manifestFromTarball, inspectRegistryVersion, verifyRegistryVersion };
