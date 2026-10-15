import type { TOptions } from 'i18next';
import type { TranslationKeys } from '~/hooks';

type Localize = (phraseKey: TranslationKeys, options?: TOptions) => string;

export function formatKeyExpiryLabel(
  localize: Localize,
  expiry: string,
  hour12?: boolean,
  locale?: string,
): string {
  const formattedExpiry = new Date(expiry).toLocaleString(locale, { hour12 });
  const localizedLabel = localize('com_endpoint_config_key_encryption', {
    0: formattedExpiry,
  });

  return localizedLabel.includes(formattedExpiry)
    ? localizedLabel
    : `${localizedLabel} ${formattedExpiry}`;
}

/**
 * `getExpiry` reports `never` both for a key that never expires and for no key at all, so the
 * dialog must not announce a current key unless the server says one is stored.
 */
export function hasCurrentKey(expiry: string | undefined, hasKey: boolean | undefined): boolean {
  if (expiry === undefined) {
    return false;
  }
  return expiry !== 'never' || hasKey === true;
}
