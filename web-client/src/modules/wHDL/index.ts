// ============================================
// wHDL Module - Code Viewer & Analyzer
// ============================================
// 
// Responsibilities (per spec.md):
// - Syntax highlighting for Verilog/SystemVerilog
// - Code folding (module, always, begin-end blocks)
// - Code navigation (go to definition, find scope)
// - Driver/Load tracing (with visual indicators)
// - Active Annotation (signal value overlay)
// - Bookmark management

import type { Signal, Instance } from '../../types';

// Code position for navigation
export interface CodePosition {
  filePath: string;
  line: number;
  column: number;
}

// Syntax highlighting token
export interface Token {
  type: TokenType;
  value: string;
  start: number;
  end: number;
  line: number;
}

export enum TokenType {
  KEYWORD = 'keyword',
  IDENTIFIER = 'identifier',
  NUMBER = 'number',
  STRING = 'string',
  COMMENT = 'comment',
  OPERATOR = 'operator',
  PREPROCESSOR = 'preprocessor',
  SYSTEM_TASK = 'system_task',
}

// Foldable region
export interface FoldRegion {
  type: FoldType;
  startLine: number;
  endLine: number;
  collapsed: boolean;
}

export enum FoldType {
  MODULE = 'module',
  ALWAYS = 'always',
  INITIAL = 'initial',
  BEGIN_END = 'begin_end',
  COMMENT = 'comment',
  TASK = 'task',
  FUNCTION = 'function',
}

// Trace result
export interface TraceResult {
  signal: Signal;
  drivers: DriverInfo[];
  loads: LoadInfo[];
}

export interface DriverInfo {
  signal: Signal;
  instance: Instance;
  line: number;
  type: DriverType;
}

export enum DriverType {
  CONTINUOUS = 'continuous',  // assign
  PROCEDURAL = 'procedural',  // always/initial
  PORT = 'port',              // module port
}

export interface LoadInfo {
  signal: Signal;
  instance: Instance;
  line: number;
  type: LoadType;
}

export enum LoadType {
  READ = 'read',
  PORT = 'port',
  SENSITIVITY = 'sensitivity',
}

// Bookmark
export interface Bookmark {
  id: string;
  filePath: string;
  line: number;
  label?: string;
}

// Active annotation entry
export interface ActiveAnnotation {
  signal: Signal;
  value: string;
  position: CodePosition;
}

// wHDL Module Interface
export interface wHDLModule {
  // File operations
  loadFile(filePath: string, content: string): void;
  getFileContent(filePath: string): string | null;
  
  // Syntax highlighting
  tokenize(filePath: string): Token[];
  getLineTokens(filePath: string, line: number): Token[];
  
  // Folding
  getFoldRegions(filePath: string): FoldRegion[];
  toggleFold(filePath: string, line: number): void;
  expandAll(filePath: string): void;
  collapseAll(filePath: string): void;
  
  // Navigation
  goToDefinition(identifier: string): CodePosition | null;
  findScope(line: number): string | null;
  findString(pattern: string): CodePosition[];
  goToLine(line: number): void;
  
  // Tracing
  traceDriver(signal: Signal): TraceResult;
  traceLoad(signal: Signal): TraceResult;
  traceConnectivity(signal: Signal): TraceResult;
  
  // Active annotation
  enableActiveAnnotation(): void;
  disableActiveAnnotation(): void;
  updateAnnotations(time: number, values: Map<string, string>): void;
  getAnnotations(): ActiveAnnotation[];
  
  // Bookmarks
  addBookmark(position: CodePosition, label?: string): Bookmark;
  removeBookmark(id: string): void;
  getBookmarks(): Bookmark[];
  goToBookmark(id: string): void;
}

// wHDL Module Implementation
class wHDLModuleImpl implements wHDLModule {
  private files: Map<string, string> = new Map();
  private tokens: Map<string, Token[]> = new Map();
  private foldRegions: Map<string, FoldRegion[]> = new Map();
  private bookmarks: Map<string, Bookmark> = new Map();
  private annotations: Map<string, ActiveAnnotation> = new Map();
  private activeAnnotationEnabled = false;

  // File operations
  loadFile(filePath: string, content: string): void {
    this.files.set(filePath, content);
    this.tokenize(filePath);
    this.analyzeFoldRegions(filePath);
  }

  getFileContent(filePath: string): string | null {
    return this.files.get(filePath) || null;
  }

  // Syntax highlighting
  tokenize(filePath: string): Token[] {
    const content = this.files.get(filePath);
    if (!content) return [];

    const tokens: Token[] = [];
    const lines = content.split('\n');
    
    // Verilog/SystemVerilog keywords
    const keywords = new Set([
      'module', 'endmodule', 'interface', 'endinterface',
      'class', 'endclass', 'package', 'endpackage',
      'program', 'endprogram', 'function', 'endfunction',
      'task', 'endtask', 'begin', 'end', 'fork', 'join',
      'if', 'else', 'case', 'casex', 'casez', 'endcase',
      'for', 'while', 'do', 'forever', 'repeat', 'foreach',
      'always', 'always_comb', 'always_ff', 'always_latch',
      'initial', 'final',
      'assign', 'deassign', 'force', 'release',
      'input', 'output', 'inout', 'ref',
      'wire', 'reg', 'logic', 'bit', 'byte', 'int', 'integer',
      'real', 'time', 'shortint', 'longint', 'enum', 'struct',
      'union', 'packed', 'signed', 'unsigned',
      'parameter', 'localparam', 'specparam', 'defparam',
      'generate', 'endgenerate', 'genvar',
      'posedge', 'negedge', 'edge',
      'and', 'or', 'not', 'nand', 'nor', 'xor', 'xnor',
      'buf', 'bufif0', 'bufif1', 'notif0', 'notif1',
      'assert', 'assume', 'cover', 'property', 'sequence',
      'import', 'export', 'from', 'context',
      'const', 'var', 'static', 'automatic',
      'virtual', 'extends', 'implements', 'super', 'this',
      'new', 'null', 'void', 'null', '$unit',
    ]);

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum];
      // Simple tokenizer (can be enhanced with proper lexer)
      const words = line.match(/\b\w+\b/g) || [];
      
