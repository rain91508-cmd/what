import { ReactNode } from 'react';

interface Tab {
  id: string;
  label: string;
}

interface TabPanelProps {
  activeTab: string;
  onTabChange: (tabId: string) => void;
  tabs: Tab[];
  children: ReactNode;
}

export function TabPanel({ activeTab, onTabChange, tabs, children }: TabPanelProps) {
  return (
    <div className="tab-panel">
      <div className="tab-header">
        {tabs.map(tab => (
          <button
            key={tab.id}
            className={`tab-button ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="tab-content">
        {children}
      </div>
    </div>
  );
}
