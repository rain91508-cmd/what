// ============================================
// Knowledge Manager - Legacy Implementation
// ============================================
//
// @deprecated This is the old implementation that loads all data at once.
// Use kdbManager from './kdbManager' instead for on-demand loading.

import type {
  KnowledgeBase,
  Signal,
  Module,
  Instance,
  Connection,
  SignalType,
  SignalDirection,
} from '../../types';

// Query filters
export interface SignalFilter {
  namePattern?: string;
  type?: SignalType;
  direction?: SignalDirection;
  moduleName?: string;
  bitWidthMin?: number;
  bitWidthMax?: number;
}

export interface InstanceFilter {
  namePattern?: string;
  moduleName?: string;
  parentPath?: string;
}

// Hierarchy node
export interface HierarchyNode {
  type: 'module' | 'instance' | 'signal';
  name: string;
  fullPath: string;
  children: HierarchyNode[];
  expanded: boolean;
  data: Signal | Module | Instance;
}

// Connection query result
export interface ConnectionQueryResult {
  signal: Signal;
  drivers: Connection[];
  loads: Connection[];
}

// Value formatter
export interface ValueFormatOptions {
  format: 'binary' | 'octal' | 'decimal' | 'hexadecimal' | 'ascii';
  bitWidth?: number;
  showPrefix?: boolean;
  uppercase?: boolean;
}

// Knowledge Manager Interface
export interface KnowledgeManager {
  // Initialization
  initialize(kdb: KnowledgeBase): void;
  isInitialized(): boolean;
  getKnowledgeBase(): KnowledgeBase | null;

  // Signal queries
  getSignal(fullPath: string): Signal | null;
  findSignals(filter: SignalFilter): Signal[];
  searchSignalsByName(pattern: string): Signal[];
  getSignalsByModule(moduleName: string): Signal[];

  // Module queries
  getModule(name: string): Module | null;
  getAllModules(): Module[];
  findModules(namePattern: string): Module[];

  // Instance queries
  getInstance(fullPath: string): Instance | null;
  getChildInstances(parentPath: string): Instance[];
  findInstances(filter: InstanceFilter): Instance[];

  // Hierarchy
  buildHierarchy(): HierarchyNode;
  expandNode(path: string): void;
  collapseNode(path: string): void;
  getHierarchyPath(path: string): HierarchyNode[];

  // Connections
  getConnections(signalPath: string): ConnectionQueryResult;
  traceDriver(signalPath: string): Connection[];
  traceLoad(signalPath: string): Connection[];

  // Value formatting
  formatValue(value: string, options: ValueFormatOptions): string;
  parseValue(value: string, format: ValueFormatOptions['format']): string;

  // Bus operations
  createBus(signals: Signal[], name: string, msbFirst: boolean): Signal;
  expandBus(busSignal: Signal): Signal[];
  getBusBits(busSignal: Signal): Signal[];
}

// Knowledge Manager Implementation
class KnowledgeManagerImpl implements KnowledgeManager {
  private kdb: KnowledgeBase | null = null;
  private initialized = false;
  private hierarchyRoot: HierarchyNode | null = null;

  // Initialization
  initialize(kdb: KnowledgeBase): void {
    this.kdb = kdb;
    this.initialized = true;
    this.buildHierarchy();
  }

  isInitialized(): boolean {
    return this.initialized && this.kdb !== null;
  }

  getKnowledgeBase(): KnowledgeBase | null {
    return this.kdb;
  }

  private getKdb(): KnowledgeBase {
    if (!this.kdb) {
      throw new Error('Knowledge base not initialized');
    }
    return this.kdb;
  }

  // Signal queries
  getSignal(fullPath: string): Signal | null {
    const kdb = this.getKdb();
    return kdb.signals.get(fullPath) || null;
  }

