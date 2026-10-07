import { createStorageAtom } from './jotai-utils';

export type CalendarPreference = 'system' | 'gregorian' | 'persian';

const DEFAULT_CALENDAR: CalendarPreference = 'system';

export const calendarAtom = createStorageAtom<CalendarPreference>('calendar', DEFAULT_CALENDAR);
