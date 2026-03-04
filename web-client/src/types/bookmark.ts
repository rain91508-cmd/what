// Bookmark types

export interface Bookmark {
  id: string;
  name: string;
  moduleIndex: number;  // 1-based module index (display module when bookmark was created, 0 for file mode)
  fileId?: number;      // File ID (for file mode when moduleIndex is 0)
  lineNumber: number;   // Line number to highlight
  lineContent: string;  // Line content for display
  timestamp: number;
}

// Global bookmark manager
class BookmarkManager {
  private bookmarks: Bookmark[] = [];
  private listeners: Set<() => void> = new Set();

  getBookmarks(): Bookmark[] {
    return [...this.bookmarks];
  }

  addBookmark(bookmark: Omit<Bookmark, 'id' | 'timestamp' | 'name'> & { name?: string }): Bookmark {
    // Auto-generate name like "Mark 1", "Mark 2", etc.
    const autoName = bookmark.name || `Mark ${this.bookmarks.length + 1}`;
    const newBookmark: Bookmark = {
      ...bookmark,
      name: autoName,
      id: `bookmark_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
    };
    this.bookmarks.push(newBookmark);
    this.notifyListeners();
    return newBookmark;
  }

  deleteBookmark(id: string): void {
    this.bookmarks = this.bookmarks.filter(b => b.id !== id);
    this.notifyListeners();
  }

  updateBookmarkName(id: string, name: string): void {
    const bookmark = this.bookmarks.find(b => b.id === id);
    if (bookmark) {
      bookmark.name = name;
      this.notifyListeners();
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clearAll(): void {
    this.bookmarks = [];
    this.notifyListeners();
  }

  private notifyListeners(): void {
    this.listeners.forEach(listener => listener());
  }
}

export const bookmarkManager = new BookmarkManager();
