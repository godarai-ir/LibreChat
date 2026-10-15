import { getEndpointField } from 'librechat-data-provider';
import { useChatContext } from '~/Providers/ChatContext';
import { useGetEndpointsQuery } from '~/data-provider';
import useUserKey from './useUserKey';

export default function useRequiresKey() {
  const { conversation } = useChatContext();
  const { data: endpointsConfig } = useGetEndpointsQuery();
  const { endpoint } = conversation || {};
  const userProvidesKey: boolean | null | undefined = getEndpointField(
    endpointsConfig,
    endpoint,
    'userProvide',
  );
  const requireUserKey = getEndpointField(endpointsConfig, endpoint, 'requireUserKey') === true;
  const { getExpiry, hasKey } = useUserKey(endpoint ?? '');
  if (requireUserKey) {
    /** The answer is still loading while `hasKey` is undefined; do not lock the composer for that. */
    return { requiresKey: userProvidesKey === true && hasKey === false };
  }
  const expiryTime = getExpiry();
  const requiresKey = !expiryTime && userProvidesKey;
  return { requiresKey };
}
