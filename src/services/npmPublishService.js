'use strict';

const PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,119}$/;
const CDN_PROVIDERS = {
  npmmirror: { label: '中国大陆极速 · npmmirror', template: (name, version) => `https://registry.npmmirror.com/${name}/${version}/files/index.html` },
  jsdelivr: { label: '推荐线路 · jsDelivr', template: (name, version) => `https://cdn.jsdelivr.net/npm/${name}@${version}/index.html` },
  unpkg: { label: '备用线路 1 · UNPKG', template: (name, version) => `https://unpkg.com/${name}@${version}/index.html` },
  esm: { label: 'ESM 线路 · esm.sh', template: (name, version) => `https://esm.sh/${name}@${version}/index.html` }
};

function normalizePackageName(value) {
  const name = String(value || '').trim().toLowerCase();
  if (!PACKAGE_PATTERN.test(name)) throw new Error('npm 包名格式不合法');
  return name;
}

function npmVersionForJob(jobId) {
  const id = String(jobId || '').trim();
  if (!/^[1-9]\d*$/.test(id)) throw new Error('npm 发布任务编号不合法');
  return `0.0.${id}`;
}

function normalizeCdnLines(value, fallback = ['jsdelivr', 'unpkg']) {
  const lines = Array.isArray(value) ? value.map(item => String(item || '').trim()).filter(item => CDN_PROVIDERS[item]) : [];
  const valid = [...new Set(lines.length ? lines : fallback.filter(item => CDN_PROVIDERS[item]))];
  if (!valid.length) throw new Error('请至少选择一条 npm CDN 线路');
  return valid;
}

function npmPageUrl(packageName, version = 'latest', provider = 'unpkg') {
  const name = normalizePackageName(packageName);
  const release = String(version || 'latest').trim();
  if (release !== 'latest' && !/^0\.0\.[1-9]\d*$/.test(release)) throw new Error('npm 发布版本不合法');
  if (!CDN_PROVIDERS[provider]) throw new Error('未知 npm CDN 线路');
  return CDN_PROVIDERS[provider].template(name, release);
}

function npmCdnUrls(packageName, version = 'latest', lines = ['jsdelivr', 'unpkg'], primary = 'jsdelivr') {
  const selected = normalizeCdnLines(lines);
  const main = selected.includes(primary) ? primary : selected[0];
  return selected.map(provider => ({ provider, label: CDN_PROVIDERS[provider].label, primary: provider === main, url: npmPageUrl(packageName, version, provider) }));
}

function npmWorkflow() {
  return `name: Publish npm landing page

on:
  push:
    branches:
      - gh-pages

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    if: startsWith(github.event.head_commit.message, '触发 npm 发布')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: '24'
          registry-url: 'https://registry.npmjs.org'
          package-manager-cache: false
      - run: npm publish --access public
`;
}

function npmPackageFiles({ packageName, version, githubRepo, siteName }) {
  const name = normalizePackageName(packageName);
  if (!/^0\.0\.[1-9]\d*$/.test(String(version || ''))) throw new Error('npm 发布版本不合法');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(githubRepo || ''))) throw new Error('GitHub 仓库格式不合法');
  const packageJson = {
    name,
    version,
    description: `${String(siteName || '导航站').slice(0, 100)} npm 完整永久发布页`,
    private: false,
    license: 'UNLICENSED',
    repository: { type: 'git', url: `git+https://github.com/${githubRepo}.git` },
    files: ['index.html', '404.html', 'publish-manifest.json', 'README.md'],
    publishConfig: { access: 'public', provenance: true }
  };
  return {
    'package.json': `${JSON.stringify(packageJson, null, 2)}\n`,
    'README.md': `# ${String(siteName || '导航站').replace(/[\r\n#]/g, ' ').trim()} npm 永久发布页\n\n这是由总后台自动生成的完整静态发布页，包含入口列表、访客端线路检测、复制地址和发布完整性清单。\n`,
    '.github/workflows/publish-npm.yml': npmWorkflow()
  };
}

module.exports = { CDN_PROVIDERS, normalizePackageName, normalizeCdnLines, npmVersionForJob, npmPageUrl, npmCdnUrls, npmPackageFiles };
