import fs from 'node:fs/promises';

const baseUrl = 'http://127.0.0.1:3100';
const envPath = '/opt/webring-control-center/secrets/control-center.env';
const credentialPath = '/opt/webring-control-center/secrets/xiaoxingxing-site.env';

function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

async function readJson(response) {
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
  return payload.data;
}

const env = parseEnv(await fs.readFile(envPath, 'utf8'));
const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    username: env.INITIAL_ADMIN_USERNAME,
    password: env.INITIAL_ADMIN_PASSWORD
  })
});
const login = await readJson(loginResponse);
const cookie = loginResponse.headers.getSetCookie()[0]?.split(';', 1)[0];
if (!cookie) throw new Error('登录成功但没有收到会话 Cookie');

const headers = {
  'content-type': 'application/json',
  cookie,
  'x-csrf-token': login.csrf_token
};

const sitePayload = {
  name: '小星星爱导航',
  slug: 'xiaoxingxing',
  public_url: 'https://link.chinazhangsan.ccwu.cc',
  admin_url: 'https://link.chinazhangsan.ccwu.cc/admin',
  enabled: true
};

let sites = await readJson(await fetch(`${baseUrl}/api/admin/sites`, { headers }));
let site = sites.find(item => item.slug === sitePayload.slug || item.public_url === sitePayload.public_url);
let created = false;

if (!site) {
  const createdResult = await readJson(await fetch(`${baseUrl}/api/admin/sites`, {
    method: 'POST',
    headers,
    body: JSON.stringify(sitePayload)
  }));
  site = createdResult.site;
  created = true;
  await fs.writeFile(credentialPath, `CONTROL_CENTER_SITE_CREDENTIAL=${createdResult.credential}\n`, { mode: 0o600 });
} else {
  site = await readJson(await fetch(`${baseUrl}/api/admin/sites/${site.id}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(sitePayload)
  }));
}

const publish = await readJson(await fetch(`${baseUrl}/api/admin/sites/${site.id}/publish`, {
  method: 'PUT',
  headers,
  body: JSON.stringify({
    permanent_url: 'https://yongjiufabuye.chinazhangsan.ccwu.cc',
    github_pages_url: 'https://chinazhangsan999-crypto.github.io/control-center-fabuye/',
    github_repo: 'chinazhangsan999-crypto/control-center-fabuye',
    cloudflare_project: 'fabuyecesi1',
    contact_email: '',
    payload: {
      page_title: '小星星爱导航永久发布页',
      description: '小星星爱导航永久访问入口',
      announcement: '请同时收藏本页展示的两个永久发布地址，以便随时获取最新入口。',
      logo_url: '',
      entries: [
        {
          name: '小星星爱导航',
          url: 'https://link.chinazhangsan.ccwu.cc',
          note: '官方网站入口',
          official: true
        }
      ]
    }
  })
}));

const job = await readJson(await fetch(`${baseUrl}/api/admin/sites/${site.id}/publish/jobs`, {
  method: 'POST',
  headers,
  body: '{}'
}));

const alertJob = await readJson(await fetch(`${baseUrl}/api/admin/alerts/test`, {
  method: 'POST',
  headers,
  body: '{}'
}));

console.log(JSON.stringify({
  site_id: site.id,
  site_created: created,
  publish_revision: publish.site_id ? 'updated' : 'unknown',
  publish_job_id: job.id,
  alert_job_id: alertJob.id
}));
