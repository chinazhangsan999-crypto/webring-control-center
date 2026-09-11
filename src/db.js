'use strict';

const { Pool } = require('pg');
const { DATABASE_URL, DATABASE_SSL } = require('./config');

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_SSL ? { rejectUnauthorized: true } : false,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 8_000
});

async function query(text, params = []) {
  return pool.query(text, params);
}

async function one(text, params = []) {
  const result = await query(text, params);
  return result.rows[0] || null;
}

async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, one, transaction };
