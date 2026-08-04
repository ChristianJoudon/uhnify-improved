import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { AnimatePresence, motion } from 'framer-motion';
import { Check2, ChevronDown } from 'react-bootstrap-icons';

const TYPE_AHEAD_MS = 700;
const EDGE = 12;

const matchFrom = (options, query, from) => {
  const start = ((from % options.length) + options.length) % options.length;
  for (let step = 0; step < options.length; step++) {
    const at = (start + step) % options.length;
    if (options[at].label.toLowerCase().startsWith(query)) {
      return at;
    }
  }
  return -1;
};

const Picker = ({ id, label, caption, value, options, onChange, align }) => {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [drop, setDrop] = useState({ above: false, right: align === 'end' });
  const wrapRef = useRef(null);
  const buttonRef = useRef(null);
  const panelRef = useRef(null);
  const typed = useRef({ text: '', at: 0 });

  const chosen = Math.max(options.findIndex(option => option.value === value), 0);
  const optionId = index => `${id}-option-${index}`;

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus && buttonRef.current) {
      buttonRef.current.focus();
    }
  };

  const show = () => {
    setActive(chosen);
    setOpen(true);
  };

  const commit = index => {
    onChange(options[index].value);
    close();
  };

  const seek = character => {
    const now = Date.now();
    const stale = now - typed.current.at > TYPE_AHEAD_MS;
    const text = (stale ? '' : typed.current.text) + character.toLowerCase();
    typed.current = { text, at: now };
    const cycling = text.length > 1 && [...text].every(letter => letter === text[0]);
    const query = cycling ? text[0] : text;
    const found = matchFrom(options, query, cycling || text.length === 1 ? active + 1 : active);
    if (found !== -1) {
      setOpen(true);
      setActive(found);
    }
  };

  const handleKey = event => {
    const last = options.length - 1;
    const move = index => {
      event.preventDefault();
      setOpen(true);
      setActive(Math.min(Math.max(index, 0), last));
    };
    switch (event.key) {
    case 'ArrowDown': move(open ? active + 1 : chosen); break;
    case 'ArrowUp': move(open ? active - 1 : chosen); break;
    case 'Home': move(0); break;
    case 'End': move(last); break;
    case 'Enter':
    case ' ':
      event.preventDefault();
      if (open) { commit(active); } else { show(); }
      break;
    case 'Escape':
      if (open) {
        event.stopPropagation();
        close();
      }
      break;
    case 'Tab':
      setOpen(false);
      break;
    default:
      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        seek(event.key);
      }
    }
  };

  useLayoutEffect(() => {
    if (!open) {
      return undefined;
    }
    const measure = () => {
      const panel = panelRef.current;
      const anchor = buttonRef.current;
      if (!panel || !anchor) {
        return;
      }
      const box = anchor.getBoundingClientRect();
      setDrop({
        above: box.bottom + panel.offsetHeight > window.innerHeight - EDGE && box.top - panel.offsetHeight > EDGE,
        right: align === 'end'
          ? box.right - panel.offsetWidth > EDGE
          : box.left + panel.offsetWidth > window.innerWidth - EDGE,
      });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, align]);

  useEffect(() => {
    if (open) {
      const row = document.getElementById(optionId(active));
      if (row) {
        row.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [open, active]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const away = event => {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  return (
    <div className="mb-picker" ref={wrapRef}>
      <button
        type="button"
        id={id}
        ref={buttonRef}
        className="mb-chip mb-picker-btn"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-listbox`}
        aria-activedescendant={open ? optionId(active) : undefined}
        onClick={() => (open ? close() : show())}
        onKeyDown={handleKey}
      >
        {caption && <span className="mb-picker-caption">{caption}</span>}
        <span className="mb-picker-value">{options[chosen].label}</span>
        <ChevronDown className="mb-picker-caret" size={12} aria-hidden="true" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            ref={panelRef}
            className={`mb-picker-panel${drop.above ? ' is-above' : ''}${drop.right ? ' is-right' : ''}`}
            initial={{ opacity: 0, scale: 0.97, y: drop.above ? 6 : -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: drop.above ? 4 : -4, transition: { duration: 0.12 } }}
            transition={{ type: 'spring', stiffness: 430, damping: 32 }}
          >
            <div className="mb-picker-list" id={`${id}-listbox`} role="listbox" aria-label={label}>
              {options.map((option, index) => (
                <button
                  type="button"
                  key={option.value}
                  id={optionId(index)}
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === chosen}
                  className={`mb-picker-option${index === active ? ' is-active' : ''}${index === chosen ? ' is-chosen' : ''}`}
                  onClick={() => commit(index)}
                  onMouseMove={() => setActive(index)}
                >
                  <span className="mb-picker-option-text">
                    <span className="mb-picker-option-label">{option.label}</span>
                    {option.hint && <span className="mb-picker-option-hint">{option.hint}</span>}
                  </span>
                  {index === chosen && <Check2 className="mb-picker-tick" size={16} aria-hidden="true" />}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

Picker.propTypes = {
  id: PropTypes.string.isRequired,
  label: PropTypes.string.isRequired,
  caption: PropTypes.string,
  value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
  options: PropTypes.arrayOf(PropTypes.shape({
    value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
    label: PropTypes.string.isRequired,
    hint: PropTypes.string,
  })).isRequired,
  onChange: PropTypes.func.isRequired,
  align: PropTypes.oneOf(['start', 'end']),
};

Picker.defaultProps = {
  caption: null,
  align: 'start',
};

export default Picker;
