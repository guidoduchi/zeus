import type { ColumnDefinition } from "../types";

interface Props {
  columns: ColumnDefinition[];
  visibleKeys: string[];
  onToggle: (key: string) => void;
  onMove: (key: string, direction: -1 | 1) => void;
  onReset: () => void;
  onClose: () => void;
}

export function ColumnChooser({ columns, visibleKeys, onToggle, onMove, onReset, onClose }: Props) {
  return (
    <div className="column-popover" role="dialog" aria-label="Dashboard columns">
      <div className="popover-heading">
        <div>
          <strong>Dashboard fields</strong>
          <small>Toggle and arrange. Widths are fixed.</small>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close columns">×</button>
      </div>
      <div className="column-list">
        {columns.map((column, index) => {
          const label = column.label || "Risk";
          return (
            <div className="column-option" key={column.key}>
              <label>
                <input
                  type="checkbox"
                  checked={visibleKeys.includes(column.key)}
                  disabled={column.key === "ticketId"}
                  onChange={() => onToggle(column.key)}
                />
                <span>{label}</span>
              </label>
              <div className="reorder-buttons">
                <button type="button" disabled={column.key === "ticketId" || index === 0 || columns[index - 1]?.key === "ticketId"} onClick={() => onMove(column.key, -1)} aria-label={`Move ${label} up`}>↑</button>
                <button type="button" disabled={column.key === "ticketId" || index === columns.length - 1} onClick={() => onMove(column.key, 1)} aria-label={`Move ${label} down`}>↓</button>
              </div>
            </div>
          );
        })}
      </div>
      <button type="button" className="text-button reset-columns" onClick={onReset}>Reset original layout</button>
    </div>
  );
}
