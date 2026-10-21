import { useRecoilValue } from 'recoil';
import { request } from 'librechat-data-provider';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import store from '~/store';

/** Seat types a GodarAI member can hold; `unassigned` means no seat. */
export type GodarSeatType = 'free' | 'pro' | 'max' | 'unassigned';

/** Why the gateway would refuse the member's next chat request. */
export type GodarBlockReason =
  | 'seat_unassigned'
  | 'seat_credits_exhausted'
  | 'personal_limit_reached'
  | 'budget_rule_reached'
  | 'pool_exhausted';

/** The member's own seat, as the GodarAI gateway reports it on `/v1/budget/me`. */
export interface GodarSeat {
  enforced: boolean;
  type: GodarSeatType;
  /** Credit amounts are decimal strings with two places. */
  monthly_credits: string;
  remaining_credits: string;
  renews_at?: string | null;
  lifetime: boolean;
  pool_access: boolean;
  pool_limit_credits: string | null;
  pool_used_credits: string;
  block_reason?: GodarBlockReason | '';
  upgrade_requestable: boolean;
  pending_request?: 'pro' | 'max' | '';
}

export const GODAR_SEAT_QUERY_KEY = ['godarSeat'] as const;

/** A seat only matters for Godar sign-ins; for anyone else the server answers 204 and this is null. */
export function useGodarSeatQuery(enabled = true) {
  const queriesEnabled = useRecoilValue<boolean>(store.queriesEnabled);
  return useQuery<GodarSeat | null>(
    GODAR_SEAT_QUERY_KEY,
    async () => {
      const seat = (await request.get('/api/godar/seat')) as GodarSeat | '' | undefined;
      return seat && typeof seat === 'object' && 'type' in seat ? seat : null;
    },
    {
      enabled: enabled && queriesEnabled,
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: false,
    },
  );
}

/** Asks the member's organization for a Pro or Max seat. */
export function useRequestGodarSeatMutation() {
  const queryClient = useQueryClient();
  return useMutation(
    (input: { seat: 'pro' | 'max'; reason?: string; block_reason?: GodarBlockReason }) =>
      request.post('/api/godar/seat-requests', input),
    {
      onSuccess: () => queryClient.invalidateQueries(GODAR_SEAT_QUERY_KEY),
    },
  );
}
