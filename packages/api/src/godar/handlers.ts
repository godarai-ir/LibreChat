import type { IUser } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { GodarGatewayDeps, GodarGatewayErrorCode } from './gateway';
import { resolveRequestTenantId } from '~/middleware/tenant';
import { createGodarGateway } from './gateway';

const SEAT_TYPES = new Set(['pro', 'max']);
const BLOCK_REASONS = new Set([
  'seat_unassigned',
  'seat_credits_exhausted',
  'personal_limit_reached',
  'budget_rule_reached',
  'pool_exhausted',
]);
const MAX_REASON_LENGTH = 500;

export type GodarRequest = Request & { user?: IUser; tenantId?: string };

export interface GodarSeatHandlers {
  getSeat: (req: GodarRequest, res: Response) => Promise<void>;
  requestSeat: (req: GodarRequest, res: Response) => Promise<void>;
}

/** `godar_not_configured` is not a failure: a tenant without a Godar endpoint has no seat. */
const ERROR_STATUS: Record<GodarGatewayErrorCode, number> = {
  godar_not_configured: 204,
  godar_reauth_required: 401,
  godar_auth_unavailable: 503,
  godar_gateway_unavailable: 502,
};

function sendError(res: Response, code: GodarGatewayErrorCode): void {
  const status = ERROR_STATUS[code];
  if (status === 204) {
    res.status(204).end();
    return;
  }
  res.status(status).json({ error: { code } });
}

/** Gateway 5xx bodies are the gateway's own; the member only learns it is unavailable. */
function gatewayStatus(status: number): number {
  return status >= 500 ? 502 : status;
}

function stringField(body: unknown, name: string): string {
  if (body == null || typeof body !== 'object') {
    return '';
  }
  const value = (body as Record<string, unknown>)[name];
  return typeof value === 'string' ? value.trim() : '';
}

/** GET /api/godar/seat and POST /api/godar/seat-requests, called as the signed-in member. */
export function createGodarSeatHandlers(deps: GodarGatewayDeps): GodarSeatHandlers {
  const callGateway = createGodarGateway(deps);

  async function getSeat(req: GodarRequest, res: Response): Promise<void> {
    if (!req.user) {
      res.status(401).end();
      return;
    }
    const result = await callGateway({
      user: req.user,
      tenantId: resolveRequestTenantId(req),
      path: '/budget/me',
    });
    if (!result.ok) {
      sendError(res, result.error.code);
      return;
    }
    if (result.status !== 200) {
      res.status(gatewayStatus(result.status)).json(result.body);
      return;
    }
    const seat = result.body.seat;
    if (seat == null || typeof seat !== 'object') {
      res.status(204).end();
      return;
    }
    res.set('Cache-Control', 'no-store');
    res.status(200).json(seat);
  }

  async function requestSeat(req: GodarRequest, res: Response): Promise<void> {
    if (!req.user) {
      res.status(401).end();
      return;
    }
    const seat = stringField(req.body, 'seat').toLowerCase();
    if (!SEAT_TYPES.has(seat)) {
      res.status(400).json({ error: { code: 'invalid_seat_type' } });
      return;
    }
    const reason = stringField(req.body, 'reason').slice(0, MAX_REASON_LENGTH);
    const blockReason = stringField(req.body, 'block_reason');

    const result = await callGateway({
      user: req.user,
      tenantId: resolveRequestTenantId(req),
      path: '/seat-requests',
      method: 'POST',
      body: { seat, reason, block_reason: BLOCK_REASONS.has(blockReason) ? blockReason : '' },
    });
    if (!result.ok) {
      sendError(res, result.error.code);
      return;
    }
    res.status(gatewayStatus(result.status)).json(result.body);
  }

  return { getSeat, requestSeat };
}
