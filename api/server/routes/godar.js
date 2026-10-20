const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { extractOpenIDTokenInfo, isOpenIDTokenValid } = require('@librechat/api');
const { requireJwtAuth } = require('../middleware/');
const { getAppConfig } = require('~/server/services/Config');

/**
 * GodarAI member seats. The gateway knows each member's seat and personal credits; these routes
 * ask it on the member's behalf with their own Godar access token, the same credential the Godar
 * endpoint sends with every chat request.
 */
const router = express.Router();

/** The custom endpoint that talks to the GodarAI gateway. */
const GODAR_ENDPOINT_NAME = process.env.GODAR_ENDPOINT_NAME || 'Godar';
const GATEWAY_TIMEOUT_MS = 10_000;
const SEAT_TYPES = new Set(['pro', 'max']);
const BLOCK_REASONS = new Set([
  'seat_unassigned',
  'seat_credits_exhausted',
  'personal_limit_reached',
  'budget_rule_reached',
  'pool_exhausted',
]);

/** The tenant's gateway base URL (".../v1") with `{slug}` already resolved, or null. */
async function resolveGatewayBaseURL(user) {
  const appConfig = await getAppConfig({
    role: user.role,
    userId: user.id,
    tenantId: user.tenantId,
  });
  const endpoint = appConfig?.endpoints?.custom?.find((item) => item?.name === GODAR_ENDPOINT_NAME);
  const baseURL = typeof endpoint?.baseURL === 'string' ? endpoint.baseURL.trim() : '';
  return baseURL ? baseURL.replace(/\/+$/, '') : null;
}

/** Calls the gateway as the member. Responds itself and returns null when it cannot. */
async function callGateway(req, res, path, init = {}) {
  const tokenInfo = extractOpenIDTokenInfo(req.user);
  if (!isOpenIDTokenValid(tokenInfo)) {
    res.status(401).json({ error: { code: 'godar_reauth_required' } });
    return null;
  }

  const baseURL = await resolveGatewayBaseURL(req.user);
  if (!baseURL) {
    res.status(204).end();
    return null;
  }

  try {
    const response = await fetch(`${baseURL}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${tokenInfo.accessToken}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, body };
  } catch (error) {
    logger.warn(`[godar] gateway call ${path} failed: ${error?.message ?? error}`);
    res.status(502).json({ error: { code: 'godar_gateway_unavailable' } });
    return null;
  }
}

/** GET /api/godar/seat — the member's seat, personal credits, and why chat would be refused. */
router.get('/seat', requireJwtAuth, async (req, res) => {
  const result = await callGateway(req, res, '/budget/me');
  if (!result) {
    return;
  }
  if (result.status !== 200) {
    return res.status(result.status >= 500 ? 502 : result.status).json(result.body);
  }
  if (!result.body?.seat) {
    return res.status(204).end();
  }
  res.set('Cache-Control', 'no-store');
  return res.status(200).json(result.body.seat);
});

/** POST /api/godar/seat-requests — the member asks their organization for a Pro or Max seat. */
router.post('/seat-requests', requireJwtAuth, async (req, res) => {
  const seat = typeof req.body?.seat === 'string' ? req.body.seat.trim().toLowerCase() : '';
  if (!SEAT_TYPES.has(seat)) {
    return res.status(400).json({ error: { code: 'invalid_seat_type' } });
  }

  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
  const blockReason = BLOCK_REASONS.has(req.body?.block_reason) ? req.body.block_reason : '';

  const result = await callGateway(req, res, '/seat-requests', {
    method: 'POST',
    body: JSON.stringify({ seat, reason, block_reason: blockReason }),
  });
  if (!result) {
    return;
  }
  return res.status(result.status >= 500 ? 502 : result.status).json(result.body);
});

module.exports = router;
