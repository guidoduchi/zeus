import { useEffect, useId, useMemo, useRef, useState } from "react";

export interface AutocompleteOption {
  key: string;
  value: string;
  detail?: string | null;
  searchText?: string | null;
}

interface Props {
  label: string;
  value: string;
  options: AutocompleteOption[];
  onChange: (value: string) => void;
  onSelect?: (option: AutocompleteOption) => void;
  required?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  fieldClassName?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
  maxLength?: number;
  placeholder?: string;
}

function normalized(value: unknown): string {
  return String(value || "").trim().toLocaleLowerCase();
}

export function AutocompleteField({
  label,
  value,
  options,
  onChange,
  onSelect,
  required = false,
  autoFocus = false,
  disabled = false,
  fieldClassName = "",
  inputMode,
  maxLength,
  placeholder,
}: Props) {
  const generatedId = useId().replaceAll(":", "");
  const inputId = `zeus-autocomplete-${generatedId}`;
  const listboxId = `${inputId}-options`;
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const matches = useMemo(() => {
    const query = normalized(value);
    const seen = new Set<string>();
    return options.filter((option) => {
      const identity = `${normalized(option.value)}\u0000${normalized(option.detail)}`;
      if (seen.has(identity)) return false;
      seen.add(identity);
      if (!query) return true;
      return normalized(
        `${option.value} ${option.detail || ""} ${option.searchText || ""}`,
      ).includes(query);
    });
  }, [options, value]);

  useEffect(() => {
    if (activeIndex >= matches.length) setActiveIndex(matches.length ? matches.length - 1 : -1);
  }, [activeIndex, matches.length]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    rootRef.current
      ?.querySelector<HTMLElement>(`[data-autocomplete-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  function close() {
    setOpen(false);
    setActiveIndex(-1);
  }

  function choose(option: AutocompleteOption) {
    if (onSelect) onSelect(option);
    else onChange(option.value);
    close();
  }

  function move(direction: -1 | 1) {
    if (!matches.length) return;
    setOpen(true);
    setActiveIndex((current) => {
      if (current < 0) return direction > 0 ? 0 : matches.length - 1;
      return (current + direction + matches.length) % matches.length;
    });
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!matches.length) return;
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter" && open && activeIndex >= 0) {
      const option = matches[activeIndex];
      if (!option) return;
      event.preventDefault();
      choose(option);
    }
  }

  return <div className={`form-field ${fieldClassName}`.trim()}>
    <label htmlFor={inputId}>{label}{required ? " *" : ""}</label>
    <div
      className="themed-autocomplete"
      ref={rootRef}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) close();
      }}
    >
      <input
        id={inputId}
        value={value}
        disabled={disabled}
        required={required}
        inputMode={inputMode}
        maxLength={maxLength}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
        onFocus={() => { if (matches.length || options.length) setOpen(true); }}
        onClick={() => { if (matches.length || options.length) setOpen(true); }}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setActiveIndex(-1);
        }}
        onKeyDown={handleKeyDown}
      />
      {open && <div className="themed-autocomplete-menu" id={listboxId} role="listbox" aria-label={`${label} suggestions`}>
        {matches.length ? matches.map((option, index) => <button
          type="button"
          role="option"
          id={`${listboxId}-${index}`}
          aria-selected={activeIndex === index}
          className={activeIndex === index ? "active" : ""}
          data-autocomplete-index={index}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => setActiveIndex(index)}
          onClick={() => choose(option)}
          key={option.key}
        >
          <strong>{option.value}</strong>
          {option.detail && <span>{option.detail}</span>}
        </button>) : <span className="themed-autocomplete-status">No matching saved value.</span>}
      </div>}
    </div>
  </div>;
}
