// ============================================
// i18n Config - 语言配置
// ============================================

import type { LanguageConfig, Language } from './types';

export const SUPPORTED_LANGUAGES: LanguageConfig[] = [
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'zh-CN', name: 'Chinese (Simplified)', nativeName: '简体中文' },
  { code: 'zh-TW', name: 'Chinese (Traditional)', nativeName: '繁體中文' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語' },
  { code: 'de', name: 'German', nativeName: 'Deutsch' },
  { code: 'fr', name: 'French', nativeName: 'Français' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский' },
];

export const DEFAULT_LANGUAGE: Language = 'en';
export const STORAGE_KEY = 'what-language';

export function getBrowserLanguage(): Language {
  const browserLang = navigator.language.toLowerCase();
  
  // 检查完全匹配
  const exactMatch = SUPPORTED_LANGUAGES.find(l => l.code.toLowerCase() === browserLang);
  if (exactMatch) return exactMatch.code;
  
  // 检查前缀匹配 (如 zh-cn 匹配 zh)
  const prefixMatch = SUPPORTED_LANGUAGES.find(l => browserLang.startsWith(l.code.toLowerCase()));
  if (prefixMatch) return prefixMatch.code;
  
  return DEFAULT_LANGUAGE;
}

export function getStoredLanguage(): Language | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const lang = stored as Language;
      if (SUPPORTED_LANGUAGES.some(l => l.code === lang)) {
        return lang;
      }
    }
  } catch {
    // localStorage 不可用
  }
  return null;
}

export function storeLanguage(lang: Language): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // localStorage 不可用
  }
}

export function getInitialLanguage(): Language {
  return getStoredLanguage() || getBrowserLanguage();
}
