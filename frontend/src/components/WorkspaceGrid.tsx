import { useEffect, useMemo, useRef } from "react";
import type { ColumnDefinition, Risk } from "../types";

export interface WorkspaceGridRow {
  rowId: string;
  ticketId: string;
  risk: Risk;
  readOnly?: boolean;
  [key: string]: unknown;
}

interface Props<Row extends WorkspaceGridRow> {
  rows: Row[];
  columns: ColumnDefinition[];
  selectedRowId: string | null;
  ariaLabel: string;
  emptyTitle: string;
  emptyHint: string;
  countLabel: string;
  draftTicketIds?: ReadonlySet<string>;
  onSelect: (row: Row) => void;
  onCloseDetail: () => void;
}

function displayValue(row: WorkspaceGridRow, key: string): string {
  if (key === "risk") return "";
  const value = row[key];
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function displayTone(row: WorkspaceGridRow, key: string): string {
  const establishedKeys: Record<string, string> = {
    plannedDate: "plannedColor",
    ticketAgeDays: "ticketAgeColor",
    emailLabel: "emailColor",
    status: "lifecycleColor",
    statusLabel: "lifecycleColor",
    dispatchAgeDays: "dispatchAgeColor",
  };
  const value = row[establishedKeys[key] || `${key}Color`];
  return value === "red" || value === "yellow" || value === "grey" || value === "green" || value === "black" ? String(value) : "none";
}

export function WorkspaceGrid<Row extends WorkspaceGridRow>({
  rows,
  columns,
  selectedRowId,
  ariaLabel,
  emptyTitle,
  emptyHint,
  countLabel,
  draftTicketIds,
  onSelect,
  onCloseDetail,
}: Props<Row>) {
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const gridTemplate = useMemo(
    () => columns.map((column) => column.flex ? `minmax(${column.width}px, 1fr)` : `${column.width}px`).join(" "),
    [columns],
  );
  const selectedIndex = selectedRowId ? rows.findIndex((row) => row.rowId === selectedRowId) : -1;

  useEffect(() => {
    if (selectedRowId) rowRefs.current.get(selectedRowId)?.scrollIntoView({ block: "nearest" });
  }, [selectedRowId]);

  function moveSelection(index: number) {
    if (!rows.length) return;
    const bounded = Math.max(0, Math.min(rows.length - 1, index));
    const row = rows[bounded];
    onSelect(row);
    window.requestAnimationFrame(() => {
      rowRefs.current.get(row.rowId)?.focus({ preventScroll: true });
    });
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const current = selectedIndex >= 0 ? selectedIndex : 0;
    if (event.key === "ArrowDown") moveSelection(current + 1);
    else if (event.key === "ArrowUp") moveSelection(current - 1);
    else if (event.key === "PageDown") moveSelection(current + 12);
    else if (event.key === "PageUp") moveSelection(current - 12);
    else if (event.key === "Home") moveSelection(0);
    else if (event.key === "End") moveSelection(rows.length - 1);
    else if (event.key === "Enter" && rows[current]) onSelect(rows[current]);
    else if (event.key === "Escape") onCloseDetail();
    else return;
    event.preventDefault();
  }

  return (
    <section className="ticket-grid" aria-label={ariaLabel}>
      <div className="grid-header" style={{ gridTemplateColumns: gridTemplate }} role="row">
        {columns.map((column) => <div role="columnheader" key={column.key}>{column.label}</div>)}
      </div>
      <div
        className="ticket-scroll"
        data-testid="dashboard-scroll"
        role="grid"
        aria-rowcount={rows.length}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        {rows.length === 0 ? (
          <div className="empty-grid">
            <strong>{emptyTitle}</strong>
            <span>{emptyHint}</span>
          </div>
        ) : rows.map((row) => {
          const selected = row.rowId === selectedRowId;
          const hasDraft = Boolean(draftTicketIds?.has(row.ticketId));
          return (
            <button
              type="button"
              role="row"
              data-ticket-id={row.ticketId}
              data-row-id={row.rowId}
              aria-selected={selected}
              className={`ticket-row ${selected ? "selected" : ""} ${row.readOnly ? "archived" : ""} ${hasDraft ? "draft-protected" : ""}`}
              data-read-only={row.readOnly ? "true" : "false"}
              style={{ gridTemplateColumns: gridTemplate }}
              key={row.rowId}
              ref={(element) => {
                if (element) rowRefs.current.set(row.rowId, element);
                else rowRefs.current.delete(row.rowId);
              }}
              onClick={() => onSelect(row)}
            >
              {columns.map((column) => (
                <span
                  role="gridcell"
                  className={`ticket-cell column-${column.key} tone-${displayTone(row, column.key)}`}
                  title={displayValue(row, column.key)}
                  key={column.key}
                >
                  {column.key === "risk" ? <i className={`risk-mark risk-${row.risk}`} aria-label={`${row.risk} risk`} /> : <>{displayValue(row, column.key)}{column.key === "ticketId" && hasDraft && <i className="draft-mark" aria-label="Protected draft" title="This SR has protected unsaved changes">✎</i>}</>}
                </span>
              ))}
            </button>
          );
        })}
      </div>
      <div className="grid-status">
        <span>{rows.length} {countLabel}</span>
        <span>Wheel scrolls this list</span>
      </div>
    </section>
  );
}
