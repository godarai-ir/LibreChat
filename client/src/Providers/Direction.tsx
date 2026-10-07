import { useTranslation } from 'react-i18next';
import { DirectionProvider } from '@radix-ui/react-direction';
import type { ReactNode } from 'react';

/** Radix primitives (tabs, menus, selects) write `dir="ltr"` unless a provider says
 *  otherwise, which re-flowed RTL dialogs left to right. Follows the interface language. */
export default function Direction({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation();
  return <DirectionProvider dir={i18n.dir(i18n.language)}>{children}</DirectionProvider>;
}