  findSignals(filter: SignalFilter): Signal[] {
    const kdb = this.getKdb();
    const results: Signal[] = [];

    for (const signal of kdb.signals.values()) {
      if (this.matchesSignalFilter(signal, filter)) {
        results.push(signal);
      }
    }

    return results;
  }

  private matchesSignalFilter(signal: Signal, filter: SignalFilter): boolean {
    if (filter.namePattern) {
      const regex = new RegExp(filter.namePattern, 'i');
      if (!regex.test(signal.name)) return false;
    }

    if (filter.type !== undefined && signal.type !== filter.type) {
      return false;
    }

    if (filter.direction !== undefined && signal.direction !== filter.direction) {
      return false;
    }

    if (filter.moduleName) {
      // Check if signal belongs to module
      const module = this.findModuleForSignal(signal);
      if (!module || module.name !== filter.moduleName) {
        return false;
      }
    }

    if (filter.bitWidthMin !== undefined && signal.bitWidth < filter.bitWidthMin) {
      return false;
    }

    if (filter.bitWidthMax !== undefined && signal.bitWidth > filter.bitWidthMax) {
      return false;
    }

    return true;
  }

  private findModuleForSignal(signal: Signal): Module | null {
    const kdb = this.getKdb();
    // Find module by file path and line number
    for (const module of kdb.modules.values()) {
      if (signal.filePath === module.filePath &&
          signal.lineNumber >= module.startLine &&
          signal.lineNumber <= module.endLine) {
        return module;
      }
    }
    return null;
  }

  searchSignalsByName(pattern: string): Signal[] {
    const kdb = this.getKdb();
    const regex = new RegExp(pattern, 'i');
    const results: Signal[] = [];

    for (const signal of kdb.signals.values()) {
      if (regex.test(signal.name) || regex.test(signal.fullPath)) {
        results.push(signal);
      }
    }

    return results;
  }

  getSignalsByModule(moduleName: string): Signal[] {
    const module = this.getModule(moduleName);
    if (!module) return [];

    const results: Signal[] = [];
    const kdb = this.getKdb();

    for (const signal of kdb.signals.values()) {
      if (signal.filePath === module.filePath &&
          signal.lineNumber >= module.startLine &&
          signal.lineNumber <= module.endLine) {
        results.push(signal);
      }
    }

    return results;
  }

  // Module queries
  getModule(name: string): Module | null {
    const kdb = this.getKdb();
    return kdb.modules.get(name) || null;
  }

  getAllModules(): Module[] {
    const kdb = this.getKdb();
    return Array.from(kdb.modules.values());
  }

  findModules(namePattern: string): Module[] {
    const kdb = this.getKdb();
    const regex = new RegExp(namePattern, 'i');
    const results: Module[] = [];

    for (const module of kdb.modules.values()) {
      if (regex.test(module.name)) {
        results.push(module);
      }
    }

    return results;
  }

  // Instance queries
  getInstance(fullPath: string): Instance | null {
    const kdb = this.getKdb();
    return kdb.instances.get(fullPath) || null;
  }

  getChildInstances(parentPath: string): Instance[] {
    const kdb = this.getKdb();
    const results: Instance[] = [];

    for (const instance of kdb.instances.values()) {
      if (instance.parentPath === parentPath) {
        results.push(instance);
      }
    }

    return results;
  }

  findInstances(filter: InstanceFilter): Instance[] {
    const kdb = this.getKdb();
    const results: Instance[] = [];

    for (const instance of kdb.instances.values()) {
      if (this.matchesInstanceFilter(instance, filter)) {
        results.push(instance);
      }
    }

    return results;
  }

  private matchesInstanceFilter(instance: Instance, filter: InstanceFilter): boolean {
    if (filter.namePattern) {
      const regex = new RegExp(filter.namePattern, 'i');
      if (!regex.test(instance.name)) return false;
    }

    if (filter.moduleName && instance.moduleName !== filter.moduleName) {
      return false;
    }

    if (filter.parentPath && instance.parentPath !== filter.parentPath) {
      return false;
    }

    return true;
  }

