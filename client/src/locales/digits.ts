import type { FormatFunction } from 'i18next';

/**
 * Languages whose interface shows numbers in their own digits, which is also
 * CLDR's default numbering system for each (`fa` → `arabext`). Every other
 * language keeps interpolated values exactly as the caller passed them.
 */
const NATIVE_DIGIT_LANGUAGES = new Set(['fa']);

/** Only values made of digits and the punctuation around them, such as "12",
 *  "1,024" or "4:05"; a model name like "gpt-4o" or a file name is left alone. */
const NUMERIC_TEXT = /^[\d\s.,:%+\-−/×]+$/;

const numberFormats = new Map<string, Intl.NumberFormat>();
const digitZeros = new Map<string, number>();

const usesNativeDigits = (lng?: string): lng is string =>
  lng != null && NATIVE_DIGIT_LANGUAGES.has(lng.split('-')[0].toLowerCase());

const getNumberFormat = (lng: string): Intl.NumberFormat => {
  let format = numberFormats.get(lng);
  if (!format) {
    try {
      // 'min2' leaves four-digit numbers such as years ungrouped.
      format = new Intl.NumberFormat(lng, { useGrouping: 'min2' } as Intl.NumberFormatOptions);
    } catch {
      format = new Intl.NumberFormat(lng);
    }
    numberFormats.set(lng, format);
  }
  return format;
};

export const localizeDigits = (text: string, lng: string): string => {
  let zero = digitZeros.get(lng);
  if (zero == null) {
    zero = getNumberFormat(lng).format(0).charCodeAt(0);
    digitZeros.set(lng, zero);
  }
  const offset = zero;
  return text.replace(/\d/g, (digit) => String.fromCharCode(offset + Number(digit)));
};

/**
 * i18next `interpolation.format`, run for every interpolated value: numbers, and
 * strings that are only a number, take the language's own digits. Plural
 * selection reads `count` before this runs, so it still sees the raw number.
 */
export const formatInterpolation: FormatFunction = (value, _format, lng) => {
  if (!usesNativeDigits(lng)) {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? getNumberFormat(lng).format(value) : value;
  }
  if (typeof value === 'string' && /\d/.test(value) && NUMERIC_TEXT.test(value)) {
    return localizeDigits(value, lng);
  }
  return value;
};
