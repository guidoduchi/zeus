import { useState } from "react";
import type { RowFilterDefinition } from "../hooks/useRowFilters";

interface Props {
  definitions: RowFilterDefinition[];
  selections: Record<string, string[]>;
  activeCount: number;
  onToggle: (key: string, value: string) => void;
  onClear: () => void;
}

export function FilterBar({ definitions, selections, activeCount, onToggle, onClear }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <div className="filter-anchor">
      <button
        type="button"
        className={`toolbar-button compactable-button ${activeCount ? "active-filter" : ""}`}
        aria-label={activeCount ? `Filters (${activeCount} active)` : "Filters"}
        title={activeCount ? `Filters (${activeCount} active)` : "Filters"}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="toolbar-icon" aria-hidden="true">≡</span>
        <span className="toolbar-label">Filters{activeCount ? ` (${activeCount})` : ""}</span>
      </button>
      {open && (
        <section className="filter-panel" aria-label="Table filters">
          <header>
            <strong>Filter visible rows</strong>
            <div>
              <button type="button" className="text-button" disabled={!activeCount} onClick={onClear}>Clear</button>
              <button type="button" className="icon-button" aria-label="Close filters" onClick={() => setOpen(false)}>×</button>
            </div>
          </header>
          <div className="filter-groups">
            {definitions.map((definition) => (
              <fieldset key={definition.key}>
                <legend>{definition.label}</legend>
                {definition.options.map((option) => (
                  <label key={option.value}>
                    <input
                      type="checkbox"
                      checked={(selections[definition.key] || []).includes(option.value)}
                      onChange={() => onToggle(definition.key, option.value)}
                    />
                    <span>{option.label}</span>
                    <small>{option.count}</small>
                  </label>
                ))}
              </fieldset>
            ))}
          </div>
          <footer>Options are OR within a group and AND between groups.</footer>
        </section>
      )}
    </div>
  );
}
