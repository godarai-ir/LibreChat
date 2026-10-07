import { useRecoilValue } from 'recoil';
import { useTranslation } from 'react-i18next';
import store from '~/store';

export type TextDirection = 'ltr' | 'rtl';

/** An explicit "LTR"/"RTL" choice wins; anything else ("auto", the default)
 *  follows the interface language, so a Persian UI composes right to left. */
export const resolveChatDirection = (
  preference: string | null | undefined,
  uiDirection: TextDirection,
): TextDirection => {
  const choice = preference?.toLowerCase();
  if (choice === 'ltr' || choice === 'rtl') {
    return choice;
  }
  return uiDirection;
};

/** The direction the composer and message editors write in. */
export default function useChatDirection(): TextDirection {
  const preference = useRecoilValue(store.chatDirection);
  const { i18n } = useTranslation();
  return resolveChatDirection(preference, i18n.dir(i18n.language));
}
