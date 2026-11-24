import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react';
import { equipmentKey } from '../equipment';
import { useLanguage } from './Language';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  id: 'manufacturer' | 'model';
  value: string;
  manufacturer: string;
  category: string;
  onValue: (value: string) => void;
};

export function EquipmentInput({ manufacturer, category, onValue, value, ...input }: Props) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [result, setResult] = useState<{ query: string; items: string[] }>();
  const field = useRef<HTMLInputElement>(null);
  const listId = input.id + '-suggestions';
  const params = new URLSearchParams({ kind: input.id, q: value });
  if (input.id === 'model' && manufacturer.trim() && category) {
    params.set('manufacturer', manufacturer);
    params.set('category', category);
  }
  const query = input.id === 'manufacturer' || params.has('category') ? params.toString() : '';

  useEffect(() => {
    if (!open || !query) return;
    const abort = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch('/api/v1/repair-equipment?' + query, { signal: abort.signal });
        if (!response.ok) return;
        const { items } = await response.json() as { items: string[] };
        if (!abort.signal.aborted) {
          setActive(-1);
          setResult({ query, items });
        }
      } catch {
        // Suggestions are optional. The entered value remains usable offline.
      }
    }, 160);
    return () => { window.clearTimeout(timer); abort.abort(); };
  }, [open, query]);

  const items = result?.query === query ? result.items : [];
  const create = Boolean(value.trim()) && !items.some(item => equipmentKey(item) === equipmentKey(value));
  const choices = create ? [...items, value] : items;
  const expanded = open && choices.length > 0;

  function choose(index: number) {
    onValue(choices[index]);
    field.current?.focus();
    setOpen(false);
    setActive(-1);
  }

  useEffect(() => {
    if (expanded && active >= 0) document.getElementById(listId + '-' + active)?.scrollIntoView({ block: 'nearest' });
  }, [expanded, active, listId]);

  return <div className="equipment-input" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setOpen(false);
      setActive(-1);
    }
  }}>
    <input {...input} ref={field} value={value} type="text" role="combobox" dir="auto" autoComplete="off"
      autoCapitalize="none" spellCheck={false} aria-autocomplete="list" aria-expanded={expanded}
      aria-controls={expanded ? listId : undefined}
      aria-activedescendant={expanded && active >= 0 ? listId + '-' + active : undefined}
      onFocus={() => setOpen(true)} onClick={() => setOpen(true)}
      onChange={event => { onValue(event.target.value); setActive(-1); setOpen(true); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          setOpen(false);
          setActive(-1);
        } else if (['ArrowDown', 'ArrowUp'].includes(event.key) && choices.length) {
          event.preventDefault();
          setOpen(true);
          setActive(index => event.key === 'ArrowDown'
            ? (index + 1) % choices.length : (index <= 0 ? choices.length - 1 : index - 1));
        } else if (event.key === 'Enter') {
          event.preventDefault();
          if (expanded && active >= 0 && active < choices.length) choose(active);
          else { setOpen(false); setActive(-1); }
        }
      }} />
    {expanded && <ul id={listId} role="listbox" aria-labelledby={input.id + '-label'} className="equipment-options">
      {choices.map((item, index) => <li key={index} id={listId + '-' + index} role="option"
        aria-selected={active === index} onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}>
        {create && index === choices.length - 1 && <span>{t('useEnteredValue')} </span>}<bdi>{item}</bdi>
      </li>)}
    </ul>}
  </div>;
}
