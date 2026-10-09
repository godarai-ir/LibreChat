import type { CalendarPreference } from '~/store/calendar';

/** Unicode calendar identifiers, as `Intl` spells them in a `-u-ca-` extension. */
export type CalendarSystem = 'gregory' | 'persian';

/** Languages whose own calendar is the Solar Hijri, which the "System" setting follows. */
const SOLAR_HIJRI_LANGUAGES = new Set(['fa']);

const baseLanguage = (language?: string): string =>
  (language ?? '').split(/[-_]/)[0].toLowerCase();

export const resolveCalendar = (
  preference: CalendarPreference,
  language?: string,
): CalendarSystem => {
  if (preference === 'persian') {
    return 'persian';
  }
  if (preference === 'gregorian') {
    return 'gregory';
  }
  return SOLAR_HIJRI_LANGUAGES.has(baseLanguage(language)) ? 'persian' : 'gregory';
};

const calendarLocales = new Map<string, string | undefined>();

const withCalendar = (language: string, calendar: CalendarSystem): string | undefined => {
  const key = `${language}|${calendar}`;
  if (calendarLocales.has(key)) {
    return calendarLocales.get(key);
  }
  let tag: string | undefined;
  try {
    tag = new Intl.Locale(language, { calendar }).toString();
  } catch {
    tag = undefined;
  }
  calendarLocales.set(key, tag);
  return tag;
};

/**
 * The locale dates format with, or undefined to leave a call site on the locale it
 * already uses. A Gregorian calendar outside a Solar Hijri language is the only
 * undefined case, so those users keep exactly today's dates; everywhere else the
 * UI language carries the calendar explicitly, which also gives Persian its own
 * digits, since `fa` defaults to the `arabext` numbering system.
 */
export const resolveDateLocale = (
  preference: CalendarPreference,
  language?: string,
): string | undefined => {
  const calendar = resolveCalendar(preference, language);
  if (calendar === 'gregory' && !SOLAR_HIJRI_LANGUAGES.has(baseLanguage(language))) {
    return undefined;
  }
  return withCalendar(language || 'en', calendar);
};

const persianPartsFormatter = (() => {
  let formatter: Intl.DateTimeFormat | undefined;
  return () => {
    formatter ??= new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', {
      year: 'numeric',
      month: 'numeric',
    });
    return formatter;
  };
})();

/** Year and 1-based month of `date` in the given calendar, in the runtime's time zone. */
export const getCalendarMonth = (
  date: Date,
  calendar: CalendarSystem,
): { year: number; month: number } => {
  if (calendar === 'gregory') {
    return { year: date.getFullYear(), month: date.getMonth() + 1 };
  }
  let year = date.getFullYear();
  let month = date.getMonth() + 1;
  for (const part of persianPartsFormatter().formatToParts(date)) {
    if (part.type === 'year') {
      year = parseInt(part.value, 10);
    } else if (part.type === 'month') {
      month = parseInt(part.value, 10);
    }
  }
  return { year, month };
};

/** A year in the locale's own digits and without grouping, e.g. "2026" or "۱۴۰۵". */
export const formatYear = (year: number, locale?: string): string =>
  new Intl.NumberFormat(locale, { useGrouping: false }).format(year);

/** A short calendar date such as "Oct 6, 2026" or "۱۴ مهر ۱۴۰۵". */
export const formatShortDate = (date: Date, locale?: string): string =>
  date.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
