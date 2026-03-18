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

  // Source Tabs
  sourceTabs: Array<{
    id: string;
    moduleIndex: number | null;
    displayModuleIndex: number | null;
    signalDeclarationLine?: number;
  }>;
  activeSourceTabId?: string;

  // Global waveform signal ID counter (shared across all tabs)
  nextWaveformSignalId: number;

  // Waveform Tabs
  waveformTabs: Array<{
    id: string;
    label: string;
    groups: Record<string, {
      name: string;
      parentId: string | null;
      signals: Array<{
        unique_id: number;
        globalId: number;
      }>;
      expanded: boolean;
      children: string[];
    }>;
    selectedGroup?: string;
    // Viewport state (time in LoD0Unit)
    viewport?: {
      timeStart: number;
      timeEnd: number;
    };
    cursorPosition?: number;
    // Waveform total range for viewport validation
    waveformRange?: {
      start: number;
      end: number;
    };
    // Signal display formats: unique_id -> format
    signalDisplayFormats?: Record<number, 'hex' | 'bin' | 'oct' | 'dec'>;
    // Signal hierarchy selections: unique_id -> selected indices array
    signalHierarchySelections?: Record<number, number[]>;
    // Per-tab signal prefix settings
    signalPrefix?: string;      // Local prefix (removed from local signal name)
    serverPrefix?: string;      // Server prefix (added to server signal name)
    spaceBeforeBracket?: boolean;
    // Wavemarks for this tab
    wavemarks?: Array<{
      id: string;
      name: string;
      time: number;
      createdAt: number;
      expandedGroups: string[];
    }>;
  }>;
  activeWaveformTabId?: string;

  // TableView Tabs
  tableviewTabs: Array<{
    id: string;
    label: string;
    signals: Array<{
      globalId: number;
      drawSigId: number;
      name: string;
      row: number;
      width: number;
      radix: 'hex' | 'bin' | 'oct' | 'dec';
    }>;
    startTime: number;
    endTime: number;
    currentPage: number;
    // Column filters (text filter values)
    columnFilters?: Array<{
      id: string;
      value: string;
    }>;
    // Metadata filters per column
    columnMetadataFilters?: Record<string, {
      hasX: boolean;
      hasZ: boolean;
      mixed: boolean;
      hasTransition: boolean;
      hasToggle: boolean;
    }>;
    // Radix selection per column
    columnRadix?: Record<string, 'hex' | 'bin' | 'oct' | 'dec'>;
    // Per-tab signal prefix settings
    signalPrefix?: string;
    serverPrefix?: string;
    spaceBeforeBracket?: boolean;
  }>;
  activeTableviewTabId?: string;

  // Bookmarks
  bookmarks: Array<{
    name: string;
    moduleIndex: number;
    fileId?: number;
    lineNumber: number;
    lineContent: string;
  }>;

  // Hierarchy panel state
  hierarchy?: {
    expandedModules: number[];  // List of expanded module indices
    selectedModule: number | null;  // Selected module index
    // Pagination state for each expanded node: nodeId -> { startPosition, pageSize }
    pagination?: Record<number, {
      startPosition: number;
      pageSize: number;
    }>;
  };
}

export interface SessionInfo {
  name: string;
  createdAt: number;
  updatedAt: number;
}
