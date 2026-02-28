import { useState, useEffect, useCallback } from 'react';
import { kdbManager, type TreeNode } from '../modules/knowledge/kdbManager';
import type { Module } from '../types/kdb';

interface DesignBrowserProps {
  onModuleSelect: (module: Module) => void;
  onModuleDoubleClick?: (module: Module) => void;
  selectedModuleId: number | null;
  kdbLoaded: boolean;
}

interface TreeNodeState extends TreeNode {
  childrenLoaded: boolean;
  loading: boolean;
}

export function DesignBrowser({ 
  onModuleSelect, 
  onModuleDoubleClick, 
  selectedModuleId,
  kdbLoaded 
}: DesignBrowserProps) {
  const [expandedNodes, setExpandedNodes] = useState<Set<number>>(new Set());
  const [treeNodes, setTreeNodes] = useState<Map<number, TreeNodeState>>(new Map());
  const [rootNodes, setRootNodes] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load top-level modules on mount or when kdbLoaded changes
  useEffect(() => {
    loadTopLevelModules();
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

    const module = await kdbManager.getModule(nodeId);
    if (module) {
      onModuleSelect(module);
    }
  };

  const handleNodeDoubleClick = async (nodeId: number) => {
    if (!onModuleDoubleClick) return;
    
    const module = await kdbManager.getModule(nodeId);
    if (module) {
      onModuleDoubleClick(module);
    }
  };

  const renderTreeNode = (nodeId: number, depth: number = 0) => {
    const node = treeNodes.get(nodeId);
    if (!node) return null;

    const isExpanded = expandedNodes.has(nodeId);
    const isSelected = selectedModuleId === nodeId;
    const hasChildren = node.hasChildren;
    const isLoading = node.loading;

    return (
      <div key={nodeId}>
        <div
          className={`tree-node ${isSelected ? 'selected' : ''}`}
          style={{ 
            paddingLeft: `${4 + depth * 12}px`,
            paddingTop: '4px',
            paddingBottom: '4px',
            paddingRight: '8px',
            display: 'flex',
            alignItems: 'center',
            cursor: 'pointer',
            backgroundColor: isSelected ? '#e3f2fd' : 'transparent',
            borderRadius: '4px',
          }}
          onClick={() => handleNodeClick(nodeId)}
          onDoubleClick={() => handleNodeDoubleClick(nodeId)}
        >
          {/* Expand/Collapse button */}
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
            }}
          >
            {isLoading ? '⏳' : hasChildren ? (isExpanded ? '▼' : '▶') : ''}
          </span>

          {/* Icon */}
          <span 
            className="tree-node-icon"
            style={{ marginRight: '6px', fontSize: '12px' }}
          >
            {node.isInstance ? '🔧' : '📦'}
          </span>

          {/* Name */}
          <span 
            title={node.fullName}
            style={{
              fontSize: '12px',
              color: '#333',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {node.name}
          </span>
        </div>

        {/* Render children if expanded */}
        {hasChildren && isExpanded && (
          <div>
            {isLoading ? (
              <div style={{ paddingLeft: `${4 + (depth + 1) * 12}px`, padding: '4px 8px', fontSize: '11px', color: '#999' }}>
                Loading...
              </div>
            ) : (
              // Find children by checking which nodes have this node as parent
              // We need to get children from the node's childModuleIds
              node.childModuleIds?.map(childId => renderTreeNode(childId, depth + 1))
            )}
          </div>
        )}
      </div>
    );
  };

  // Get child IDs for a node from the treeNodes map
  // Children are nodes whose parent is this node
  const getChildIds = (parentId: number): number[] => {
    const parent = treeNodes.get(parentId);
    if (!parent) {
      console.log(`[DesignBrowser] getChildIds: parent ${parentId} not found in treeNodes`);
      return [];
    }
    
    // childModuleIds should be populated when children are loaded
    const childIds = parent.childModuleIds || [];
    console.log(`[DesignBrowser] getChildIds for ${parentId}:`, childIds, 'parent:', parent);
    return childIds;
  };

  // Override render to use getChildIds
  const renderTreeNodeWithChildren = (nodeId: number, depth: number = 0, isLast: boolean = true, parentChain: boolean[] = []) => {
    const node = treeNodes.get(nodeId);
    if (!node) return null;

    const isExpanded = expandedNodes.has(nodeId);
    const isSelected = selectedModuleId === nodeId;
    const hasChildren = node.hasChildren;
    const isLoading = node.loading;
    const childIds = getChildIds(nodeId);

    const indentWidth = 16; // Width per depth level
    const lineHeight = 24; // Line height for vertical alignment
    const lineLeft = 7; // Left position of vertical line (aligned with expand arrow)

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
          {/* Indent with connection lines */}
          <div style={{ display: 'flex', alignItems: 'stretch', height: '100%' }}>
            {/* Parent chain vertical lines */}
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
            
            {/* Current level connector */}
            <div style={{ 
              width: `${indentWidth}px`,
              height: '100%',
              position: 'relative',
            }}>
              {depth > 0 && (
                <>
                  {/* Vertical line (full height for non-last, half for last) */}
                  <div style={{
                    position: 'absolute',
                    left: `${lineLeft}px`,
                    top: 0,
                    height: isLast ? '50%' : '100%',
                    width: '1px',
                    borderLeft: '1px dashed #999',
                  }} />
                  {/* Horizontal line to connect to node */}
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

          {/* Expand/Collapse button */}
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

          {/* Name */}
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

        {/* Render children if expanded */}
        {hasChildren && isExpanded && (
          <div>
            {isLoading ? (
              <div style={{ paddingLeft: `${(depth + 1) * indentWidth + 20}px`, padding: '4px 8px', fontSize: '11px', color: '#999' }}>
                Loading...
              </div>
            ) : (
              childIds.map((childId, index) => {
                const childIsLast = index === childIds.length - 1;
                return renderTreeNodeWithChildren(
                  childId, 
                  depth + 1, 
                  childIsLast,
                  [...parentChain, isLast]
                );
              })
            )}
          </div>
        )}
      </div>
    );
  };

  if (loading) {
    return (
      <div className="hierarchy-panel" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div className="panel-header" style={{ padding: '8px 12px', borderBottom: '1px solid #e0e0e0', fontWeight: 'bold' }}>
          Hierarchy
        </div>
        <div style={{ padding: '20px', textAlign: 'center', color: '#999', flex: 1 }}>
          Loading...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="hierarchy-panel" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div className="panel-header" style={{ padding: '8px 12px', borderBottom: '1px solid #e0e0e0', fontWeight: 'bold' }}>
          Hierarchy
        </div>
        <div style={{ padding: '20px', textAlign: 'center', color: '#d32f2f', flex: 1, fontSize: '12px' }}>
          {error}
        </div>
      </div>
    );
  }

  if (rootNodes.length === 0) {
    return (
      <div className="hierarchy-panel" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div className="panel-header" style={{ padding: '8px 12px', borderBottom: '1px solid #e0e0e0', fontWeight: 'bold' }}>
          Hierarchy
        </div>
        <div style={{ padding: '20px', textAlign: 'center', color: '#999', flex: 1, fontSize: '11px' }}>
          {kdbManager.isLoaded() 
            ? 'No design hierarchy available' 
            : 'Connect to server to load design'}
        </div>
      </div>
    );
  }

  return (
    <div className="hierarchy-panel" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="panel-header" style={{ padding: '8px 12px', borderBottom: '1px solid #e0e0e0', fontWeight: 'bold' }}>
        Hierarchy
      </div>
      <div className="tree-view" style={{ flex: 1, overflow: 'auto', padding: '4px' }}>
        {rootNodes.map(nodeId => renderTreeNodeWithChildren(nodeId))}
      </div>
    </div>
  );
}
