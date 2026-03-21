// ============================================
// useTranslation Hook
// ============================================

import { useContext } from 'react';
import { I18nContext } from './context';

export function useTranslation() {
  const context = useContext(I18nContext);
  
  if (!context) {
    throw new Error('useTranslation must be used within an I18nProvider');
  }
  
  return context;
}

// Helper function for typed string translations
export function useT() {
  const { t, language, setLanguage, languages } = useTranslation();
  
  return {
    t: (key: string): string => t(key) as string,
    language,
    setLanguage,
    languages,
  };
}
