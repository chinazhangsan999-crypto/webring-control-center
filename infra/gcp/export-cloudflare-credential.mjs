import fs from 'node:fs/promises';

const allowed = new Set(['PUBLISH_CLOUDFLARE_API_TOKEN', 'PUBLISH_CLOUDFLARE_ACCOUNT_ID']);
const selected = [];

for (const line of (await fs.readFile('.env.production', 'utf8')).split(/\r?\n/)) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match && allowed.has(match[1])) selected.push(`${match[1]}=${match[2]}`);
}

if (selected.length !== allowed.size || selected.some(line => line.includes('=请填写'))) {
  throw new Error('Cloudflare Token 或 Account ID 尚未填写');
}

await fs.mkdir('var', { recursive: true });
await fs.writeFile('var/cloudflare-update.env', `${selected.join('\n')}\n`, { mode: 0o600 });
console.log('CLOUDFLARE_UPDATE_READY');
