import { Button } from '@librechat/client';
import type { GodarBlockReason, GodarSeatType } from '~/data-provider/Godar/queries';
import type { TranslationKeys } from '~/hooks';
import { useRequestGodarSeatMutation } from '~/data-provider/Godar/queries';
import { useLocalize } from '~/hooks';

const SEAT_RANK: Record<GodarSeatType, number> = { unassigned: 0, free: 1, pro: 2, max: 3 };

/** The message for a failed request, by the gateway's error code. */
function requestErrorKey(code: string | undefined): TranslationKeys {
  if (code === 'seat_requests_disabled') {
    return 'com_godar_seat_request_disabled';
  }
  if (code === 'seat_request_open') {
    return 'com_godar_seat_request_open';
  }
  return 'com_godar_seat_request_failed';
}

type SeatRequestButtonsProps = {
  current: GodarSeatType;
  blockReason?: GodarBlockReason;
  /** A request already waiting for the organization. */
  pending?: 'pro' | 'max' | '';
};

/** Lets a member ask their organization for a better seat, typically right after a refusal. */
export default function SeatRequestButtons({
  current,
  blockReason,
  pending,
}: SeatRequestButtonsProps) {
  const localize = useLocalize();
  const mutation = useRequestGodarSeatMutation();
  const sentSeat = mutation.isSuccess ? mutation.variables?.seat : undefined;
  const waiting = pending || sentSeat;

  if (waiting) {
    return (
      <p className="text-text-secondary text-sm" role="status">
        {localize('com_godar_seat_request_pending', {
          0: localize(waiting === 'max' ? 'com_godar_seat_max' : 'com_godar_seat_pro'),
        })}
      </p>
    );
  }

  const options = (['pro', 'max'] as const).filter((seat) => SEAT_RANK[seat] > SEAT_RANK[current]);
  if (options.length === 0) {
    return null;
  }

  const errorCode = (
    mutation.error as { response?: { data?: { error?: { code?: string } } } } | null
  )?.response?.data?.error?.code;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {options.map((seat) => (
          <Button
            key={seat}
            type="button"
            size="sm"
            variant={seat === 'pro' ? 'submit' : 'outline'}
            disabled={mutation.isLoading}
            aria-busy={mutation.isLoading && mutation.variables?.seat === seat ? true : undefined}
            onClick={() => mutation.mutate({ seat, block_reason: blockReason })}
          >
            {localize(seat === 'max' ? 'com_godar_seat_request_max' : 'com_godar_seat_request_pro')}
          </Button>
        ))}
      </div>
      {mutation.isError ? (
        <p className="text-text-destructive text-sm" role="alert">
          {localize(requestErrorKey(errorCode))}
        </p>
      ) : null}
    </div>
  );
}
