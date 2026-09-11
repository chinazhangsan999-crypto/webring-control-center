import fs from 'node:fs/promises';

const values = {};
for (const line of (await fs.readFile('/opt/webring-control-center/secrets/control-center.env', 'utf8')).split(/\r?\n/)) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match) values[match[1]] = match[2];
}

const account = values.PUBLISH_CLOUDFLARE_ACCOUNT_ID;
const token = values.PUBLISH_CLOUDFLARE_API_TOKEN;
const project = 'fabuyecesi1';
const root = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/pages/projects/${project}`;

async function cf(path = '') {
  const response = await fetch(`${root}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000)
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) {
    throw new Error(payload.errors?.map(item => item.message).join('; ') || `HTTP ${response.status}`);
  }
  return payload.result;
}

const info = await cf();
const deployments = await cf('/deployments');
const domains = await cf('/domains');

console.log(JSON.stringify({
  project: info.name,
  subdomain: info.subdomain,
  production_branch: info.production_branch,
  domains: domains.map(item => ({ name: item.name, status: item.status })),
  latest_deployment: deployments[0] ? {
    url: deployments[0].url,
    environment: deployments[0].environment,
    latest_stage: deployments[0].latest_stage?.status
  } : null
}));
