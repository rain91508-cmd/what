// ============================================
// Search Service - Main thread search with async/batching
// ============================================

import { kdbManager } from '../knowledge/kdbManager';
import { wildcardMatch } from '../../utils/wildcardMatch';
import type { SearchResultItem } from '../../types/search';

export interface SearchOptions {
  pattern: string;
  isSignalSearch: boolean;
  startModuleIndex: number;
  maxResults?: number;
  onProgress?: (current: number, total: number) => void;
  shouldCancel?: () => boolean;
}

/**
 * Perform hierarchy search with async batching to keep UI responsive
 */
export async function performHierarchySearch(
  options: SearchOptions
): Promise<SearchResultItem[]> {
  const {
    pattern,
    isSignalSearch,
    startModuleIndex,
    maxResults = 100,
    onProgress,
    shouldCancel,
  } = options;

  console.log(`[SearchService] Starting search: pattern="${pattern}", isSignalSearch=${isSignalSearch}, startModuleIndex=${startModuleIndex}`);

  const results: SearchResultItem[] = [];

  // DFS stack: { moduleIndex, fullName }
  const stack: Array<{ moduleIndex: number; fullName: string }> = [];
  const visited = new Set<number>();

  // Get start module info
  const startModule = kdbManager.getModuleById(startModuleIndex);
  console.log(`[SearchService] Start module:`, startModule ? { id: startModuleIndex, name: startModule.name, isInstance: startModule.isInstance } : 'NOT FOUND');

  if (!startModule) {
    console.error(`[SearchService] Start module ${startModuleIndex} not found`);
    return results;
  }

  stack.push({ moduleIndex: startModuleIndex, fullName: startModule.name });

  // Process in batches to keep UI responsive
  let processedCount = 0;
  let totalModulesChecked = 0;

  while (stack.length > 0 && results.length < maxResults) {
    // Check cancellation
    if (shouldCancel?.()) {
      console.log('[SearchService] Search cancelled');
      break;
    }

    // Process a batch
    const batchStartTime = Date.now();
    const batchMaxTime = 16; // 16ms = 1 frame at 60fps

    while (stack.length > 0 && results.length < maxResults) {
      // Check if we've spent too much time in this batch
      if (Date.now() - batchStartTime > batchMaxTime) {
        // Yield to UI
        await new Promise(resolve => setTimeout(resolve, 0));
        break;
      }

      const { moduleIndex, fullName } = stack.pop()!;

      if (visited.has(moduleIndex)) {
        continue;
      }
      visited.add(moduleIndex);
      processedCount++;
      totalModulesChecked++;

      // Get module info
      const moduleInfo = kdbManager.getModuleById(moduleIndex);
      if (!moduleInfo) {
        console.warn(`[SearchService] Module ${moduleIndex} not found`);
        continue;
      }

      // Debug: log every 50 modules
      if (totalModulesChecked % 50 === 0) {
        console.log(`[SearchService] Checked ${totalModulesChecked} modules, found ${results.length} results, stack size: ${stack.length}`);
      }

      // If searching signals, check signals in this module
      if (isSignalSearch) {
        try {
          const signals = await kdbManager.getModuleSignals(moduleIndex);
          console.log(`[SearchService] Module ${fullName} (${moduleIndex}) has ${signals.length} signals`);

          for (const signal of signals) {
            if (shouldCancel?.()) break;

            const signalFullName = `${fullName}.${signal.name}`;
            const isMatch = wildcardMatch(pattern, signalFullName);

            if (isMatch) {
              console.log(`[SearchService] MATCH: ${signalFullName}`);
              results.push({
                globalId: signal.globalId,
                fullName: signalFullName,
                type: 'signal',
                parentModuleIndex: moduleIndex,
                lineNumber: signal.declaration?.line,
              });

              if (results.length >= maxResults) {
                console.log(`[SearchService] Reached max results (${maxResults})`);
                break;
              }
            }
          }
        } catch (error) {
          console.error(`[SearchService] Error getting signals for module ${moduleIndex}:`, error);
        }
      }

      // Get child instances
      console.log(`[SearchService] Module ${fullName} (${moduleIndex}) childModuleIds:`, moduleInfo.childModuleIds);
      const allChildren = moduleInfo.childModuleIds
        .map(id => {
          const m = kdbManager.getModuleById(id);
          console.log(`[SearchService]   Child ${id}:`, m ? { id: id, name: m.name, isInstance: m.isInstance } : 'NOT FOUND');
          return m;
        });
      const childModules = allChildren.filter(m => m && m.isInstance) as Array<NonNullable<ReturnType<typeof kdbManager.getModuleById>>>;
      console.log(`[SearchService] Module ${fullName} has ${childModules.length} instance children (filtered from ${allChildren.length})`);

      // Check this module for match (not just leaf nodes)
      if (!isSignalSearch) {
        console.log(`[SearchService] Checking module: ${fullName}`);
        const isMatch = wildcardMatch(pattern, fullName);
        console.log(`[SearchService] wildcardMatch("${pattern}", "${fullName}") = ${isMatch}`);
        if (isMatch) {
          console.log(`[SearchService] MATCH (module): ${fullName}`);
          // Get module definition info for navigation
          const definition = moduleInfo.definition;
          results.push({
            globalId: moduleIndex,
            fullName: fullName,
            type: 'module',
            parentModuleIndex: moduleInfo.parentModuleId,
            lineNumber: definition?.startLine,
          });

          if (results.length >= maxResults) {
            break;
          }
        }
      }

      // Add children to stack
      for (const child of childModules) {
        if (shouldCancel?.()) break;

        const childFullName = `${fullName}.${child.name}`;
        // Find child module index from childModuleIds
        const childIndex = moduleInfo.childModuleIds.findIndex(id => {
          const m = kdbManager.getModuleById(id);
          return m === child;
        });
        if (childIndex >= 0) {
          stack.push({
            moduleIndex: moduleInfo.childModuleIds[childIndex],
            fullName: childFullName,
          });
        }
      }

      // Report progress periodically
      if (processedCount % 10 === 0) {
        onProgress?.(results.length, maxResults);
      }
    }
  }

  console.log(`[SearchService] Search complete: checked ${totalModulesChecked} modules, found ${results.length} results`);
  return results;
}

// Cancel token for search
export class CancelToken {
  private _cancelled = false;

  get isCancelled(): boolean {
    return this._cancelled;
  }

  cancel(): void {
    this._cancelled = true;
  }

  reset(): void {
    this._cancelled = false;
  }
}
