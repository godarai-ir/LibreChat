const express = require('express');
const { createGodarSeatHandlers, GODAR_ENDPOINT_NAME } = require('@librechat/api');
const { getAppConfig } = require('~/server/services/Config');
const { requireJwtAuth } = require('../middleware/');
const db = require('~/models');

/** GodarAI member seats, asked of the gateway as the signed-in member. */
const router = express.Router();

const { getSeat, requestSeat } = createGodarSeatHandlers({
  getAppConfig,
  getUserKeyValues: db.getUserKeyValues,
  getUserKeyExpiry: db.getUserKeyExpiry,
  endpointName: process.env.GODAR_ENDPOINT_NAME || GODAR_ENDPOINT_NAME,
});

router.get('/seat', requireJwtAuth, getSeat);
router.post('/seat-requests', requireJwtAuth, requestSeat);

module.exports = router;