  // Hierarchy
  buildHierarchy(): HierarchyNode {
    const kdb = this.getKdb();

    // Find root instances (those without parent)
    const rootInstances: Instance[] = [];
    for (const instance of kdb.instances.values()) {
      if (!instance.parentPath || instance.parentPath === '') {
        rootInstances.push(instance);
      }
    }

    // Build tree
    this.hierarchyRoot = {
      type: 'module',
      name: 'Design',
      fullPath: '',
      children: rootInstances.map(inst => this.buildHierarchyNode(inst)),
      expanded: true,
      data: {} as Module,
    };

    return this.hierarchyRoot;
  }

  private buildHierarchyNode(instance: Instance): HierarchyNode {
    const kdb = this.getKdb();
    const children: HierarchyNode[] = [];

    // Add child instances
    for (const childPath of instance.children) {
      const childInstance = kdb.instances.get(childPath);
      if (childInstance) {
        children.push(this.buildHierarchyNode(childInstance));
      }
    }

    // Add signals belonging to this instance
    const signals = this.getSignalsByInstance(instance.fullPath);
    for (const signal of signals) {
      children.push({
        type: 'signal',
        name: signal.name,
        fullPath: signal.fullPath,
        children: [],
        expanded: false,
        data: signal,
      });
    }

    return {
      type: 'instance',
      name: instance.name,
      fullPath: instance.fullPath,
      children,
      expanded: false,
      data: instance,
    };
  }

  private getSignalsByInstance(instancePath: string): Signal[] {
    const kdb = this.getKdb();
    const results: Signal[] = [];

    for (const signal of kdb.signals.values()) {
      if (signal.fullPath.startsWith(instancePath + '.') ||
          signal.fullPath === instancePath) {
        results.push(signal);
      }
    }

    return results;
  }

  expandNode(path: string): void {
    const node = this.findNode(path);
    if (node) {
      node.expanded = true;
    }
  }

  collapseNode(path: string): void {
    const node = this.findNode(path);
    if (node) {
      node.expanded = false;
    }
  }

  private findNode(path: string): HierarchyNode | null {
    if (!this.hierarchyRoot) return null;

    const search = (node: HierarchyNode): HierarchyNode | null => {
      if (node.fullPath === path) return node;

      for (const child of node.children) {
        const result = search(child);
        if (result) return result;
      }

      return null;
    };

    return search(this.hierarchyRoot);
  }

  getHierarchyPath(path: string): HierarchyNode[] {
    const result: HierarchyNode[] = [];
    if (!this.hierarchyRoot) return result;

    const search = (node: HierarchyNode, currentPath: HierarchyNode[]): boolean => {
      const newPath = [...currentPath, node];

      if (node.fullPath === path) {
        result.push(...newPath);
        return true;
      }

      for (const child of node.children) {
        if (search(child, newPath)) {
          return true;
        }
      }

      return false;
    };

    search(this.hierarchyRoot, []);
    return result;
  }

  // Connections
  getConnections(signalPath: string): ConnectionQueryResult {
    const kdb = this.getKdb();
    const signal = this.getSignal(signalPath);

    if (!signal) {
      return { signal: {} as Signal, drivers: [], loads: [] };
    }

    const drivers: Connection[] = [];
    const loads: Connection[] = [];

    for (const conn of kdb.connections) {
      if (conn.loadSignal === signalPath) {
        drivers.push(conn);
      }
      if (conn.driverSignal === signalPath) {
        loads.push(conn);
      }
    }

    return { signal, drivers, loads };
  }

  traceDriver(signalPath: string): Connection[] {
    return this.getConnections(signalPath).drivers;
  }

  traceLoad(signalPath: string): Connection[] {
    return this.getConnections(signalPath).loads;
  }

