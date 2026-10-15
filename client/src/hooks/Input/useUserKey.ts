import { useMemo, useCallback } from 'react';
import { EModelEndpoint } from 'librechat-data-provider';
import { useUserKeyQuery, useUpdateUserKeysMutation } from 'librechat-data-provider/react-query';
import { useGetEndpointsQuery } from '~/data-provider';

const useUserKey = (endpoint: string) => {
  const { data: endpointsConfig } = useGetEndpointsQuery();
  const config = endpointsConfig?.[endpoint ?? ''];

  const { azure } = config ?? {};
  let keyName = endpoint;

  if (azure) {
    keyName = EModelEndpoint.azureOpenAI;
  }

  const updateKey = useUpdateUserKeysMutation();
  const checkUserKey = useUserKeyQuery(keyName);

  const getExpiry = useCallback(() => {
    if (checkUserKey.data) {
      return checkUserKey.data.expiresAt || 'never';
    }
  }, [checkUserKey.data]);

  const checkExpiry = useCallback(() => {
    const expiresAt = getExpiry();
    if (!expiresAt) {
      return true;
    }

    const expiresAtDate = new Date(expiresAt);
    if (expiresAtDate < new Date()) {
      return false;
    }
    return true;
  }, [getExpiry]);

  /** `undefined` until the server has answered, so callers do not treat loading as "no key". */
  const hasKey = useMemo(() => {
    if (!checkUserKey.data) {
      return undefined;
    }
    const expiresAt = checkUserKey.data.expiresAt;
    if (!expiresAt) {
      return false;
    }
    return expiresAt === 'never' || new Date(expiresAt) > new Date();
  }, [checkUserKey.data]);

  const saveUserKey = useCallback(
    (userKey: string, expiresAt: number | null) => {
      const dateStr = expiresAt ? new Date(expiresAt).toISOString() : '';
      updateKey.mutate({
        name: keyName,
        value: userKey,
        expiresAt: dateStr,
      });
    },
    [updateKey, keyName],
  );

  return useMemo(
    () => ({ getExpiry, checkExpiry, saveUserKey, hasKey }),
    [getExpiry, checkExpiry, saveUserKey, hasKey],
  );
};

export default useUserKey;
