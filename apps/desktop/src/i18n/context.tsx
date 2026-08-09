import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";

import { englishMessages } from "./messages";
import {
  effectiveLocale,
  formatCompactNumber,
  formatDateTime,
  formatNumber,
  LANGUAGE_STORAGE_KEY,
  languagePreference,
  localeTag,
  type AppLocale,
  type LanguagePreference,
} from "./locale";

interface I18nValue {
  readonly locale: AppLocale;
  readonly preference: LanguagePreference;
  readonly systemLocale: AppLocale;
  readonly setPreference: (preference: LanguagePreference) => void;
}

function browserLanguage(): string | undefined {
  return typeof navigator === "undefined" ? undefined : navigator.language;
}

function readPreference(): LanguagePreference {
  if (typeof localStorage === "undefined") return "system";
  try {
    return languagePreference(localStorage.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    return "system";
  }
}

let activeLocale: AppLocale = effectiveLocale(readPreference(), browserLanguage());

export function translate(message: string): string {
  return activeLocale === "ko" ? message : (englishMessages[message] ?? message);
}

export function formatLocalizedNumber(value: number): string {
  return formatNumber(value, activeLocale);
}

export function formatLocalizedCompactNumber(value: number): string {
  return formatCompactNumber(value, activeLocale);
}

/** 달력 축의 요일·월 이름. 배열로 박아 두면 언어를 바꿔도 한국어가 남습니다. */
export function formatLocalizedWeekday(weekday: number): string {
  const sunday = Date.UTC(2024, 0, 7);
  return new Intl.DateTimeFormat(localeTag(activeLocale), { weekday: "short", timeZone: "UTC" }).format(
    new Date(sunday + weekday * 86_400_000),
  );
}

export function formatLocalizedMonth(month: number): string {
  return new Intl.DateTimeFormat(localeTag(activeLocale), { month: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(2024, month, 1)),
  );
}

export function formatLocalizedDateTime(value: string | Date): string {
  return formatDateTime(value, activeLocale);
}

const I18nContext = createContext<I18nValue>({
  locale: activeLocale,
  preference: readPreference(),
  systemLocale: effectiveLocale("system", browserLanguage()),
  setPreference: () => undefined,
});

export function I18nProvider({ children }: { readonly children: ReactNode }) {
  const previousLocale = useRef(activeLocale);
  const [preference, setPreferenceState] = useState<LanguagePreference>(readPreference);
  const [language, setLanguage] = useState(browserLanguage);
  const detected = effectiveLocale("system", language);
  const locale = effectiveLocale(preference, language);
  activeLocale = locale;

  useEffect(() => {
    document.documentElement.lang = localeTag(locale);
  }, [locale]);

  useEffect(
    () => () => {
      activeLocale = previousLocale.current;
    },
    [],
  );

  useEffect(() => {
    const changed = () => {
      setLanguage(browserLanguage());
    };
    window.addEventListener("languagechange", changed);
    return () => {
      window.removeEventListener("languagechange", changed);
    };
  }, []);

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      preference,
      systemLocale: detected,
      setPreference: (next) => {
        try {
          localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
        } catch {
          // 언어 선택은 즉시 적용하고 저장소가 막힌 경우 현재 세션에서만 유지합니다.
        }
        setPreferenceState(next);
      },
    }),
    [detected, locale, preference],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
