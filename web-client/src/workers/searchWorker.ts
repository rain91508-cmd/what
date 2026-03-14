// ============================================
// Search Worker - Background search in worker thread
// ============================================

import type { SearchResultItem, SearchWorkerRequest, SearchWorkerResponse, StartSearchPayload } from '../types/search';
import { kdbManager } from '../modules/knowledge/kdbManager';
import { wildcardMatch } from '../utils/wildcardMatch';

// Worker context
const ctx = self as unknown as Worker;

// Search state
let isSearching = false;
let shouldCancel = false;

// ============================================
// Search Algorithm
// ============================================

async function performHierarchySearch(
  payload: StartSearchPayload
): Promise<SearchResultItem[]> {
  const { pattern, isSignalSearch, startModuleIndex, kdbFileId } = payload;
  const results: SearchResultItem[] = [];
  const maxResults = 100;

  isSearching = true;
  shouldCancel = false;

  try {
    // Get module info for start module
    const startModule = await kdbManager.getModule(startModuleIndex, kdbFileId);
    if (!startModule) {
      return results;
    }

    // DFS stack: { moduleIndex, moduleName, depth }
    const stack: Array<{ moduleIndex: number; fullName: string }> = [
      { moduleIndex: startModuleIndex, fullName: startModule.name }
    ];

    const visited = new Set<number>();

    while (stack.length > 0 && results.length < maxResults && !shouldCancel) {
      const { moduleIndex, fullName } = stack.pop()!;

      if (visited.has(moduleIndex)) {
        continue;
      }
      visited.add(moduleIndex);

      // Get module details
      const moduleInfo = await kdbManager.getModule(moduleIndex, kdbFileId);
      if (!moduleInfo) {
        continue;
      }

      // Check if searching signals
      if (isSignalSearch) {
        // Get signals in this module
        const signals = await kdbManager.getModuleSignals(moduleIndex, kdbFileId);

        for (const signal of signals) {
          if (shouldCancel) break;

          const signalFullName = `${fullName}.${signal.name}`;

          // Check pattern match
          if (wildcardMatch(signalFullName, pattern)) {
            results.push({
              globalId: signal.globalId,
              fullName: signalFullName,
              type: 'signal',
              parentModuleIndex: moduleIndex,
              lineNumber: signal.line,
            });

            if (results.length >= maxResults) {
              break;
            }
          }
        }
      }

      // Get child instances
      const instances = await kdbManager.getModuleInstances(moduleIndex, kdbFileId);

      // If no children and not searching signals, check this module
      if (instances.length === 0 && !isSignalSearch) {
        if (wildcardMatch(fullName, pattern)) {
          results.push({
            globalId: moduleIndex,
            fullName: fullName,
            type: 'module',
          });
        }
      }

      // Add children to stack for DFS
      for (const instance of instances) {
        if (shouldCancel) break;

        const childFullName = `${fullName}.${instance.name}`;

        // If not searching signals, check intermediate modules too
        if (!isSignalSearch) {
          if (wildcardMatch(childFullName, pattern)) {
            results.push({
              globalId: instance.moduleIndex,
              fullName: childFullName,
              type: 'module',
            });

            if (results.length >= maxResults) {
              break;
            }
          }
        }

        stack.push({
          moduleIndex: instance.moduleIndex,
          fullName: childFullName,
        });
      }

      // Report progress periodically
      if (results.length % 10 === 0) {
        sendProgress(results.length, maxResults);
      }
    }

    return results;
  } finally {
    isSearching = false;
  }
}

// ============================================
// Helper Functions
// ============================================

function sendProgress(current: number, total: number): void {
  const response: SearchWorkerResponse = {
    type: 'SEARCH_PROGRESS',
    payload: { current, total },
  };
  ctx.postMessage(response);
}

function sendComplete(results: SearchResultItem[]): void {
  const response: SearchWorkerResponse = {
    type: 'SEARCH_COMPLETE',
    payload: results,
  };
  ctx.postMessage(response);
}

function sendCancelled(): void {
  const response: SearchWorkerResponse = {
    type: 'SEARCH_CANCELLED',
  };
  ctx.postMessage(response);
}

function sendError(error: string): void {
  const response: SearchWorkerResponse = {
    type: 'SEARCH_ERROR',
    payload: error,
  };
  ctx.postMessage(response);
}

// ============================================
// Message Handler
// ============================================

ctx.addEventListener('message', async (event: MessageEvent<SearchWorkerRequest>) => {
  const { type } = event.data;

  switch (type) {
    case 'START_SEARCH':
      if (isSearching) {
        sendError('Search already in progress');
        return;
      }

      try {
        const results = await performHierarchySearch(event.data.payload);

        if (shouldCancel) {
          sendCancelled();
        } else {
          sendComplete(results);
        }
      } catch (error) {
        sendError(error instanceof Error ? error.message : 'Unknown error');
      }
      break;

    case 'CANCEL_SEARCH':
      if (isSearching) {
        shouldCancel = true;
      }
      break;

    default:
      sendError(`Unknown message type: ${type}`);
  }
});

export {};
