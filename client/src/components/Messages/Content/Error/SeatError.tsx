import type { GodarBlockReason } from '~/data-provider/Godar/queries';
import type { ErrorRendererProps } from './parts';
import type { TranslationKeys } from '~/hooks';
import SeatRequestButtons from '~/components/Godar/SeatRequestButtons';
import { useGodarSeatQuery } from '~/data-provider/Godar/queries';
import { useLocalize } from '~/hooks';
import { readString } from './parts';

/** Block codes the GodarAI gateway returns when a member's seat refuses a chat request. */
export const SEAT_BLOCK_CODES = [
  'seat_unassigned',
  'seat_credits_exhausted',
  'personal_limit_reached',
  'budget_rule_reached',
  'pool_exhausted',
] as const satisfies readonly GodarBlockReason[];

const SEAT_BLOCK_COPY: Record<GodarBlockReason, TranslationKeys> = {
  seat_unassigned: 'com_godar_block_seat_unassigned',
  seat_credits_exhausted: 'com_godar_block_seat_credits_exhausted',
  personal_limit_reached: 'com_godar_block_personal_limit_reached',
  budget_rule_reached: 'com_godar_block_budget_rule_reached',
  pool_exhausted: 'com_godar_block_pool_exhausted',
};

/** Reasons a better seat would fix; the others need an administrator. */
const REQUESTABLE = new Set<GodarBlockReason>([
  'seat_unassigned',
  'seat_credits_exhausted',
  'personal_limit_reached',
]);

/** A chat request refused by the member's GodarAI seat, with a way to ask for a better one. */
export default function SeatError({ json }: ErrorRendererProps) {
  const localize = useLocalize();
  const code = (readString(json, 'code') ?? readString(json, 'type')) as GodarBlockReason;
  const reason = SEAT_BLOCK_COPY[code] ? code : 'pool_exhausted';
  const { data: seat } = useGodarSeatQuery(REQUESTABLE.has(reason));

  return (
    <div className="flex flex-col gap-3">
      <span>{localize(SEAT_BLOCK_COPY[reason])}</span>
      {REQUESTABLE.has(reason) && seat && (seat.upgrade_requestable || seat.pending_request) ? (
        <SeatRequestButtons
          current={seat.type}
          blockReason={reason}
          pending={seat.pending_request}
        />
      ) : null}
      {!REQUESTABLE.has(reason) || (seat && !seat.upgrade_requestable && !seat.pending_request) ? (
        <span className="text-text-secondary text-sm">
          {localize('com_godar_block_contact_admin')}
        </span>
      ) : null}
    </div>
  );
}
