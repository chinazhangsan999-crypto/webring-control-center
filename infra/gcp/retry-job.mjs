import fs from 'node:fs/promises';

const jobId = process.argv[2];
if (!/^\d+$/.test(jobId || '')) throw new Error('请提供任务编号');

const values = {};
for (const line of (await fs.readFile('/opt/webring-control-center/secrets/control-center.env', 'utf8')).split(/\r?\n/)) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match) values[match[1]] = match[2];
}

const loginResponse = await fetch('http://127.0.0.1:3100/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: values.INITIAL_ADMIN_USERNAME, password: values.INITIAL_ADMIN_PASSWORD })
});
const loginPayload = await loginResponse.json();
if (!loginResponse.ok) throw new Error(loginPayload.message || '登录失败');
const cookie = loginResponse.headers.getSetCookie()[0]?.split(';', 1)[0];

const response = await fetch(`http://127.0.0.1:3100/api/admin/jobs/${jobId}/retry`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    cookie,
    'x-csrf-token': loginPayload.data.csrf_token
  },
  body: '{}'
});
const payload = await response.json();
if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
console.log(JSON.stringify({ job_id: payload.data.id, status: payload.data.status }));
