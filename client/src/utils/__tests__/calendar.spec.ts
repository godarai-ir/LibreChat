import type { TConversation } from 'librechat-data-provider';
import {
  formatYear,
  resolveCalendar,
  getCalendarMonth,
  formatShortDate,
  resolveDateLocale,
} from '../calendar';
import { groupConversations, dateKeys } from '../convos';

describe('resolveCalendar', () => {
  it('follows the UI language for the system preference', () => {
    expect(resolveCalendar('system', 'fa')).toBe('persian');
    expect(resolveCalendar('system', 'fa-IR')).toBe('persian');
    expect(resolveCalendar('system', 'en')).toBe('gregory');
    expect(resolveCalendar('system', 'ar')).toBe('gregory');
  });

  it('forces the chosen calendar regardless of language', () => {
    expect(resolveCalendar('gregorian', 'fa')).toBe('gregory');
    expect(resolveCalendar('persian', 'en')).toBe('persian');
  });
});

describe('resolveDateLocale', () => {
  it('leaves Gregorian dates outside Persian on the call site’s own locale', () => {
    expect(resolveDateLocale('system', 'en')).toBeUndefined();
    expect(resolveDateLocale('gregorian', 'de')).toBeUndefined();
  });

  it('carries the calendar on the UI language otherwise', () => {
    expect(resolveDateLocale('system', 'fa')).toBe('fa-u-ca-persian');
    expect(resolveDateLocale('gregorian', 'fa')).toBe('fa-u-ca-gregory');
    expect(resolveDateLocale('persian', 'en')).toBe('en-u-ca-persian');
  });

  it('formats Persian dates in Persian digits and Solar Hijri months', () => {
    const locale = resolveDateLocale('system', 'fa');
    expect(formatShortDate(new Date(2026, 9, 6, 12), locale)).toBe('۱۴ مهر ۱۴۰۵');
    expect(formatYear(1405, locale)).toBe('۱۴۰۵');
    expect(formatYear(2026, 'en')).toBe('2026');
  });
});

describe('getCalendarMonth', () => {
  it('turns the Solar Hijri year at Nowruz', () => {
    expect(getCalendarMonth(new Date(2026, 2, 20, 12), 'persian')).toEqual({
      year: 1404,
      month: 12,
    });
    expect(getCalendarMonth(new Date(2026, 2, 21, 12), 'persian')).toEqual({
      year: 1405,
      month: 1,
    });
  });

  it('keeps the thirtieth of Esfand in a leap year', () => {
    const date = new Date(2025, 2, 20, 12);
    expect(getCalendarMonth(date, 'persian')).toEqual({ year: 1403, month: 12 });
    expect(date.toLocaleDateString('en-u-ca-persian-nu-latn', { day: 'numeric' })).toBe('30');
  });

  it('reads the Gregorian calendar straight from the date', () => {
    expect(getCalendarMonth(new Date(2026, 9, 6), 'gregory')).toEqual({ year: 2026, month: 10 });
  });
});

describe('groupConversations by calendar', () => {
  const conversations = [
    { conversationId: 'aug', updatedAt: new Date(2026, 7, 1, 12).toISOString() },
    { conversationId: 'apr', updatedAt: new Date(2026, 3, 15, 12).toISOString() },
    { conversationId: 'mar', updatedAt: new Date(2026, 2, 15, 12).toISOString() },
  ] as TConversation[];

  beforeAll(() => {
    jest.useFakeTimers({ now: new Date(2026, 9, 6, 12) });
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it('keeps Gregorian month groups by default', () => {
    expect(groupConversations(conversations).map(([group]) => group)).toEqual([
      dateKeys.august,
      dateKeys.april,
      dateKeys.march,
    ]);
  });

  it('heads Solar Hijri groups with this year’s months and earlier years', () => {
    const grouped = groupConversations(conversations, { calendar: 'persian' });
    expect(grouped.map(([group, convos]) => [group, convos.map((c) => c.conversationId)])).toEqual([
      ['com_ui_date_mordad', ['aug']],
      ['com_ui_date_farvardin', ['apr']],
      [' 1404', ['mar']],
    ]);
  });

  it('orders Solar Hijri groups oldest first when ascending', () => {
    const grouped = groupConversations(conversations, { calendar: 'persian', direction: 'asc' });
    expect(grouped.map(([group]) => group)).toEqual([
      ' 1404',
      'com_ui_date_farvardin',
      'com_ui_date_mordad',
    ]);
  });
});
