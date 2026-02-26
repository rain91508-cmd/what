import { useState } from 'react';
import type { Instance } from '../types';

interface DesignBrowserProps {
  onInstanceSelect: (instance: Instance) => void;
  selectedInstance: Instance | null;
}

interface HierarchyNode {
  id: string;
  name: string;
  moduleName: string;
  type: 'instance';
  children: HierarchyNode[];
  expanded: boolean;
  instance: Instance;
}

// Mock data for demonstration - 只显示instance层次结构
const mockHierarchy: HierarchyNode[] = [
  {
    id: 'top',
    name: 'top',
    moduleName: 'top_module',
    type: 'instance',
    expanded: true,
    instance: {
      name: 'top',
      fullPath: 'top',
      moduleName: 'top_module',
      parentPath: '',
      children: ['top.u_cpu', 'top.u_mem', 'top.u_bus'],
    },
    children: [
      {
        id: 'top.u_cpu',
        name: 'u_cpu',
        moduleName: 'cpu',
        type: 'instance',
        expanded: false,
        instance: {
          name: 'u_cpu',
          fullPath: 'top.u_cpu',
          moduleName: 'cpu',
          parentPath: 'top',
          children: ['top.u_cpu.u_alu', 'top.u_cpu.u_regfile'],
        },
        children: [
          {
            id: 'top.u_cpu.u_alu',
            name: 'u_alu',
            moduleName: 'alu',
            type: 'instance',
            expanded: false,
            instance: {
              name: 'u_alu',
              fullPath: 'top.u_cpu.u_alu',
              moduleName: 'alu',
              parentPath: 'top.u_cpu',
              children: [],
            },
            children: [],
          },
          {
            id: 'top.u_cpu.u_regfile',
            name: 'u_regfile',
            moduleName: 'regfile',
            type: 'instance',
            expanded: false,
            instance: {
              name: 'u_regfile',
              fullPath: 'top.u_cpu.u_regfile',
              moduleName: 'regfile',
              parentPath: 'top.u_cpu',
              children: [],
            },
            children: [],
          },
        ],
      },
      {
        id: 'top.u_mem',
        name: 'u_mem',
        moduleName: 'memory',
        type: 'instance',
        expanded: false,
        instance: {
          name: 'u_mem',
          fullPath: 'top.u_mem',
          moduleName: 'memory',
          parentPath: 'top',
          children: [],
        },
        children: [],
      },
      {
        id: 'top.u_bus',
        name: 'u_bus',
        moduleName: 'bus_arbiter',
        type: 'instance',
        expanded: false,
        instance: {
          name: 'u_bus',
          fullPath: 'top.u_bus',
          moduleName: 'bus_arbiter',
          parentPath: 'top',
          children: [],
        },
        children: [],
      },
    ],
  },
];

export function DesignBrowser({ onInstanceSelect, selectedInstance }: DesignBrowserProps) {
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set(['top']));
  const [hierarchy] = useState<HierarchyNode[]>(mockHierarchy);

  const toggleNode = (nodeId: string) => {
    const newExpanded = new Set(expandedNodes);
    if (newExpanded.has(nodeId)) {
      newExpanded.delete(nodeId);
    } else {
      newExpanded.add(nodeId);
    }
    setExpandedNodes(newExpanded);
  };

  const handleNodeClick = (node: HierarchyNode) => {
    onInstanceSelect(node.instance);
  };

  const renderTreeNode = (node: HierarchyNode, depth: number = 0) => {
    const isExpanded = expandedNodes.has(node.id);
    const hasChildren = node.children && node.children.length > 0;
    const isSelected = selectedInstance?.fullPath === node.instance.fullPath;

    return (
      <div key={node.id}>
        <div
          className={`tree-node ${isSelected ? 'selected' : ''}`}
          style={{ paddingLeft: `${4 + depth * 12}px` }}
          onClick={() => handleNodeClick(node)}
        >
          {hasChildren && (
            <span
              className="tree-node-expand"
              onClick={(e) => {
                e.stopPropagation();
                toggleNode(node.id);
              }}
            >
              {isExpanded ? '▼' : '▶'}
            </span>
          )}
          {!hasChildren && <span className="tree-node-expand"></span>}
          <span className="tree-node-icon">🔧</span>
          <span title={`${node.name} (${node.moduleName})`}>
            {node.name}
          </span>
        </div>
        {hasChildren && isExpanded && (
          <div>
            {node.children!.map(child => renderTreeNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="hierarchy-panel">
      <div className="panel-header">Hierarchy</div>
      <div className="tree-view">
        {hierarchy.map(node => renderTreeNode(node))}
      </div>
    </div>
  );
}
