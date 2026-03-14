// ============================================
// Search Types - Hierarchy Search Feature
// ============================================

/**
 * 搜索结果项
 */
export interface SearchResultItem {
  globalId: number;           // module或signal的global id
  fullName: string;           // full name（用于显示）
  type: 'module' | 'signal';  // 类型
  parentModuleIndex?: number; // 父module index（如果是signal）
  lineNumber?: number;        // 声明行号（用于跳转）
}

/**
 * 搜索结果组
 */
export interface SearchResultGroup {
  id: string;                 // 搜索会话ID
  pattern: string;            // 搜索pattern
  timestamp: number;          // 搜索时间
  isSignalSearch: boolean;    // 是否是signal搜索
  resultCount: number;        // 结果数量
  results: SearchResultItem[];
}

/**
 * 搜索历史记录项
 */
export interface SearchHistoryItem {
  pattern: string;
  isSignalSearch: boolean;
  timestamp: number;
}

/**
 * 搜索配置
 */
export interface SearchConfig {
  maxResults: number;         // 最大结果数
  maxHistory: number;         // 最大历史记录数
}

// 默认配置
export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  maxResults: 100,
  maxHistory: 20,
};

// ============================================
// Search Worker Messages
// ============================================

export type SearchWorkerRequest =
  | { type: 'START_SEARCH'; payload: StartSearchPayload }
  | { type: 'CANCEL_SEARCH' };

export type SearchWorkerResponse =
  | { type: 'SEARCH_PROGRESS'; payload: { current: number; total: number } }
  | { type: 'SEARCH_COMPLETE'; payload: SearchResultItem[] }
  | { type: 'SEARCH_CANCELLED' }
  | { type: 'SEARCH_ERROR'; payload: string };

export interface StartSearchPayload {
  pattern: string;
  isSignalSearch: boolean;
  startModuleIndex: number;
  kdbFileId: number;
}
