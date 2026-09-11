'use strict';

const path = require('path');
const appDirectory = process.argv[2] || '/home/niaiwo/app';
const sqlite3 = require(path.join(appDirectory, 'node_modules', 'sqlite3')).verbose();
const db = new sqlite3.Database(path.join(appDirectory, 'webring.db'));

db.all(`SELECT speed_name, partner_name, url, status
  FROM mirrors
  ORDER BY speed_name COLLATE NOCASE ASC, url ASC`, (error, rows) => {
  if (error) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    process.stdout.write(JSON.stringify(rows));
  }
  db.close();
});
