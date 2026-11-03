// Searchable country picker (WAI-ARIA combobox with a listbox popup). Type to filter, arrow keys to move,
// Enter to choose, Escape to close. Countries where LotusPond is not available yet are marked.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { countryPolicy } from '../../shared/regions';
import { countryOptions, filterCountries } from '../lib/country';
import { Icon } from './ui';
import '../styles/compliance.css';

export function CountrySelect({ id, value, onChange, invalid, describedBy }: {
  id: string;
  value: string;
  onChange: (code: string) => void;
  invalid?: boolean;
  describedBy?: string;
}) {
  const listId = useId();
  const options = useMemo(() => countryOptions(), []);
  const selectedName = options.find(o => o.code === value)?.name ?? '';
  /** What the person has typed while the list is open; when closed the field shows the chosen country. */
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [typed, setTyped] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Show every country until the person types; then only matches.
  const shown = useMemo(() => (typed ? filterCountries(options, text) : options), [options, text, typed]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  function openList() {
    if (open) return;
    setTyped(false);
    setText(selectedName);
    setOpen(true);
    const i = options.findIndex(o => o.code === value);
    setActive(i >= 0 ? i : 0);
  }

  function choose(code: string) {
    onChange(code);
    setOpen(false);
    setTyped(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { openList(); return; }
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive(i => Math.min(Math.max(i + step, 0), Math.max(shown.length - 1, 0)));
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      if (!open) return;
      e.preventDefault();
      setActive(i => Math.min(Math.max(i + (e.key === 'PageDown' ? 8 : -8), 0), Math.max(shown.length - 1, 0)));
    } else if (e.key === 'Enter') {
      if (open && shown[active]) { e.preventDefault(); choose(shown[active].code); }
    } else if (e.key === 'Escape') {
      if (open) { e.preventDefault(); setOpen(false); setTyped(false); }
    } else if (e.key === 'Tab' && open) {
      // Leaving with exactly one match chooses it; otherwise the choice stays as it was.
      if (typed && shown.length === 1) choose(shown[0].code);
      else setOpen(false);
    }
  }

  const activeId = open && shown[active] ? `${listId}-${shown[active].code}` : undefined;

  return (
    <div className={`combo${open ? ' is-open' : ''}`}>
      <div className="combo__field">
        <input
          ref={inputRef}
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          autoComplete="off"
          spellCheck={false}
          placeholder="Search for your country"
          value={open ? text : selectedName}
          onChange={e => { setText(e.target.value); setTyped(true); setOpen(true); setActive(0); }}
          onFocus={e => e.currentTarget.select()}
          onClick={openList}
          onKeyDown={onKeyDown}
          onBlur={() => {
            if (typed && shown.length === 1) choose(shown[0].code);
            else { setOpen(false); setTyped(false); }
          }}
        />
        <button type="button" className="combo__toggle" tabIndex={-1} aria-label={open ? 'Close the country list' : 'Show all countries'}
          onMouseDown={e => e.preventDefault()}
          onClick={() => { if (open) setOpen(false); else { inputRef.current?.focus(); openList(); } }}>
          {Icon.chevron}
        </button>
      </div>
      {open && (
        <ul ref={listRef} id={listId} role="listbox" className="combo__list" aria-label="Countries">
          {shown.length === 0 && <li className="combo__empty" role="presentation">No country matches “{text}”.</li>}
          {shown.map((o, i) => (
            <li key={o.code} id={`${listId}-${o.code}`} role="option" aria-selected={o.code === value}
              className={`combo__option${i === active ? ' is-active' : ''}`}
              onMouseDown={e => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(o.code)}>
              <span>{o.name}</span>
              {!countryPolicy(o.code).available && <small>Not available yet</small>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
