import { useState, useEffect, useCallback } from 'react';
import { kdbManager, type TreeNode } from '../modules/knowledge/kdbManager';
import type { SourceFileInfo } from '../types/kdb';

interface DesignBrowserProps {
  onModuleSelect: (moduleIndex: number) => void;
  onModuleDoubleClick?: (moduleIndex: number) => void;
  onFileDoubleClick?: (fileId: number) => void;
  selectedModuleIndex: number | null;
  kdbLoaded: boolean;
  // Controlled expanded modules state
  expandedModules?: Set<number>;
  onExpandedModulesChange?: (expanded: Set<number>) => void;
}

interface TreeNodeState extends TreeNode {
  childrenLoaded: boolean;
  loading: boolean;
}

type TabType = 'hierarchy' | 'files';

// Pagination state for each node - stores start position (1-based) instead of page
interface PaginationState {
  startPosition: number;  // 1-based starting position
  pageSize: number;
}

const DEFAULT_PAGE_SIZE = 20;

export function DesignBrowser({ 
  onModuleSelect, 
  onModuleDoubleClick, 
  onFileDoubleClick,
  selectedModuleIndex,
  kdbLoaded,
  expandedModules: controlledExpanded,
  onExpandedModulesChange
}: DesignBrowserProps) {
  const [activeTab, setActiveTab] = useState<TabType>('hierarchy');
  // Use controlled expanded modules if provided, otherwise use internal state
  const isControlled = controlledExpanded !== undefined;
  const [internalExpandedNodes, setInternalExpandedNodes] = useState<Set<number>>(new Set());
  const expandedNodes = isControlled ? controlledExpanded : internalExpandedNodes;
  const setExpandedNodes = useCallback((updater: Set<number> | ((prev: Set<number>) => Set<number>)) => {
    if (isControlled) {
      // In controlled mode, notify parent
      const newExpanded = typeof updater === 'function' ? updater(controlledExpanded!) : updater;
      onExpandedModulesChange?.(newExpanded);
    } else {
      // In uncontrolled mode, update internal state
      setInternalExpandedNodes(updater as Set<number>);
    }
  }, [isControlled, controlledExpanded, onExpandedModulesChange]);
  const [treeNodes, setTreeNodes] = useState<Map<number, TreeNodeState>>(new Map());
  const [rootNodes, setRootNodes] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Pagination state: nodeId -> PaginationState
  const [paginationMap, setPaginationMap] = useState<Map<number, PaginationState>>(new Map());
  // Editing page size: nodeId -> temp value
  const [editingPageSize, setEditingPageSize] = useState<Map<number, string>>(new Map());
  
  // Files tab state
  const [files, setFiles] = useState<SourceFileInfo[]>([]);
  const [fileFilter, setFileFilter] = useState('');
  const [filesLoading, setFilesLoading] = useState(false);

  // Load top-level modules on mount or when kdbLoaded changes
  useEffect(() => {
    loadTopLevelModules();
    loadFiles();
  }, [kdbLoaded]);

  const loadTopLevelModules = async () => {
    try {
      setLoading(true);
      setError(null);

      if (!kdbManager.isLoaded()) {
        setLoading(false);
        return;
      }

      const topModules = await kdbManager.getTopLevelModules();
      
      const nodesMap = new Map<number, TreeNodeState>();
      const rootIds: number[] = [];

      for (const module of topModules) {
        nodesMap.set(module.id, {
          ...module,
          childrenLoaded: false,
          loading: false,
        });
        rootIds.push(module.id);
      }

      setTreeNodes(nodesMap);
      setRootNodes(rootIds);
      setLoading(false);

      // Auto-expand first root node if exists and not in controlled mode with existing expanded nodes
      if (rootIds.length > 0 && (!isControlled || expandedNodes.size === 0)) {
        setExpandedNodes(new Set([rootIds[0]]));
        // Load children for first node
        await loadChildren(rootIds[0], nodesMap);
      } else if (isControlled && expandedNodes.size > 0) {
        // In controlled mode with existing expanded nodes, load children for all expanded nodes recursively
        const loadExpandedNodesRecursively = async (nodeIds: number[], currentMap: Map<number, TreeNodeState>) => {
          for (const nodeId of nodeIds) {
            const node = currentMap.get(nodeId);
            if (node && !node.childrenLoaded) {
              await loadChildren(nodeId, currentMap);
              // After loading children, check if any children are also expanded
              const updatedMap = treeNodes; // Get updated map after loadChildren
              const childNodes = Array.from(updatedMap.values()).filter(n => n.parentId === nodeId);
              const expandedChildIds = childNodes.filter(n => expandedNodes.has(n.id)).map(n => n.id);
              if (expandedChildIds.length > 0) {
                await loadExpandedNodesRecursively(expandedChildIds, updatedMap);
              }
            }
          }
        };
        
        // Start with root-level expanded nodes
        const rootExpandedIds = rootIds.filter(id => expandedNodes.has(id));
        await loadExpandedNodesRecursively(rootExpandedIds, nodesMap);
      }
    } catch (err) {
      console.error('[DesignBrowser] Failed to load top-level modules:', err);
      setError('Failed to load design hierarchy');
      setLoading(false);
    }
  };

  const loadFiles = async () => {
    try {
      setFilesLoading(true);
      if (!kdbManager.isLoaded()) {
        setFiles([]);
        setFilesLoading(false);
        return;
      }

      const allFiles = await kdbManager.getAllSourceFileInfo();
      setFiles(allFiles);
      setFilesLoading(false);
    } catch (err) {
      console.error('[DesignBrowser] Failed to load files:', err);
      setFiles([]);
      setFilesLoading(false);
    }
  };

  const loadChildren = async (
    parentId: number, 
    currentMap: Map<number, TreeNodeState>
  ): Promise<void> => {
    const parentNode = currentMap.get(parentId);
    if (!parentNode || parentNode.childrenLoaded || parentNode.loading) {
      return;
    }

    // Mark as loading
    currentMap.set(parentId, { ...parentNode, loading: true });
    setTreeNodes(new Map(currentMap));

    try {
      const children = await kdbManager.getChildModules(parentId);
      const newMap = new Map(currentMap);

      // Mark parent as loaded
      newMap.set(parentId, { ...parentNode, childrenLoaded: true, loading: false });

      // Add children to map
      for (const child of children) {
        if (!newMap.has(child.id)) {
          newMap.set(child.id, {
            ...child,
            childrenLoaded: false,
            loading: false,
          });
        }
      }

      setTreeNodes(newMap);
    } catch (err) {
      console.error(`[DesignBrowser] Failed to load children for ${parentId}:`, err);
      // Mark as not loading but not loaded
      const newMap = new Map(currentMap);
      newMap.set(parentId, { ...parentNode, loading: false, childrenLoaded: false });
      setTreeNodes(newMap);
    }
  };

  const toggleNode = useCallback(async (nodeId: number) => {
    const newExpanded = new Set(expandedNodes);
    
    if (newExpanded.has(nodeId)) {
      // Collapse
      newExpanded.delete(nodeId);
    } else {
      // Expand - load children if needed
      newExpanded.add(nodeId);
      const node = treeNodes.get(nodeId);
      if (node && node.hasChildren && !node.childrenLoaded) {
        await loadChildren(nodeId, treeNodes);
      }
    }
    
    setExpandedNodes(newExpanded);
  }, [expandedNodes, treeNodes]);

  const handleNodeClick = async (nodeId: number) => {
    const node = treeNodes.get(nodeId);
    if (!node) return;
    onModuleSelect(nodeId);
  };

  const handleNodeDoubleClick = async (nodeId: number) => {
    if (!onModuleDoubleClick) return;
    onModuleDoubleClick(nodeId);
  };

  const handleFileDoubleClick = (file: SourceFileInfo) => {
    // Open file directly from first line (not from module's start line)
    if (onFileDoubleClick) {
      onFileDoubleClick(file.id);
    }
  };

  // Simple wildcard matching (* matches any characters)
  const matchWildcard = (pattern: string, text: string): boolean => {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$', 'i');
    return regex.test(text);
  };

  const filteredFiles = files.filter(file => {
    if (!fileFilter) return true;
    return matchWildcard(fileFilter, file.path);
  });

  const getChildIds = (parentId: number): number[] => {
    const parent = treeNodes.get(parentId);
    if (!parent) {
      return [];
    }
    const childIds = parent.childModuleIds || [];
    return childIds;
  };

  // Get paginated child IDs for a node
  const getPaginatedChildIds = (parentId: number): { visibleIds: number[]; total: number; startPosition: number; pageSize: number; hasMore: boolean } => {
    const allChildIds = getChildIds(parentId);
    const pagination = paginationMap.get(parentId) || { startPosition: 1, pageSize: DEFAULT_PAGE_SIZE };
    const total = allChildIds.length;
    
    // Ensure start position is valid (1-based)
    const validStartPosition = Math.min(Math.max(1, pagination.startPosition), Math.max(1, total));
    const startIndex = validStartPosition - 1; // Convert to 0-based
    
    // Calculate end index based on pageSize
    const endIndex = Math.min(startIndex + pagination.pageSize, total);
    const visibleIds = allChildIds.slice(startIndex, endIndex);
    
    // Check if there are more items after this page
    const hasMore = endIndex < total;
    
    return { visibleIds, total, startPosition: validStartPosition, pageSize: pagination.pageSize, hasMore };
  };

  // Update pagination for a node
  const setPagination = (nodeId: number, updates: Partial<PaginationState>) => {
    setPaginationMap(prev => {
      const newMap = new Map(prev);
      const current = newMap.get(nodeId) || { startPosition: 1, pageSize: DEFAULT_PAGE_SIZE };
      newMap.set(nodeId, { ...current, ...updates });
      return newMap;
    });
  };

  // Navigate to previous page (move back by pageSize)
  const goToPreviousPage = (nodeId: number) => {
    const pagination = paginationMap.get(nodeId) || { startPosition: 1, pageSize: DEFAULT_PAGE_SIZE };
    if (pagination.startPosition > 1) {
      const newStart = Math.max(1, pagination.startPosition - pagination.pageSize);
      setPagination(nodeId, { startPosition: newStart });
    }
  };

  // Navigate to next page (move forward by pageSize)
  const goToNextPage = (nodeId: number) => {
    const allChildIds = getChildIds(nodeId);
    const pagination = paginationMap.get(nodeId) || { startPosition: 1, pageSize: DEFAULT_PAGE_SIZE };
    const maxStart = Math.max(1, allChildIds.length - pagination.pageSize + 1);
    if (pagination.startPosition < maxStart) {
      const newStart = Math.min(maxStart, pagination.startPosition + pagination.pageSize);
      setPagination(nodeId, { startPosition: newStart });
    }
  };

  const renderTreeNodeWithChildren = (nodeId: number, depth: number = 0, isLast: boolean = true, parentChain: boolean[] = []) => {
    const node = treeNodes.get(nodeId);
    if (!node) return null;

    const isExpanded = expandedNodes.has(nodeId);
    const isSelected = selectedModuleIndex === nodeId;
    const hasChildren = node.hasChildren;
    const isLoading = node.loading;

    const indentWidth = 16;
    const lineHeight = 24;
    const lineLeft = 7;

    return (
      <div key={nodeId}>
        <div
          className={`tree-node ${isSelected ? 'selected' : ''}`}
          style={{ 
            display: 'flex',
            alignItems: 'center',
            height: `${lineHeight}px`,
            cursor: 'pointer',
            backgroundColor: isSelected ? '#e3f2fd' : 'transparent',
          }}
          onClick={() => handleNodeClick(nodeId)}
          onDoubleClick={() => handleNodeDoubleClick(nodeId)}
        >
          <div style={{ display: 'flex', alignItems: 'stretch', height: '100%' }}>
            {parentChain.map((parentIsLast, index) => (
              <div
                key={index}
                style={{
                  width: `${indentWidth}px`,
                  height: '100%',
                  position: 'relative',
                }}
              >
                {!parentIsLast && (
                  <div style={{ 
                    position: 'absolute',
                    left: `${lineLeft}px`,
                    top: 0,
                    bottom: 0,
                    width: '1px',
                    borderLeft: '1px dashed #999',
                  }} />
                )}
              </div>
            ))}
            
            <div style={{ 
              width: `${indentWidth}px`,
              height: '100%',
              position: 'relative',
            }}>
              {depth > 0 && (
                <>
                  <div style={{
                    position: 'absolute',
                    left: `${lineLeft}px`,
                    top: 0,
                    height: isLast ? '50%' : '100%',
                    width: '1px',
                    borderLeft: '1px dashed #999',
                  }} />
                  <div style={{
                    position: 'absolute',
                    left: `${lineLeft}px`,
                    top: '50%',
                    width: `${indentWidth - lineLeft}px`,
                    height: '1px',
                    borderTop: '1px dashed #999',
                  }} />
                </>
              )}
            </div>
          </div>

          <span
            className="tree-node-expand"
            onClick={(e) => {
              e.stopPropagation();
              toggleNode(nodeId);
            }}
            style={{
              width: '16px',
              height: '16px',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: hasChildren ? 'pointer' : 'default',
              marginRight: '4px',
              fontSize: '10px',
              color: hasChildren ? '#666' : 'transparent',
              flexShrink: 0,
            }}
          >
            {isLoading ? '⏳' : hasChildren ? (isExpanded ? '▼' : '▶') : ''}
          </span>

          <span 
            title={node.fullName}
            style={{
              fontSize: '12px',
              color: '#333',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              paddingRight: '8px',
            }}
          >
            {node.name}
          </span>
        </div>

        {hasChildren && isExpanded && (
          <div>
            {isLoading ? (
              <div style={{ paddingLeft: `${(depth + 1) * indentWidth + 20}px`, padding: '4px 8px', fontSize: '11px', color: '#999' }}>
                Loading...
              </div>
            ) : (
              (() => {
                const { visibleIds, total, startPosition, hasMore } = getPaginatedChildIds(nodeId);
                const needsPagination = total > DEFAULT_PAGE_SIZE;
                // Calculate display range based on startPosition
                const startIdx = startPosition;
                const endIdx = Math.min(startPosition + visibleIds.length - 1, total);
                
                return (
                  <>
                    {/* Pagination controls */}
                    {needsPagination && (
                      <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        padding: '4px 8px',
                        paddingLeft: `${(depth + 1) * indentWidth + 8}px`,
                        fontSize: '11px',
                        color: '#666',
                        backgroundColor: '#f5f5f5',
                        borderBottom: '1px solid #e0e0e0',
                      }}>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            goToPreviousPage(nodeId);
                          }}
                          disabled={startPosition <= 1}
                          style={{
                            padding: '2px 6px',
                            marginRight: '4px',
                            border: '1px solid #ccc',
                            borderRadius: '2px',
                            background: '#fff',
                            cursor: startPosition <= 1 ? 'not-allowed' : 'pointer',
                            opacity: startPosition <= 1 ? 0.5 : 1,
                            fontSize: '10px',
                          }}
                        >
                          ◀
                        </button>
                        
                        <span style={{ margin: '0 8px' }}>
                          {editingPageSize.has(nodeId) ? (
                            <input
                              type="number"
                              value={editingPageSize.get(nodeId)}
                              onChange={(e) => {
                                setEditingPageSize(prev => new Map(prev).set(nodeId, e.target.value));
                              }}
                              onBlur={() => {
                                const value = parseInt(editingPageSize.get(nodeId) || '', 10);
                                if (!isNaN(value) && value >= 1 && value <= total) {
                                  // Jump directly to the specified start position
                                  setPagination(nodeId, { startPosition: value });
                                }
                                setEditingPageSize(prev => {
                                  const newMap = new Map(prev);
                                  newMap.delete(nodeId);
                                  return newMap;
                                });
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.currentTarget.blur();
                                }
                              }}
                              onClick={(e) => e.stopPropagation()}
                              autoFocus
                              min={1}
                              max={total}
                              style={{
                                width: '50px',
                                padding: '1px 4px',
                                fontSize: '11px',
                                border: '1px solid #1976d2',
                                borderRadius: '2px',
                                textAlign: 'center',
                              }}
                            />
                          ) : (
                            <span
                              onDoubleClick={(e) => {
                                e.stopPropagation();
                                // Show input with current start position
                                setEditingPageSize(prev => new Map(prev).set(nodeId, String(startIdx)));
                              }}
                              style={{
                                cursor: 'pointer',
                                textDecoration: 'underline',
                                color: '#1976d2',
                              }}
                              title="Double-click to jump to position"
                            >
                              {startIdx}-{endIdx} / {total}
                            </span>
                          )}
                        </span>
                        
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            goToNextPage(nodeId);
                          }}
                          disabled={!hasMore}
                          style={{
                            padding: '2px 6px',
                            marginLeft: '4px',
                            border: '1px solid #ccc',
                            borderRadius: '2px',
                            background: '#fff',
                            cursor: !hasMore ? 'not-allowed' : 'pointer',
                            opacity: !hasMore ? 0.5 : 1,
                            fontSize: '10px',
                          }}
                        >
                          ▶
                        </button>
                      </div>
                    )}
                    
                    {/* Child nodes - lazy loaded, only visible ones */}
                    {visibleIds.map((childId, index) => {
                      // The last visible item in current page should use L-shape (isLast=true)
                      // regardless of whether there are more items in total
                      const childIsLast = index === visibleIds.length - 1;
                      return renderTreeNodeWithChildren(
                        childId, 
                        depth + 1, 
                        childIsLast,
                        [...parentChain, isLast]
                      );
                    })}
                  </>
                );
              })()
            )}
          </div>
        )}
      </div>
    );
  };

  const renderHierarchyTab = () => {
    if (loading) {
      return (
        <div style={{ padding: '20px', textAlign: 'center', color: '#999', flex: 1 }}>
          Loading...
        </div>
      );
    }

    if (error) {
      return (
        <div style={{ padding: '20px', textAlign: 'center', color: '#d32f2f', flex: 1, fontSize: '12px' }}>
          {error}
        </div>
      );
    }

    if (rootNodes.length === 0) {
      return (
        <div style={{ padding: '20px', textAlign: 'center', color: '#999', flex: 1, fontSize: '11px' }}>
          {kdbManager.isLoaded() 
            ? 'No design hierarchy available' 
            : 'Connect to server to load design'}
        </div>
      );
    }

    return (
      <div className="tree-view" style={{ flex: 1, overflow: 'auto', padding: '4px' }}>
        {rootNodes.map(nodeId => renderTreeNodeWithChildren(nodeId))}
      </div>
    );
  };

  const renderFilesTab = () => {
    if (filesLoading) {
      return (
        <div style={{ padding: '20px', textAlign: 'center', color: '#999', flex: 1 }}>
          Loading files...
        </div>
      );
    }

    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Filter input */}
        <div style={{ padding: '8px', borderBottom: '1px solid #e0e0e0' }}>
          <input
            type="text"
            placeholder="Filter files (* wildcard)"
            value={fileFilter}
            onChange={(e) => setFileFilter(e.target.value)}
            style={{
              width: '100%',
              padding: '4px 8px',
              fontSize: '12px',
              border: '1px solid #ccc',
              borderRadius: '4px',
              boxSizing: 'border-box',
            }}
          />
          <div style={{ fontSize: '10px', color: '#999', marginTop: '4px' }}>
            {filteredFiles.length} of {files.length} files
          </div>
        </div>

        {/* File list */}
        <div style={{ flex: 1, overflow: 'auto' }}>
          {filteredFiles.map((file) => (
            <div
              key={file.id}
              onDoubleClick={() => handleFileDoubleClick(file)}
              style={{
                padding: '6px 12px',
                fontSize: '12px',
                cursor: 'pointer',
                borderBottom: '1px solid #f0f0f0',
                display: 'flex',
                alignItems: 'center',
                userSelect: 'none',  // Prevent text selection on double click
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = '#f5f5f5';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'transparent';
              }}
            >
              <span style={{ marginRight: '6px', fontSize: '12px' }}>📄</span>
              <span 
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={file.path}
              >
                {file.path.split('/').pop() || file.path}
              </span>
            </div>
          ))}
          {filteredFiles.length === 0 && (
            <div style={{ padding: '20px', textAlign: 'center', color: '#999', fontSize: '11px' }}>
              No files match the filter
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="design-browser-panel" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Tab headers - DVE style matching main tabs */}
      <div style={{ 
        display: 'flex', 
        background: 'linear-gradient(to bottom, #e8e8e8, #d0d0d0)',
        borderBottom: '1px solid #a0a0a0',
        padding: '2px 4px 0 4px',
        gap: '2px',
      }}>
        <button
          onClick={() => setActiveTab('hierarchy')}
          style={{
            flex: 1,
            padding: '4px 12px',
            background: activeTab === 'hierarchy' 
              ? '#fff' 
              : 'linear-gradient(to bottom, #f0f0f0, #e0e0e0)',
            border: '1px solid #a0a0a0',
            borderBottom: activeTab === 'hierarchy' ? '1px solid #fff' : '1px solid #a0a0a0',
            borderRadius: '3px 3px 0 0',
            fontWeight: activeTab === 'hierarchy' ? 'bold' : '500',
            fontSize: '11px',
            cursor: 'pointer',
            color: activeTab === 'hierarchy' ? '#333' : '#666',
            marginBottom: activeTab === 'hierarchy' ? '-1px' : '0',
          }}
        >
          Hierarchy
        </button>
        <button
          onClick={() => setActiveTab('files')}
          style={{
            flex: 1,
            padding: '4px 12px',
            background: activeTab === 'files' 
              ? '#fff' 
              : 'linear-gradient(to bottom, #f0f0f0, #e0e0e0)',
            border: '1px solid #a0a0a0',
            borderBottom: activeTab === 'files' ? '1px solid #fff' : '1px solid #a0a0a0',
            borderRadius: '3px 3px 0 0',
            fontWeight: activeTab === 'files' ? 'bold' : '500',
            fontSize: '11px',
            cursor: 'pointer',
            color: activeTab === 'files' ? '#333' : '#666',
            marginBottom: activeTab === 'files' ? '-1px' : '0',
          }}
        >
          Files
        </button>
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {activeTab === 'hierarchy' ? renderHierarchyTab() : renderFilesTab()}
      </div>
    </div>
  );
}
