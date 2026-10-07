import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import type { CalendarSystem } from '~/utils/calendar';
import { resolveCalendar, resolveDateLocale } from '~/utils/calendar';
import { calendarAtom } from '~/store/calendar';

export type CalendarSettings = {
  calendar: CalendarSystem;
  /** Undefined means "keep the call site's own locale"; see `resolveDateLocale`. */
  dateLocale?: string;
};

/** Resolves the "Calendar" setting against the UI language for formatting dates. */
export default function useCalendar(): CalendarSettings {
  const preference = useAtomValue(calendarAtom);
  const { i18n } = useTranslation();
  const language = i18n.language;
  return useMemo(
    () => ({
      calendar: resolveCalendar(preference, language),
      dateLocale: resolveDateLocale(preference, language),
    }),
    [preference, language],
  );
}