  // Value formatting
  formatValue(value: string, options: ValueFormatOptions): string {
    // Parse the value (assuming it's in a standard format)
    const numericValue = this.parseNumericValue(value);

    switch (options.format) {
      case 'binary':
        return this.toBinary(numericValue, options.bitWidth);
      case 'octal':
        return this.toOctal(numericValue);
      case 'decimal':
        return numericValue.toString(10);
      case 'hexadecimal':
        return this.toHexadecimal(numericValue, options.bitWidth, options.uppercase);
      case 'ascii':
        return this.toAscii(numericValue);
      default:
        return value;
    }
  }

  private parseNumericValue(value: string): number {
    // Handle different value formats (binary, hex, etc.)
    value = value.trim();

    if (value.startsWith('0b') || value.startsWith('0B')) {
      return parseInt(value.slice(2), 2);
    } else if (value.startsWith('0x') || value.startsWith('0X')) {
      return parseInt(value.slice(2), 16);
    } else if (value.startsWith('0') && value.length > 1) {
      return parseInt(value, 8);
    } else {
      return parseInt(value, 10);
    }
  }

  private toBinary(value: number, bitWidth?: number): string {
    const width = bitWidth || Math.max(1, Math.ceil(Math.log2(value + 1)));
    return '0b' + value.toString(2).padStart(width, '0');
  }

  private toOctal(value: number): string {
    return '0o' + value.toString(8);
  }

  private toHexadecimal(value: number, bitWidth?: number, uppercase?: boolean): string {
    const width = bitWidth ? Math.ceil(bitWidth / 4) : Math.max(1, Math.ceil(Math.log2(value + 1) / 4));
    const hex = value.toString(16).padStart(width, '0');
    return '0x' + (uppercase ? hex.toUpperCase() : hex);
  }

  private toAscii(value: number): string {
    // Convert to ASCII characters
    let result = '';
    let remaining = value;
    while (remaining > 0) {
      const charCode = remaining & 0xFF;
      result = String.fromCharCode(charCode) + result;
      remaining >>= 8;
    }
    return result || String.fromCharCode(0);
  }

  parseValue(value: string, _format: ValueFormatOptions['format']): string {
    // Convert from format to internal representation
    const numericValue = this.parseNumericValue(value);
    return numericValue.toString();
  }

  // Bus operations
  createBus(signals: Signal[], name: string, msbFirst: boolean): Signal {
    // Sort signals by bit position
    const sortedSignals = [...signals].sort((a, b) => {
      if (msbFirst) {
        return b.msb - a.msb;
      } else {
        return a.lsb - b.lsb;
      }
    });

    const totalBits = sortedSignals.reduce((sum, s) => sum + s.bitWidth, 0);

    // Create virtual bus signal
    const busSignal: Signal = {
      handle: -1, // Virtual signal
      name,
      fullPath: sortedSignals[0]?.fullPath.split('.').slice(0, -1).join('.') + '.' + name,
      bitWidth: totalBits,
      msb: totalBits - 1,
      lsb: 0,
      type: sortedSignals[0]?.type || 0,
      direction: sortedSignals[0]?.direction || 3,
      filePath: sortedSignals[0]?.filePath || '',
      lineNumber: sortedSignals[0]?.lineNumber || 0,
      column: 0,
    };

    return busSignal;
  }

  expandBus(busSignal: Signal): Signal[] {
    // Find component signals
    const basePath = busSignal.fullPath.substring(0, busSignal.fullPath.lastIndexOf('.'));
    const signals = this.findSignals({
      namePattern: `^${basePath}\\.`,
    });

    // Sort by bit position
    return signals.sort((a, b) => b.msb - a.msb);
  }

  getBusBits(busSignal: Signal): Signal[] {
    return this.expandBus(busSignal);
  }
}

// Singleton instance
export const knowledgeManager = new KnowledgeManagerImpl();
export { KnowledgeManagerImpl };
