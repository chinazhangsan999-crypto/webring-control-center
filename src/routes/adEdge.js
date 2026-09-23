'use strict';

const express = require('express');
const { ok, asyncRoute } = require('../lib/http');
const AdEdgeService = require('../services/adEdgeService');

const router = express.Router();
router.get('/render/:siteId/:adId', asyncRoute(async (req, res) => {
  const siteId = Number(req.params.siteId);
  const adId = Number(req.params.adId);
  if (!Number.isSafeInteger(siteId) || siteId <= 0 || !Number.isSafeInteger(adId) || adId <= 0) {
    return res.status(404).end();
  }
  const data = await AdEdgeService.verifyRenderRequest(req, siteId, adId);
  res.set('Cache-Control', 'private, no-store');
  return ok(res, data);
}));

module.exports = router;