      for (const word of words) {
        if (keywords.has(word)) {
          const start = line.indexOf(word);
          tokens.push({
            type: TokenType.KEYWORD,
            value: word,
            start,
            end: start + word.length,
            line: lineNum,
          });
        }
      }
    }

    this.tokens.set(filePath, tokens);
    return tokens;
  }

  getLineTokens(filePath: string, line: number): Token[] {
    const tokens = this.tokens.get(filePath) || [];
    return tokens.filter(t => t.line === line);
  }

  // Folding
  private analyzeFoldRegions(filePath: string): void {
    const content = this.files.get(filePath);
    if (!content) return;

    const regions: FoldRegion[] = [];
    const lines = content.split('\n');
    const stack: { type: FoldType; line: number }[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      // Module folding
      if (/^module\s+\w+/.test(line)) {
        stack.push({ type: FoldType.MODULE, line: i });
      } else if (/^endmodule/.test(line) && stack.length > 0) {
        const start = stack.pop();
        if (start && start.type === FoldType.MODULE) {
          regions.push({
            type: FoldType.MODULE,
            startLine: start.line,
            endLine: i,
            collapsed: false,
          });
        }
      }
      
      // Always block folding
      else if (/^always(_comb|_ff|_latch)?\b/.test(line)) {
        stack.push({ type: FoldType.ALWAYS, line: i });
      }
      
      // Begin-end folding
      else if (/\bbegin\b/.test(line)) {
        stack.push({ type: FoldType.BEGIN_END, line: i });
      } else if (/\bend\b/.test(line) && stack.length > 0) {
        const start = stack.pop();
        if (start && start.type === FoldType.BEGIN_END) {
          regions.push({
            type: FoldType.BEGIN_END,
            startLine: start.line,
            endLine: i,
            collapsed: false,
          });
        }
      }
    }

    this.foldRegions.set(filePath, regions);
  }

  getFoldRegions(filePath: string): FoldRegion[] {
    return this.foldRegions.get(filePath) || [];
  }

  toggleFold(filePath: string, line: number): void {
    const regions = this.foldRegions.get(filePath);
    if (!regions) return;

    for (const region of regions) {
      if (region.startLine === line) {
        region.collapsed = !region.collapsed;
        break;
      }
    }
  }

  expandAll(filePath: string): void {
    const regions = this.foldRegions.get(filePath);
    if (!regions) return;

    for (const region of regions) {
      region.collapsed = false;
    }
  }

  collapseAll(filePath: string): void {
    const regions = this.foldRegions.get(filePath);
    if (!regions) return;

    for (const region of regions) {
      region.collapsed = true;
    }
  }

  // Navigation
  goToDefinition(_identifier: string): CodePosition | null {
    // Implementation would query knowledge base
    return null;
  }

  findScope(_line: number): string | null {
    // Implementation would analyze hierarchy
    return null;
  }

  findString(pattern: string): CodePosition[] {
    const positions: CodePosition[] = [];
    const regex = new RegExp(pattern, 'g');

    for (const [filePath, content] of this.files) {
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          positions.push({
            filePath,
            line: i,
            column: lines[i].indexOf(pattern),
          });
        }
      }
    }

    return positions;
  }

  goToLine(_line: number): void {
    // UI operation - would scroll to line
  }

  // Tracing
  traceDriver(signal: Signal): TraceResult {
    // Implementation would query knowledge base for driver info
    return {
      signal,
      drivers: [],
      loads: [],
    };
  }

  traceLoad(signal: Signal): TraceResult {
    // Implementation would query knowledge base for load info
    return {
      signal,
      drivers: [],
      loads: [],
    };
  }

  traceConnectivity(signal: Signal): TraceResult {
    const drivers = this.traceDriver(signal);
    const loads = this.traceLoad(signal);
    return {
      signal,
      drivers: drivers.drivers,
      loads: loads.loads,
    };
  }

  // Active annotation
  enableActiveAnnotation(): void {
    this.activeAnnotationEnabled = true;
  }

  disableActiveAnnotation(): void {
    this.activeAnnotationEnabled = false;
  }

  updateAnnotations(_time: number, values: Map<string, string>): void {
    if (!this.activeAnnotationEnabled) return;

    this.annotations.clear();
    
    for (const [_signalPath, _value] of values) {
      // Find signal position in code
      // This would query the knowledge base
    }
  }

  getAnnotations(): ActiveAnnotation[] {
    return Array.from(this.annotations.values());
  }

  // Bookmarks
  addBookmark(position: CodePosition, label?: string): Bookmark {
    const id = `bookmark_${Date.now()}_${Math.random()}`;
    const bookmark: Bookmark = {
      id,
      filePath: position.filePath,
      line: position.line,
      label,
    };
    this.bookmarks.set(id, bookmark);
    return bookmark;
  }

  removeBookmark(id: string): void {
    this.bookmarks.delete(id);
  }

  getBookmarks(): Bookmark[] {
    return Array.from(this.bookmarks.values());
  }

  goToBookmark(id: string): void {
    const bookmark = this.bookmarks.get(id);
    if (bookmark) {
      this.goToLine(bookmark.line);
    }
  }
}

// Singleton instance
export const wHDL = new wHDLModuleImpl();
export { wHDLModuleImpl };
