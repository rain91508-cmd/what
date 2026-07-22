// ============================================
// i18n Types - 多语言类型定义
// ============================================

export type Language = 'en' | 'zh-CN' | 'zh-TW' | 'ja' | 'de' | 'fr' | 'ru';

export interface LanguageConfig {
  code: Language;
  name: string;
  nativeName: string;
}

export interface Translations {
  // 菜单
  menu: {
    file: string;
    view: string;
    navigate: string;
    waveform: string;
    help: string;
  };
  // 菜单项
  menuItems: {
    // File
    connect: string;
    disconnect: string;
    openKdb: string;
    openCachedKdb: string;
    openKdbUrl: string;
    openLocalKdb: string;
    openWaveform: string;
    closeKdb: string;
    closeWaveform: string;
    saveSession: string;
    restoreSession: string;
    // View
    zoomIn: string;
    zoomOut: string;
    zoomFull: string;
    language: string;
    // Navigate
    historyBack: string;
    historyForward: string;
    addBookmark: string;
    findDriver: string;
    findDefinition: string;
    // Waveform
    addSignal: string;
    removeSignal: string;
    opfsCache: string;
    memoryCache: string;
    prefetchCache: string;
    prefetchRequiresCache: string;
    // Help
    kdbDebugTool: string;
    about: string;
  };
  // 工具栏
  toolbar: {
    connect: string;
    connected: string;
    openKdb: string;
    openCachedKdb: string;
    openWaveform: string;
    zoomIn: string;
    zoomOut: string;
    zoomFull: string;
    display: string;
    start: string;
    cursor: string;
    span: string;
    apply: string;
    search: string;
    cancelSearch: string;
    signals: string;
    addSourceTab: string;
    addWaveformTab: string;
    addTableViewTab: string;
    addBookmark: string;
    refreshCheck: string;
    autoCheckOn: string;
    autoCheckOff: string;
    previousLocation: string;
    nextLocation: string;
    pattern: string;
    value: string;
    edge: string;
    transition: string;
    rising: string;
    falling: string;
    any: string;
    from: string;
    to: string;
    searchBackward: string;
    searchForward: string;
  };
  // 对话框
  dialog: {
    // 通用
    cancel: string;
    ok: string;
    connect: string;
    retry: string;
    downloadAndLoad: string;
    // Connection
    connection: {
      title: string;
      host: string;
      port: string;
    };
    // KDB Selection
    kdbSelection: {
      title: string;
      loading: string;
      error: string;
      empty: string;
      noMatching: string;
      selectPrompt: string;
      filterPlaceholder: string;
      size: string;
    };
    // Cached (local IDB/OPFS) KDB Selection
    cachedKdb: {
      title: string;
      loading: string;
      error: string;
      empty: string;
      noMatching: string;
      selectPrompt: string;
      filterPlaceholder: string;
      open: string;
    };
    // Open KDB from URL
    kdbUrl: {
      title: string;
      prompt: string;
      placeholder: string;
      empty: string;
      invalid: string;
      load: string;
    };
    // Wave Selection
    waveSelection: {
      title: string;
      loading: string;
      error: string;
      empty: string;
    };
    // File Change
    fileChange: {
      title: string;
      message: string;
      reload: string;
    };
    // Session
    session: {
      saveTitle: string;
      restoreTitle: string;
      name: string;
      description: string;
      createTime: string;
      load: string;
      delete: string;
      confirmDelete: string;
      empty: string;
    };
  };
  // 状态
  status: {
    connected: string;
    disconnected: string;
  };
  // 语言名称
  languages: {
    'en': string;
    'zh-CN': string;
    'zh-TW': string;
    'ja': string;
    'de': string;
    'fr': string;
    'ru': string;
  };
  // Panel相关
  panel: {
    // Design Browser / Hierarchy
    hierarchy: {
      title: string;
      searchPlaceholder: string;
      noResults: string;
      loading: string;
      files: string;
    };
    // Signal Panel / Signal List
    signal: {
      title: string;
      name: string;
      value: string;
      type: string;
      width: string;
      searchPlaceholder: string;
      noSignals: string;
      loading: string;
      addToWaveform: string;
      removeFromWaveform: string;
      selectModule: string;
    };
    // Message Window
    message: {
      title: string;
      clear: string;
      copy: string;
      info: string;
      warning: string;
      error: string;
      success: string;
    };
    // Splitter tooltip
    splitter: {
      hideLeftPanel: string;
      showLeftPanel: string;
    };
    // Tab Panel
    tab: {
      source: string;
      waveform: string;
      table: string;
      close: string;
      closeOthers: string;
      closeAll: string;
      unsaved: string;
    };
    // Waveform Window
    waveform: {
      time: string;
      signalName: string;
      signalValue: string;
      noSignals: string;
      loading: string;
      noSignalsAdded: string;
      cursor: string;
      // Waveform signal list headers
      scope: string;
      name: string;
      value: string;
      group: string;
      all: string;
    };
    // Source Code Window
    source: {
      title: string;
      line: string;
      column: string;
      noFile: string;
      loading: string;
      selectInstance: string;
      cursorTime: string;
      signal: string;
      value: string;
      width: string;
      radix: string;
    };
    // Table View
    table: {
      title: string;
      time: string;
      noData: string;
      loading: string;
    };
  };
  // Table View specific
  tableView: {
    earlyExit: string;
    maxRows: string;
    filter: string;
    removeSignal: string;
    filterByMetadata: string;
    continueFetch: string;
    fetching: string;
    pageSize: string;
    columns: string;
    toggleColumns: string;
    refreshData: string;
    // Metadata filters
    hasX: string;
    hasZ: string;
    mixed: string;
    transition: string;
    toggle: string;
  };
  // Message Window tabs
  messageTabs: {
    messages: string;
    bookmarks: string;
    wavemarks: string;
    search: string;
    drivers: string;
  };
  // Messages
  messages: {
    appInitialized: string;
    pleaseConnect: string;
    addedSourceTab: string;
    addedWaveformTab: string;
    addedTableViewTab: string;
    connected: string;
    disconnected: string;
    kdbLoaded: string;
    waveformLoaded: string;
    createdTableView: string;
    signals: string;
    timeRange: string;
  };
}

export interface I18nContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: string) => string | Record<string, string>;
  languages: LanguageConfig[];
}
