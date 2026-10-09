import { formatInterpolation, localizeDigits } from './digits';
import { changeLanguageSafely, initializeI18n } from './i18n';
import i18n from './i18n';

describe('formatInterpolation', () => {
  it('writes numbers in Persian digits for Persian', () => {
    expect(formatInterpolation(12, undefined, 'fa', {})).toBe('۱۲');
    expect(formatInterpolation(1405, undefined, 'fa', {})).toBe('۱۴۰۵');
    expect(formatInterpolation(12345, undefined, 'fa', {})).toBe('۱۲٬۳۴۵');
  });

  it('converts strings that are only a number', () => {
    expect(formatInterpolation('45', undefined, 'fa', {})).toBe('۴۵');
    expect(formatInterpolation('4:05', undefined, 'fa', {})).toBe('۴:۰۵');
  });

  it('leaves names that merely contain digits alone', () => {
    expect(formatInterpolation('gpt-4o', undefined, 'fa', {})).toBe('gpt-4o');
    expect(formatInterpolation('report-2024.pdf', undefined, 'fa', {})).toBe('report-2024.pdf');
  });

  it('passes every value through unchanged for other languages', () => {
    expect(formatInterpolation(12345, undefined, 'en', {})).toBe(12345);
    expect(formatInterpolation('45', undefined, 'ar', {})).toBe('45');
  });
});

describe('localizeDigits', () => {
  it('maps each ASCII digit to the language’s own', () => {
    expect(localizeDigits('0123456789', 'fa')).toBe('۰۱۲۳۴۵۶۷۸۹');
  });
});

describe('Persian interpolation through i18next', () => {
  beforeAll(async () => {
    await initializeI18n();
  });

  afterAll(async () => {
    await changeLanguageSafely('en');
  });

  it('keeps plural selection on the raw count while showing Persian digits', async () => {
    await changeLanguageSafely('fa');
    expect(i18n.t('com_ui_tools_count', { count: 3 })).toBe('۳ ابزار');
    await changeLanguageSafely('en');
    expect(i18n.t('com_ui_tools_count', { count: 3 })).toBe('3 tools');
    expect(i18n.t('com_ui_tools_count', { count: 1 })).toBe('1 tool');
  });
});
