import { useState } from 'react';

interface DesignBrowserProps {
  onFileSelect: (filePath: string) => void;
  onSignalSelect: (signalPath: string) => void;
}

interface TreeNode {
  id: string;
  name: string;
  type: 'module' | 'instance' | 'signal' | 'file';
  children?: TreeNode[];
  expanded?: boolean;
}

// Mock data for demonstration
const mockHierarchy: TreeNode[] = [
  {
    id: 'top',
    name: 'top',
    type: 'module',
    expanded: true,
    children: [
      {
        id: 'top.clk',
        name: 'clk',
        type: 'signal',
      },
      {
        id: 'top.rst_n',
        name: 'rst_n',
        type: 'signal',
      },
      {
        id: 'top.u_cpu',
        name: 'u_cpu',
        type: 'instance',
        expanded: false,
        children: [
          {
            id: 'top.u_cpu.pc',
            name: 'pc[31:0]',
            type: 'signal',
          },
          {
            id: 'top.u_cpu.instr',
            name: 'instr[31:0]',
            type: 'signal',
          },
        ],
      },
      {
        id: 'top.u_mem',
        name: 'u_mem',
        type: 'instance',
        expanded: false,
        children: [
          {
            id: 'top.u_mem.addr',
            name: 'addr[15:0]',
            type: 'signal',
          },
          {
            id: 'top.u_mem.data',
            name: 'data[31:0]',
            type: 'signal',
          },
        ],
      },
    ],
  },
];

export function DesignBrowser({ onFileSelect, onSignalSelect }: DesignBrowserProps) {
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set(['top']));
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  const toggleNode = (nodeId: string) => {
    const newExpanded = new Set(expandedNodes);
    if (newExpanded.has(nodeId)) {
      newExpanded.delete(nodeId);
    } else {
      newExpanded.add(nodeId);
    }
    setExpandedNodes(newExpanded);
  };

  const handleNodeClick = (node: TreeNode) => {
    setSelectedNode(node.id);
    
    if (node.type === 'signal') {
      onSignalSelect(node.id);
    } else if (node.type === 'file') {
      onFileSelect(node.id);
    }
  };

  const renderTreeNode = (node: TreeNode, depth: number = 0) => {
    const isExpanded = expandedNodes.has(node.id);
    const hasChildren = node.children && node.children.length > 0;
    const isSelected = selectedNode === node.id;

    return (
      <div key={node.id}>
        <div
          className={`tree-node ${isSelected ? 'selected' : ''}`}
          style={{ paddingLeft: `${8 + depth * 16}px` }}
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
          <span className="tree-node-icon">
            {node.type === 'module' && '📦'}
            {node.type === 'instance' && '🔧'}
            {node.type === 'signal' && '📊'}
            {node.type === 'file' && '📄'}
          </span>
          <span>{node.name}</span>
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
    <div className="left-panel">
      <div className="panel-header">Design Browser</div>
      <div className="tree-view">
        {mockHierarchy.map(node => renderTreeNode(node))}
      </div>
    </div>
  );
}
