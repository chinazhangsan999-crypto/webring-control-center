'use strict';

const fs = require('fs/promises');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool, one, transaction } = require('./db');
const { INITIAL_ADMIN_USERNAME, INITIAL_ADMIN_PASSWORD } = require('./config');

async function migrate() {
  const directory = path.join(__dirname, 'migrations');
  const files = (await fs.readdir(directory)).filter(name => name.endsWith('.sql')).sort();
  for (const name of files) {
    const exists = await one('SELECT name FROM schema_migrations WHERE name = $1', [name]).catch(() => null);
    if (exists) continue;
    const sql = await fs.readFile(path.join(directory, name), 'utf8');
    await transaction(async client => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
    });
    console.log(`已应用数据库迁移：${name}`);
  }

  const count = await one('SELECT COUNT(*)::int AS count FROM admins');
  if (!count.count) {
    if (!INITIAL_ADMIN_PASSWORD || INITIAL_ADMIN_PASSWORD.length < 12) {
      throw new Error('首次启动需要设置至少 12 位的 INITIAL_ADMIN_PASSWORD');
    }
    const passwordHash = await bcrypt.hash(INITIAL_ADMIN_PASSWORD, 12);
    await pool.query('INSERT INTO admins(username, password_hash) VALUES ($1, $2)', [INITIAL_ADMIN_USERNAME, passwordHash]);
    console.log(`已创建初始管理员：${INITIAL_ADMIN_USERNAME}`);
  }
}

if (require.main === module) {
  migrate().then(() => pool.end()).catch(error => {
    console.error(error);
    process.exitCode = 1;
    pool.end().catch(() => {});
  });
}

module.exports = { migrate };
