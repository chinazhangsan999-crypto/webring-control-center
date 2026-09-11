import fs from 'node:fs/promises';

const currentPath = '/opt/webring-control-center/secrets/control-center.env';
const incomingPath = '/tmp/cloudflare-update.env';

function parse(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) map.set(match[1], match[2]);
  }
  return map;
}

const currentText = await fs.readFile(currentPath, 'utf8');
const incoming = parse(await fs.readFile(incomingPath, 'utf8'));
const allowed = new Set(['PUBLISH_CLOUDFLARE_API_TOKEN', 'PUBLISH_CLOUDFLARE_ACCOUNT_ID']);

const output = currentText.split(/\r?\n/).map(line => {
  const match = line.match(/^([A-Z0-9_]+)=/);
  if (!match || !allowed.has(match[1])) return line;
  const value = incoming.get(match[1]);
  if (!value || value.startsWith('请填写')) throw new Error(`${match[1]} 尚未填写`);
  return `${match[1]}=${value}`;
}).join('\n');

await fs.writeFile(`${currentPath}.next`, output, { mode: 0o600 });
await fs.rename(`${currentPath}.next`, currentPath);
console.log('CLOUDFLARE_CREDENTIAL_UPDATED');
