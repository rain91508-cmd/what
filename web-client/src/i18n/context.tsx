// ============================================
// i18n Context - React Context Provider
// ============================================

import React, { createContext, useState, useCallback, useMemo, useEffect } from 'react';
import type { Language, Translations, I18nContextType } from './types';
import { SUPPORTED_LANGUAGES, getInitialLanguage, storeLanguage } from './config';

// Import all translations
import enTranslations from './locales/en';
import zhCNTranslations from './locales/zh-CN';
import zhTWTranslations from './locales/zh-TW';
import jaTranslations from './locales/ja';
import deTranslations from './locales/de';
import frTranslations from './locales/fr';
import ruTranslations from './locales/ru';

const translationsMap: Record<Language, Translations> = {
  'en': enTranslations,
  'zh-CN': zhCNTranslations,
  'zh-TW': zhTWTranslations,
  'ja': jaTranslations,
  'de': deTranslations,
  'fr': frTranslations,
  'ru': ruTranslations,
};

export const I18nContext = createContext<I18nContextType | null>(null);

interface I18nProviderProps {
  children: React.ReactNode;
}

export function I18nProvider({ children }: I18nProviderProps) {
  const [language, setLanguageState] = useState<Language>(getInitialLanguage());

  // Update language and persist to storage
  const setLanguage = useCallback((lang: Language) => {
    setLanguageState(lang);
    storeLanguage(lang);
    // Update html lang attribute
    document.documentElement.lang = lang;
  }, []);

  // Set initial html lang attribute
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  // Translation function
  const t = useCallback((key: string): string | Record<string, string> => {
    const translations = translationsMap[language];
    const keys = key.split('.');
    let value: unknown = translations;

    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = (value as Record<string, unknown>)[k];
      } else {
        // Return key as fallback if translation not found
        return key;
      }
    }

    return value as string | Record<string, string>;
  }, [language]);

  const contextValue = useMemo(() => ({
    language,
    setLanguage,
    t,
    languages: SUPPORTED_LANGUAGES,
  }), [language, setLanguage, t]);

  return (
    <I18nContext.Provider value={contextValue}>
      {children}
    </I18nContext.Provider>
  );
}
