import { useState, useRef, useEffect, useCallback } from 'react';

interface FilterInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  style?: React.CSSProperties;
  storageKey?: string; // 用于存储历史记录的 localStorage key
}

export function FilterInput({
  value,
  onChange,
  placeholder = 'Filter...',
  style = {},
  storageKey = 'filter_history',
}: FilterInputProps) {
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [filteredSuggestions, setFilteredSuggestions] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [history, setHistory] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // 从 localStorage 加载历史记录
  useEffect(() => {
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          setHistory(parsed);
        }
      } catch {
        // 解析失败，使用空数组
      }
    }
  }, [storageKey]);

  // 保存历史记录到 localStorage
  const saveHistory = useCallback((newHistory: string[]) => {
    localStorage.setItem(storageKey, JSON.stringify(newHistory));
  }, [storageKey]);

  // 添加新的输入到历史记录
  const addToHistory = useCallback((newValue: string) => {
    if (!newValue.trim()) return;
    
    setHistory(prev => {
      // 去重，并将新值放到最前面
      const filtered = prev.filter(h => h !== newValue);
      const newHistory = [newValue, ...filtered].slice(0, 10); // 最多保留10条
      saveHistory(newHistory);
      return newHistory;
    });
  }, [saveHistory]);

  // 点击外部关闭下拉列表
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setShowSuggestions(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleFocus = () => {
    // 显示历史记录（最多5个）
    setFilteredSuggestions(history.slice(0, 5));
    setSelectedIndex(-1);
    setShowSuggestions(true);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    onChange(newValue);

    // 根据输入过滤历史记录
    if (newValue) {
      const filtered = history.filter(s =>
        s.toLowerCase().includes(newValue.toLowerCase())
      ).slice(0, 5);
      setFilteredSuggestions(filtered);
    } else {
      setFilteredSuggestions(history.slice(0, 5));
    }
    setSelectedIndex(-1);
    setShowSuggestions(true);
  };

  const handleSelectSuggestion = (suggestion: string) => {
    onChange(suggestion);
    setShowSuggestions(false);
    setSelectedIndex(-1);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showSuggestions || filteredSuggestions.length === 0) {
      // 如果没有显示下拉列表，按 Enter 时保存当前输入到历史
      if (e.key === 'Enter' && value.trim()) {
        addToHistory(value);
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(prev => 
          prev < filteredSuggestions.length - 1 ? prev + 1 : prev
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(prev => (prev > 0 ? prev - 1 : -1));
        break;
      case 'Enter':
        e.preventDefault();
        if (selectedIndex >= 0) {
          handleSelectSuggestion(filteredSuggestions[selectedIndex]);
        } else if (value.trim()) {
          // 如果没有选中项，保存当前输入到历史
          addToHistory(value);
        }
        break;
      case 'Escape':
        setShowSuggestions(false);
        setSelectedIndex(-1);
        break;
    }
  };

  return (
    <div ref={containerRef} style={{ position: 'relative', flex: 1, minWidth: 0 }}>
      <input
        ref={inputRef}
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={handleChange}
        onFocus={handleFocus}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          // 失去焦点时保存输入到历史
          if (value.trim()) {
            addToHistory(value);
          }
        }}
        style={{
          width: '100%',
          minWidth: 0,
          padding: style?.padding ?? '2px 4px',
          fontSize: style?.fontSize ?? '10px',
          border: '1px solid #c0c0c0',
          borderRadius: '2px',
          boxSizing: 'border-box',
          ...style,
        }}
      />
      {showSuggestions && filteredSuggestions.length > 0 && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            backgroundColor: '#fff',
            border: '1px solid #c0c0c0',
            borderTop: 'none',
            borderRadius: '0 0 2px 2px',
            zIndex: 1000,
            maxHeight: '120px',
            overflowY: 'auto',
            boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
          }}
        >
          {filteredSuggestions.map((suggestion, index) => (
            <div
              key={index}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                handleSelectSuggestion(suggestion);
              }}
              style={{
                padding: '4px 8px',
                fontSize: '10px',
                cursor: 'pointer',
                borderBottom: index < filteredSuggestions.length - 1 ? '1px solid #f0f0f0' : 'none',
                backgroundColor: index === selectedIndex ? '#4080c0' : '#fff',
                color: index === selectedIndex ? '#fff' : '#000',
              }}
              onMouseEnter={() => setSelectedIndex(index)}
              onMouseLeave={() => setSelectedIndex(-1)}
            >
              {suggestion}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
