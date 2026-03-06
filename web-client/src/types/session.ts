// ============================================
// Session Types for Save/Restore Session Feature
// ============================================

export const SESSION_VERSION = 1;

export interface Session {
  version: number;
  name: string;
  createdAt: number;
  updatedAt: number;

  // Server connection info
  server: {
    host: string;
    port: number;
  };

  // KDB info
  kdb: {
    name: string;
  };

  // Waveform info
  waveform?: {
    name: string;
    useMockData: boolean;
  };

  // Waveform display settings
  waveformSettings?: {
    signalPrefix: string;
    spaceBeforeBracket: boolean;
  };

  // Source Tabs
  sourceTabs: Array<{
    id: string;
    moduleIndex: number | null;
    displayModuleIndex: number | null;
    signalDeclarationLine?: number;
  }>;
  activeSourceTabId?: string;

  // Waveform Tabs
  waveformTabs: Array<{
    id: string;
    label: string;
    nextSignalUniqueId: number;
    groups: Record<string, {
      name: string;
      parentId: string | null;
      signals: Array<{
        unique_id: number;
        globalId: number;
      }>;
      expanded: boolean;
    }>;
    selectedGroup?: string;
  }>;
  activeWaveformTabId?: string;

  // Bookmarks
  bookmarks: Array<{
    name: string;
    moduleIndex: number;
    fileId?: number;
    lineNumber: number;
    lineContent: string;
  }>;
}

export interface SessionInfo {
  name: string;
  createdAt: number;
  updatedAt: number;
}
