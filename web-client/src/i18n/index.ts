// ============================================
// i18n Module - Main Export
// ============================================

export { I18nProvider, I18nContext } from './context';
export { useTranslation, useT } from './hook';
export type { Language, LanguageConfig, Translations, I18nContextType } from './types';
export { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE, getInitialLanguage } from './config';
