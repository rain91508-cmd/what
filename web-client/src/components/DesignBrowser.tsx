import { useState, useEffect, useCallback } from 'react';
import { kdbManager, type TreeNode } from '../modules/knowledge/kdbManager';
import type { SourceFile } from '../types/kdb';

interface DesignBrowserProps {
  onModuleSelect: (moduleIndex: number) => void;
  onModuleDoubleClick?: (moduleIndex: number) => void;
  onFileDoubleClick?: (fileId: number) => void;
  selectedModuleIndex: number | null;
  kdbLoaded: boolean;
}

interface TreeNodeState extends TreeNode {
  childrenLoaded: boolean;
  loading: boolean;
}

type TabType = 'hierarchy' | 'files';

// Pagination state for each node
interface PaginationState {
  currentPage: number;
  pageSize: number;
}

const DEFAULT_PAGE_SIZE = 20;

export function DesignBrowser({ 
  onModuleSelect, 
  onModuleDoubleClick, 
  onFileDoubleClick,
  selectedModuleIndex,
  kdbLoaded 
}: DesignBrowserProps) {
  const [activeTab, setActiveTab] = useState<TabType>('hierarchy');
  const [expandedNodes, setExpandedNodes] = useState<Set<number>>(new Set());
  const [treeNodes, setTreeNodes] = useState<Map<number, TreeNodeState>>(new Map());
  const [rootNodes, setRootNodes] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Pagination state: nodeId -> PaginationState
  const [paginationMap, setPaginationMap] = useState<Map<number, PaginationState>>(new Map());
  // Editing page size: nodeId -> temp value
  const [editingPageSize, setEditingPageSize] = useState<Map<number, string>>(new Map());
  
  // Files tab state
  const [files, setFiles] = useState<SourceFile[]>([]);
  const [fileFilter, setFileFilter] = useState('');
  const [filesLoading, setFilesLoading] = useState(false);

  // Load top-level modules on mount or when kdbLoaded changes
  useEffect(() => {
    loadTopLevelModules();
    loadFiles();
  }, [kdbLoaded]);

  const loadTopLevelModules = async () => {
    console.log('[DesignBrowser] loadTopLevelModules called, kdbLoaded:', kdbLoaded);
    try {
      setLoading(true);
      setError(null);

      if (!kdbManager.isLoaded()) {
        console.log('[DesignBrowser] kdbManager not loaded, skipping');
        setLoading(false);
        return;
      }

      console.log('[DesignBrowser] Fetching top-level modules...');
      const topModules = await kdbManager.getTopLevelModules();
      console.log('[DesignBrowser] Got top-level modules:', topModules.length, topModules);
      
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

      console.log('[DesignBrowser] Setting treeNodes:', nodesMap.size, 'rootNodes:', rootIds.length);
      setTreeNodes(nodesMap);
      setRootNodes(rootIds);
      setLoading(false);

      // Auto-expand first root node if exists
      if (rootIds.length > 0) {
        console.log('[DesignBrowser] Auto-expanding first root node:', rootIds[0]);
        setExpandedNodes(new Set([rootIds[0]]));
        // Load children for first node
        await loadChildren(rootIds[0], nodesMap);
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

      const allFiles = await kdbManager.getAllSourceFiles();
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
    console.log('[DesignBrowser] handleNodeDoubleClick called, nodeId:', nodeId, 'onModuleDoubleClick:', !!onModuleDoubleClick);
    if (!onModuleDoubleClick) return;
    onModuleDoubleClick(nodeId);
  };

  const handleFileDoubleClick = (file: SourceFile) => {
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
      console.log(`[DesignBrowser] getChildIds: parent ${parentId} not found in treeNodes`);
      return [];
    }
    const childIds = parent.childModuleIds || [];
    console.log(`[DesignBrowser] getChildIds for ${parentId}:`, childIds, 'parent:', parent);
    return childIds;
  };

  // Get paginated child IDs for a node
  const getPaginatedChildIds = (parentId: number): { visibleIds: number[]; total: number; currentPage: number; pageSize: number; totalPages: number } => {
    const allChildIds = getChildIds(parentId);
    const pagination = paginationMap.get(parentId) || { currentPage: 1, pageSize: DEFAULT_PAGE_SIZE };
    const total = allChildIds.length;
    const totalPages = Math.ceil(total / pagination.pageSize);
    
    // Ensure current page is valid
    const validPage = Math.min(Math.max(1, pagination.currentPage), Math.max(1, totalPages));
    
    const startIndex = (validPage - 1) * pagination.pageSize;
    const endIndex = Math.min(startIndex + pagination.pageSize, total);
    const visibleIds = allChildIds.slice(startIndex, endIndex);
    
    return { visibleIds, total, currentPage: validPage, pageSize: pagination.pageSize, totalPages };
  };

  // Update pagination for a node
  const setPagination = (nodeId: number, updates: Partial<PaginationState>) => {
    setPaginationMap(prev => {
      const newMap = new Map(prev);
      const current = newMap.get(nodeId) || { currentPage: 1, pageSize: DEFAULT_PAGE_SIZE };
      newMap.set(nodeId, { ...current, ...updates });
      return newMap;
    });
  };

  // Navigate to previous page
  const goToPreviousPage = (nodeId: number) => {
    const pagination = paginationMap.get(nodeId) || { currentPage: 1, pageSize: DEFAULT_PAGE_SIZE };
    if (pagination.currentPage > 1) {
      setPagination(nodeId, { currentPage: pagination.currentPage - 1 });
    }
  };

  // Navigate to next page
  const goToNextPage = (nodeId: number) => {
    const allChildIds = getChildIds(nodeId);
    const pagination = paginationMap.get(nodeId) || { currentPage: 1, pageSize: DEFAULT_PAGE_SIZE };
    const totalPages = Math.ceil(allChildIds.length / pagination.pageSize);
    if (pagination.currentPage < totalPages) {
      setPagination(nodeId, { currentPage: pagination.currentPage + 1 });
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
                const { visibleIds, total, currentPage, pageSize, totalPages } = getPaginatedChildIds(nodeId);
                const needsPagination = total > DEFAULT_PAGE_SIZE;
                const startIdx = (currentPage - 1) * pageSize + 1;
                const endIdx = Math.min(startIdx + visibleIds.length - 1, total);
                
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
                          disabled={currentPage <= 1}
                          style={{
                            padding: '2px 6px',
                            marginRight: '4px',
                            border: '1px solid #ccc',
                            borderRadius: '2px',
                            background: '#fff',
                            cursor: currentPage <= 1 ? 'not-allowed' : 'pointer',
                            opacity: currentPage <= 1 ? 0.5 : 1,
                            fontSize: '10px',
                          }}
                        >
                          ◀
                        </button>
                        
                        <span style={{ margin: '0 8px' }}>
                          {editingPageSize.has(nodeId) ? (
                            <input
                              type="text"
                              value={editingPageSize.get(nodeId)}
                              onChange={(e) => {
                                setEditingPageSize(prev => new Map(prev).set(nodeId, e.target.value));
                              }}
                              onBlur={() => {
                                const value = parseInt(editingPageSize.get(nodeId) || '', 10);
                                if (!isNaN(value) && value > 0) {
                                  setPagination(nodeId, { pageSize: value, currentPage: 1 });
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
                              style={{
                                width: '60px',
                                padding: '1px 4px',
                                fontSize: '11px',
                                border: '1px solid #1976d2',
                                borderRadius: '2px',
                                textAlign: 'center',
                              }}
                            />
                          ) : (
                            <span
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditingPageSize(prev => new Map(prev).set(nodeId, String(pageSize)));
                              }}
                              onDoubleClick={(e) => e.stopPropagation()}
                              style={{
                                cursor: 'pointer',
                                textDecoration: 'underline',
                                color: '#1976d2',
                              }}
                              title="Double-click to edit page size"
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
                          disabled={currentPage >= totalPages}
                          style={{
                            padding: '2px 6px',
                            marginLeft: '4px',
                            border: '1px solid #ccc',
                            borderRadius: '2px',
                            background: '#fff',
                            cursor: currentPage >= totalPages ? 'not-allowed' : 'pointer',
                            opacity: currentPage >= totalPages ? 0.5 : 1,
                            fontSize: '10px',
                          }}
                        >
                          ▶
                        </button>
                      </div>
                    )}
                    
                    {/* Child nodes - lazy loaded, only visible ones */}
                    {visibleIds.map((childId, index) => {
                      const childIsLast = index === visibleIds.length - 1 && endIdx === total;
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
