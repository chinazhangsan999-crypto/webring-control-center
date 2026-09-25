'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { manifestFromTarball, verifyRegistryVersion } = require('../src/services/npmRegistryService');

function tarball(name, content) {
  const value = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${value.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header[156] = '0'.charCodeAt(0);
  const padding = Buffer.alloc(Math.ceil(value.length / 512) * 512 - value.length);
  return zlib.gzipSync(Buffer.concat([header, value, padding, Buffer.alloc(1024)]));
}

test('npm Registry 校验直接读取 tarball 内的发布清单，不依赖 CDN', async () => {
  const sha256 = 'a'.repeat(64);
  const archive = tarball('package/publish-manifest.json', JSON.stringify({ sha256 }));
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    if (String(url).includes('/-/')) return new Response(archive, { status: 200 });
    return new Response(JSON.stringify({ versions: { '0.0.9': { dist: { tarball: 'https://registry.npmjs.org/page/-/page-0.0.9.tgz' } } } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await verifyRegistryVersion('page', '0.0.9', sha256, { fetchImpl, attempts: 1 });
  assert.equal(result.verified, true);
  assert.equal(result.manifest_sha256, sha256);
  assert.equal(calls.some(url => url.includes('unpkg.com') || url.includes('jsdelivr.net')), false);
});

test('npm tarball 中的发布摘要必须与任务一致', async () => {
  const archive = tarball('package/publish-manifest.json', JSON.stringify({ sha256: 'b'.repeat(64) }));
  assert.equal(manifestFromTarball(archive).sha256, 'b'.repeat(64));
  const fetchImpl = async url => String(url).includes('/-/')
    ? new Response(archive, { status: 200 })
    : new Response(JSON.stringify({ versions: { '0.0.9': { dist: { tarball: 'https://registry.npmjs.org/page/-/page-0.0.9.tgz' } } } }), { status: 200 });
  await assert.rejects(() => verifyRegistryVersion('page', '0.0.9', 'a'.repeat(64), { fetchImpl, attempts: 1 }), /摘要不一致/);
});
