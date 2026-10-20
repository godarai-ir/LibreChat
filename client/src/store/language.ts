import { atom } from 'recoil';
import Cookies from 'js-cookie';
import { atomWithLocalStorage } from './utils';

const readStoredLang = () => {
  if (typeof localStorage === 'undefined') {
    return undefined;
  }

  const storedLang = localStorage.getItem('lang');
  if (!storedLang) {
    return undefined;
  }

  try {
    const parsedLang = JSON.parse(storedLang);
    return typeof parsedLang === 'string' ? parsedLang : storedLang;
  } catch {
    return storedLang;
  }
};

/** GodarChat is Persian-first: the browser's language is deliberately ignored. */
export const DEFAULT_LANG = 'fa-IR';

/** Only these are offered; a saved choice outside them (including legacy `auto`) falls back to Persian. */
export const OFFERED_LANGS = ['fa-IR', 'en-US'];

const defaultLang = () => {
  const saved = Cookies.get('lang') || readStoredLang();
  return saved && OFFERED_LANGS.includes(saved) ? saved : DEFAULT_LANG;
};

const lang = atomWithLocalStorage('lang', defaultLang());
const languageLoading = atom<boolean>({
  key: 'languageLoading',
  default: false,
});

export default { lang, languageLoading };
