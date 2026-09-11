import fs from 'node:fs/promises';

const values = {};
for (const line of (await fs.readFile('/opt/webring-control-center/secrets/control-center.env', 'utf8')).split(/\r?\n/)) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match) values[match[1]] = match[2];
}

const token = values.PUBLISH_CLOUDFLARE_API_TOKEN;
const hostname = 'yongjiufabuye.chinazhangsan.ccwu.cc';
const target = 'fabuyecesi1.pages.dev';

async function request(path, options = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(15000)
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) {
    throw new Error(payload.errors?.map(item => item.message).join('; ') || `HTTP ${response.status}`);
  }
  return payload.result;
}

const zones = await request('/zones?name=chinazhangsan.ccwu.cc&status=active');
if (zones.length !== 1) throw new Error('Token 无法读取 chinazhangsan.ccwu.cc 区域');
const zoneId = zones[0].id;
const existing = await request(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}`);

if (existing.length) {
  const record = existing[0];
  if (record.type !== 'CNAME' || record.content.toLowerCase().replace(/\.$/, '') !== target) {
    throw new Error(`目标域名已有不同记录：${record.type} ${record.content}`);
  }
  console.log(JSON.stringify({ created: false, name: record.name, type: record.type, target: record.content }));
} else {
  const record = await request(`/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: JSON.stringify({ type: 'CNAME', name: hostname, content: target, proxied: true, ttl: 1 })
  });
  console.log(JSON.stringify({ created: true, name: record.name, type: record.type, target: record.content }));
}
