'use strict';

const { sendAlert } = require('../src/services/alertService');
const [title = '⚠️ 总后台运维告警', ...body] = process.argv.slice(2);

sendAlert({ title, body: body.join(' ') })
  .then(result => console.log(`alert_channel=${result.channel}`))
  .catch(error => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
