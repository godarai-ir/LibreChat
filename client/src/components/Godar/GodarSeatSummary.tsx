import { Skeleton } from '@librechat/client';
import type { GodarSeatType } from '~/data-provider/Godar/queries';
import type { TranslationKeys } from '~/hooks';
import { useGodarSeatQuery } from '~/data-provider/Godar/queries';
import SeatRequestButtons from './SeatRequestButtons';
import { useLocalize } from '~/hooks';

export const SEAT_LABEL: Record<GodarSeatType, TranslationKeys> = {
  free: 'com_godar_seat_free',
  pro: 'com_godar_seat_pro',
  max: 'com_godar_seat_max',
  unassigned: 'com_godar_seat_unassigned',
};

function formatCredits(value: string | null | undefined, locale: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return '—';
  }
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(amount);
}

/**
 * The member's GodarAI seat: its personal credits, when they renew, how much organization credit
 * the member may still use, and a way to ask for more.
 */
export default function GodarSeatSummary() {
  const localize = useLocalize();
  const { data: seat, isLoading } = useGodarSeatQuery();
  const locale = document.documentElement.lang || 'fa';

  if (isLoading) {
    return (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }
  if (!seat) {
    return null;
  }

  const monthly = Number(seat.monthly_credits);
  const remaining = Number(seat.remaining_credits);
  const usedPercent =
    monthly > 0 ? Math.min(100, Math.max(0, ((monthly - remaining) / monthly) * 100)) : 0;

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-text-primary font-medium">
          {localize('com_godar_seat_label', { 0: localize(SEAT_LABEL[seat.type]) })}
        </span>
        {seat.type !== 'unassigned' ? (
          <span className="text-text-secondary tabular-nums">
            {localize('com_godar_seat_remaining', {
              0: formatCredits(seat.remaining_credits, locale),
              1: formatCredits(seat.monthly_credits, locale),
            })}
          </span>
        ) : null}
      </div>

      {seat.type !== 'unassigned' ? (
        <div
          className="bg-surface-tertiary h-1.5 w-full overflow-hidden rounded-full"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(usedPercent)}
          aria-label={localize('com_godar_seat_usage')}
        >
          <div className="bg-status-info h-full" style={{ width: `${usedPercent}%` }} />
        </div>
      ) : null}

      {seat.lifetime ? (
        <p className="text-text-secondary">{localize('com_godar_seat_lifetime')}</p>
      ) : null}
      {!seat.lifetime && seat.renews_at ? (
        <p className="text-text-secondary">
          {localize('com_godar_seat_renews', {
            0: new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
              new Date(seat.renews_at),
            ),
          })}
        </p>
      ) : null}

      {seat.pool_access && seat.pool_limit_credits ? (
        <p className="text-text-secondary">
          {localize('com_godar_seat_pool_limit', {
            0: formatCredits(seat.pool_used_credits, locale),
            1: formatCredits(seat.pool_limit_credits, locale),
          })}
        </p>
      ) : null}

      {!seat.enforced && seat.enabled ? (
        <p className="text-text-secondary">{localize('com_godar_seat_not_enforced')}</p>
      ) : null}

      {seat.upgrade_requestable || seat.pending_request ? (
        <SeatRequestButtons current={seat.type} pending={seat.pending_request} />
      ) : null}
    </div>
  );
}
