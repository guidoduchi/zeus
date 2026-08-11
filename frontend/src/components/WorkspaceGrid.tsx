import { useEffect, useMemo, useRef } from "react";
import { maintenanceWindowLabel } from "../maintenanceWindow";
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
  detailOpen: boolean;
  selectionLabel: (row: Row) => string;
  onHighlight: (row: Row) => void;
  onOpen: (row: Row) => void;
  onCloseDetail: () => void;
  bulkSelectedRowIds?: ReadonlySet<string>;
  onToggleBulk?: (row: Row) => void;
}

function displayValue(row: WorkspaceGridRow, key: string): string {
  if (key === "risk") return "";
  const value = row[key];
  if (key === "done") {
    const window = row.maintenanceWindow;
    if (window && typeof window === "object" && "display" in window) {
      return String((window as { display?: unknown }).display || maintenanceWindowLabel(value));
    }
    return maintenanceWindowLabel(value);
  }
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function displayTone(row: WorkspaceGridRow, key: string): string {
  if (key === "trackingId" && row.trackingIdProvisional) return "red";
  if (key === "done" && row.maintenanceWindow && typeof row.maintenanceWindow === "object") {
    const color = (row.maintenanceWindow as { color?: unknown }).color;
    return color === "red" || color === "yellow" || color === "grey" || color === "green"
      ? color
      : "none";
  }
  const establishedKeys: Record<string, string> = {
    done: "plannedColor",
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

function lifecycleStage(row: WorkspaceGridRow): number {
  const value = Number(row.lifecycleStage);
  return Number.isFinite(value) ? Math.max(0, Math.min(6, Math.floor(value))) : 0;
}

function directionalEmailCount(row: WorkspaceGridRow, key: "received" | "sent"): number {
  const value = Number(row[key]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function totalEmailCount(row: WorkspaceGridRow): number {
  const directional = directionalEmailCount(row, "received") + directionalEmailCount(row, "sent");
  const total = Number(row.emailCount);
  return Math.max(directional, Number.isFinite(total) && total > 0 ? Math.floor(total) : 0);
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
  detailOpen,
  selectionLabel,
  onHighlight,
  onOpen,
  onCloseDetail,
  bulkSelectedRowIds,
  onToggleBulk,
}: Props<Row>) {
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridTemplate = useMemo(
    () => columns.map((column) => column.flex ? `minmax(${column.width}px, 1fr)` : `${column.width}px`).join(" "),
    [columns],
  );
  const gridMinWidth = useMemo(
    () => columns.reduce((width, column) => width + column.width, 0),
    [columns],
  );
  const selectedIndex = selectedRowId ? rows.findIndex((row) => row.rowId === selectedRowId) : -1;
  const selectedRow = selectedIndex >= 0 ? rows[selectedIndex] : null;

  useEffect(() => {
    if (selectedRowId) rowRefs.current.get(selectedRowId)?.scrollIntoView({ block: "nearest" });
  }, [selectedRowId]);

  useEffect(() => {
    if (detailOpen && scrollRef.current) scrollRef.current.scrollLeft = 0;
  }, [detailOpen]);

  function moveSelection(index: number) {
    if (!rows.length) return;
    const bounded = Math.max(0, Math.min(rows.length - 1, index));
    const row = rows[bounded];
    onHighlight(row);
    window.requestAnimationFrame(() => {
      rowRefs.current.get(row.rowId)?.focus({ preventScroll: true });
    });
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const current = selectedIndex;
    if (event.key === "ArrowDown") moveSelection(current < 0 ? 0 : current + 1);
    else if (event.key === "ArrowUp") moveSelection(current < 0 ? rows.length - 1 : current - 1);
    else if (event.key === "PageDown") moveSelection(current < 0 ? 0 : current + 12);
    else if (event.key === "PageUp") moveSelection(current < 0 ? rows.length - 1 : current - 12);
    else if (event.key === "Home") moveSelection(0);
    else if (event.key === "End") moveSelection(rows.length - 1);
    else if (event.key === "Enter" && rows[current < 0 ? 0 : current]) onOpen(rows[current < 0 ? 0 : current]);
    else if (event.key === " ") { /* Row activation is deliberately double-click/Enter only. */ }
    else if (event.key === "Escape" && detailOpen) onCloseDetail();
    else return;
    event.preventDefault();
  }

  return (
    <section className="ticket-grid" aria-label={ariaLabel}>
      <div
        className="ticket-scroll"
        ref={scrollRef}
        data-testid="dashboard-scroll"
        role="grid"
        aria-rowcount={rows.length}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        <div className="grid-table" style={{ minWidth: `${gridMinWidth}px` }}>
          <div className="grid-header" style={{ gridTemplateColumns: gridTemplate }} role="row">
            {columns.map((column) => (
              <div role="columnheader" key={column.key}>
                {column.key === "emailLabel" ? (
                  <span className="email-header">
                    <span>{column.label}</span>
                    <i className="received" aria-label="Received email count">▼</i>
                    <i className="sent" aria-label="Sent email count">▲</i>
                  </span>
                ) : column.label}
              </div>
            ))}
          </div>
          {rows.length === 0 ? (
            <div className="empty-grid">
              <strong>{emptyTitle}</strong>
              <span>{emptyHint}</span>
            </div>
          ) : rows.map((row) => {
          const selected = row.rowId === selectedRowId;
          const hasDraft = Boolean(draftTicketIds?.has(row.ticketId));
          const received = directionalEmailCount(row, "received");
          const sent = directionalEmailCount(row, "sent");
          const emailTotal = totalEmailCount(row);
          return (
            <button
              type="button"
              role="row"
              data-ticket-id={row.ticketId}
              data-row-id={row.rowId}
              aria-selected={selected}
              className={`ticket-row ${selected ? "selected" : ""} ${row.readOnly ? "archived" : ""} ${hasDraft ? "draft-protected" : ""} ${row.lifecycleStage === 4 && row.returnCondition === "Faulty" ? "return-faulty" : ""} ${row.lifecycleStage === 4 && row.returnCondition === "New" ? "return-new" : ""}`}
              data-read-only={row.readOnly ? "true" : "false"}
              style={{ gridTemplateColumns: gridTemplate }}
              key={row.rowId}
              ref={(element) => {
                if (element) rowRefs.current.set(row.rowId, element);
                else rowRefs.current.delete(row.rowId);
              }}
              onClick={() => onHighlight(row)}
              onDoubleClick={() => onOpen(row)}
            >
              {columns.map((column) => (
                <span
                  role="gridcell"
                  className={`ticket-cell column-${column.key} tone-${displayTone(row, column.key)}`}
                  title={column.key === "emailLabel"
                    ? `${displayValue(row, column.key)} · ${directionalEmailCount(row, "received")} received · ${directionalEmailCount(row, "sent")} sent`
                    : displayValue(row, column.key)}
                  key={column.key}
                >
                  {column.key === "risk" ? (
                    <i className={`risk-mark risk-${row.risk}`} aria-label={`${row.risk} risk`} />
                  ) : column.key === "emailLabel" ? (
                    <span className="email-fact">
                      <span>{emailTotal === 0 ? "No email" : displayValue(row, column.key)}</span>
                      {emailTotal === 0 ? (
                        <i className="email-count-badge zero" aria-label="0 total emails">0</i>
                      ) : (
                        <>
                          <i className={`email-count-badge received ${received === 0 ? "empty" : ""}`} aria-label={`${received} received email(s)`}>{received}</i>
                          <i className={`email-count-badge sent ${sent === 0 ? "empty" : ""}`} aria-label={`${sent} sent email(s)`}>{sent}</i>
                        </>
                      )}
                    </span>
                  ) : column.key === "spareBadges" ? (
                    <span className="spare-counts" aria-label="Spare-parts unit counts">
                      {Number((row.spareBadges as { pendingDispatch?: number } | undefined)?.pendingDispatch || 0) > 0 && <i className="spare-count pending" title="Eligible or not yet dispatched">{Number((row.spareBadges as { pendingDispatch?: number }).pendingDispatch)}</i>}
                      {Number((row.spareBadges as { dispatched?: number } | undefined)?.dispatched || 0) > 0 && <i className="spare-count dispatched" title="Dispatched, below overdue threshold">{Number((row.spareBadges as { dispatched?: number }).dispatched)}</i>}
                      {Number((row.spareBadges as { overdue?: number } | undefined)?.overdue || 0) > 0 && <i className="spare-count overdue" title="Dispatched and overdue">{Number((row.spareBadges as { overdue?: number }).overdue)}</i>}
                      {Number((row.spareBadges as { returned?: number } | undefined)?.returned || 0) > 0 && <i className="spare-count returned" title="Warehouse evidence or completed return">{Number((row.spareBadges as { returned?: number }).returned)}</i>}
                    </span>
                  ) : column.key === "trackingId" ? (
                    <span className={`tracking-identity ${row.trackingIdProvisional ? "provisional" : "confirmed"}`}>
                      {displayValue(row, column.key)}
                    </span>
                  ) : column.key === "lifecycleStage" ? (
                    <span className="lifecycle-meter" aria-label={`Stage ${lifecycleStage(row)} of 6: ${String(row.lifecycleStageLabel || "Added to Zeus")}`}>
                      <span className="lifecycle-pips" aria-hidden="true">
                        {Array.from({ length: 7 }, (_, index) => <i className={`${index <= lifecycleStage(row) ? "reached" : ""} ${index === lifecycleStage(row) ? "current" : ""}`} key={index} />)}
                      </span>
                      <span>{String(row.lifecycleStageLabel || "Added to Zeus")}</span>
                    </span>
                  ) : column.key === "ticketId" ? (
                    <span className={`ticket-identity ${onToggleBulk ? "selectable" : ""}`}>
                      {onToggleBulk && <i role="checkbox" aria-checked={Boolean(bulkSelectedRowIds?.has(row.rowId))} className={`bulk-row-check ${bulkSelectedRowIds?.has(row.rowId) ? "checked" : ""}`} title="Select for bulk action" onClick={(event) => { event.stopPropagation(); onToggleBulk(row); }}>{bulkSelectedRowIds?.has(row.rowId) ? "✓" : ""}</i>}
                      <span>{displayValue(row, column.key)}</span>
                      {hasDraft && <i className="draft-mark" aria-label="Protected draft" title="This SR has protected unsaved changes">✎</i>}
                    </span>
                  ) : displayValue(row, column.key)}
                </span>
              ))}
            </button>
          );
          })}
        </div>
      </div>
      <div className="grid-status">
        <span>{rows.length} {countLabel}</span>
        {!detailOpen && <span>{selectedRow ? selectionLabel(selectedRow) : rows.length ? "No row highlighted · ↑↓ selects" : "No rows available in this view"}</span>}
      </div>
    </section>
  );
}
