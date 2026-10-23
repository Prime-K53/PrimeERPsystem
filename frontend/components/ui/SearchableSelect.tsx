import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

export interface SearchSelectOption {
  value: string;
  label: string;
}

export interface SearchSelectProps {
  label?: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  options: SearchSelectOption[];
  icon?: React.ReactNode;
  containerStyle?: React.CSSProperties;
  inputStyle?: React.CSSProperties;
  optionItemStyle?: React.CSSProperties;
  optionSelectedStyle?: React.CSSProperties;
  optionHoverStyle?: React.CSSProperties;
  emptyStyle?: React.CSSProperties;
  className?: string;
}

const SearchableSelect: React.FC<SearchSelectProps> = ({
  label,
  placeholder = 'Search…',
  value,
  onChange,
  options,
  icon,
  containerStyle,
  inputStyle,
  optionItemStyle,
  optionSelectedStyle,
  optionHoverStyle,
  emptyStyle,
  className = '',
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocumentClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocumentClick);
    return () => document.removeEventListener('mousedown', onDocumentClick);
  }, [open]);

  const filteredOptions = useMemo(() => {
    if (!query.trim()) return options;
    const q = query.trim().toLowerCase();
    return options.filter((opt) =>
      opt.label.toLowerCase().includes(q) || opt.value.toLowerCase().includes(q)
    );
  }, [options, query]);

  const selected = options.find((opt) => opt.value === value);

  const handleSelect = (opt: SearchSelectOption) => {
    setQuery(opt.label);
    onChange(opt.value);
    setOpen(false);
  };

  const itemStyle = optionItemStyle ?? {
    padding: '8px 12px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  };
  const selectedStyle = optionSelectedStyle ?? { ...itemStyle, fontWeight: 600, color: '#0f544c' };
  const hoverStyle = optionHoverStyle ?? { background: '#eef7f6' };
  const containerInputStyle = inputStyle ?? {};
  const inputOuterStyle = {
    width: '100%',
    fontFamily: "'Inter', sans-serif",
    fontSize: '13px',
    color: '#0f172a',
    padding: icon ? '10px 36px 10px 8px' : '10px 36px 10px 12px',
    borderRadius: '9px',
    border: `1.4px solid ${open ? '#3fa294' : '#e4ddd1'}`,
    outline: 'none',
    background: '#FEFDFB',
    transition: 'border-color .15s ease, boxShadow .15s ease',
    boxShadow: open ? '0 0 0 3px rgba(63,162,148,.12)' : 'none',
  };

  return (
    <div style={{ fontFamily: "'Inter', sans-serif", width: '100%' }} className={className}>
      {label && (
        <label
          style={{
            display: 'block',
            fontSize: '12px',
            fontWeight: 600,
            color: '#3fa294',
            marginBottom: '6px',
            letterSpacing: '.01',
          }}
        >
          {label}
        </label>
      )}
      <div
        ref={ref}
        style={{ position: 'relative', display: 'flex', alignItems: 'center', width: '100%' }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      >
        {icon && (
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              paddingLeft: '12px',
              color: '#5c6567',
              flexShrink: 0,
            }}
          >
            {icon}
          </span>
        )}
        <input
          type="text"
          value={open ? query : value}
          placeholder={placeholder}
          readOnly
          style={containerInputStyle}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          aria-expanded={open}
        />
        <span
          style={{
            position: 'absolute',
            right: '12px',
            top: '50%',
            transform: 'translateY(-50%)',
            color: '#5c6567',
            pointerEvents: 'none',
            display: 'flex',
          }}
        >
          <ChevronDown size={16} className={open ? 'rotate-180' : ''} />
        </span>
      </div>
      {open && (
        <div
          style={{
            position: 'absolute',
            zIndex: 50,
            marginTop: 4,
            minWidth: '100%',
            maxHeight: 200,
            overflowY: 'auto',
            background: '#FEFDFB',
            border: '1.4px solid #e4ddd1',
            borderRadius: '9px',
            boxShadow: '0 8px 24px -6px rgba(0,0,0,.15)',
            ...containerStyle,
          }}
        >
          {filteredOptions.length === 0 ? (
            <div style={emptyStyle ?? { padding: '12px 12px', color: '#5c6567', fontSize: '12px', textAlign: 'center' }}>
              No options
            </div>
          ) : (
            filteredOptions.map((opt) => (
              <div
                key={opt.value}
                onMouseEnter={() => setQuery(opt.label)}
                onClick={() => handleSelect(opt)}
                style={{
                  ...itemStyle,
                  ...selected && opt.value === value ? selectedStyle : {},
                  ...hoverStyle,
                  background: opt.value === value ? '#eef7f6' : hoverStyle.background,
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>{opt.label}</span>
                {opt.value === value && <ChevronDown size={16} />}
              </div>
            ))
          )}
        </div>
      )}
      {selected && (
        <div style={{ fontSize: '12px', color: '#3fa294', marginTop: '2px' }}>
          {selected.label}
        </div>
      )}
    </div>
  );
};

export { SearchableSelect };
export default SearchableSelect;
