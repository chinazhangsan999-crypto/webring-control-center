'use strict';

const app = require('./app');
const { migrate } = require('./migrate');
const { pool, query } = require('./db');
const { HOST, PORT } = require('./config');
const { startJobWorker, stopJobWorker } = require('./services/jobWorker');

let server;
let housekeeping;

async function start() {
  await migrate();
  await query(`UPDATE sites SET status=CASE
    WHEN last_seen_at IS NULL THEN 'pending'
    WHEN last_seen_at<NOW()-INTERVAL '15 minutes' THEN 'offline'
    WHEN last_seen_at<NOW()-INTERVAL '3 minutes' THEN 'stale'
    ELSE 'online' END`);
  housekeeping = setInterval(() => {
    query(`UPDATE sites SET status=CASE
      WHEN last_seen_at IS NULL THEN 'pending'
      WHEN last_seen_at<NOW()-INTERVAL '15 minutes' THEN 'offline'
      WHEN last_seen_at<NOW()-INTERVAL '3 minutes' THEN 'stale'
      ELSE 'online' END`).catch(error => console.error('站点状态整理失败', error));
    query('DELETE FROM admin_sessions WHERE expires_at<=NOW()').catch(() => {});
    query('DELETE FROM sso_tickets WHERE expires_at<NOW()-INTERVAL \'1 day\'').catch(() => {});
  }, 60_000);
  housekeeping.unref();
  server = app.listen(PORT, HOST, () => console.log(`总后台已启动：http://${HOST}:${PORT}`));
  startJobWorker();
}

async function stop(signal) {
  console.log(`收到 ${signal}，正在安全退出`);
  if (housekeeping) clearInterval(housekeeping);
  await stopJobWorker();
  if (server) await new Promise(resolve => server.close(resolve));
  await pool.end();
}

process.once('SIGINT', () => stop('SIGINT').then(() => process.exit(0)));
process.once('SIGTERM', () => stop('SIGTERM').then(() => process.exit(0)));

start().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
