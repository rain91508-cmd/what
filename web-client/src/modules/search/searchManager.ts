// ============================================
// Search Manager - Manages search history and results
// ============================================

import type { SearchResultGroup, SearchHistoryItem, SearchConfig } from '../../types/search';
import { DEFAULT_SEARCH_CONFIG } from '../../types/search';

class SearchManager {
  private searchResults: SearchResultGroup[] = [];
  private searchHistory: SearchHistoryItem[] = [];
  private config: SearchConfig = DEFAULT_SEARCH_CONFIG;
  private listeners: Set<() => void> = new Set();

  // ============================================
  // Search Results
  // ============================================

  getSearchResults(): SearchResultGroup[] {
    return [...this.searchResults];
  }

  addSearchResult(result: SearchResultGroup): void {
    this.searchResults.unshift(result);
    this.notifyListeners();
  }

  deleteSearchResult(id: string): void {
    this.searchResults = this.searchResults.filter(r => r.id !== id);
    this.notifyListeners();
  }

  clearSearchResults(): void {
    this.searchResults = [];
    this.notifyListeners();
  }

  // ============================================
  // Search History
  // ============================================

  getSearchHistory(): SearchHistoryItem[] {
    return [...this.searchHistory];
  }

  addToHistory(pattern: string, isSignalSearch: boolean): void {
    // Remove duplicate if exists
    this.searchHistory = this.searchHistory.filter(
      h => !(h.pattern === pattern && h.isSignalSearch === isSignalSearch)
    );

    // Add to front
    this.searchHistory.unshift({
      pattern,
      isSignalSearch,
      timestamp: Date.now(),
    });

    // Limit history size
    if (this.searchHistory.length > this.config.maxHistory) {
      this.searchHistory = this.searchHistory.slice(0, this.config.maxHistory);
    }

    this.notifyListeners();
  }

  deleteFromHistory(pattern: string, isSignalSearch: boolean): void {
    this.searchHistory = this.searchHistory.filter(
      h => !(h.pattern === pattern && h.isSignalSearch === isSignalSearch)
    );
    this.notifyListeners();
  }

  clearHistory(): void {
    this.searchHistory = [];
    this.notifyListeners();
  }

  // ============================================
  // Subscription
  // ============================================

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(): void {
    this.listeners.forEach(listener => listener());
  }
}

// Singleton instance
export const searchManager = new SearchManager();
