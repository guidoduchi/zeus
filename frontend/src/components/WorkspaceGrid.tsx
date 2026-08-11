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
  const gridTemplate = useMemo(
    () => columns.map((column) => column.flex ? `minmax(${column.width}px, 1fr)` : `${column.width}px`).join(" "),
    [columns],
  );
  const selectedIndex = selectedRowId ? rows.findIndex((row) => row.rowId === selectedRowId) : -1;
  const selectedRow = selectedIndex >= 0 ? rows[selectedIndex] : null;

  useEffect(() => {
    if (selectedRowId) rowRefs.current.get(selectedRowId)?.scrollIntoView({ block: "nearest" });
  }, [selectedRowId]);

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
        data-testid="dashboard-scroll"
        role="grid"
        aria-rowcount={rows.length}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        <div className="grid-header" style={{ gridTemplateColumns: gridTemplate }} role="row">
          {columns.map((column) => <div role="columnheader" key={column.key}>{column.label}</div>)}
        </div>
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
                      <span>{displayValue(row, column.key)}</span>
                      <i className="email-direction-badge received" aria-label={`${directionalEmailCount(row, "received")} received email(s)`}>▼{directionalEmailCount(row, "received")}</i>
                      <i className="email-direction-badge sent" aria-label={`${directionalEmailCount(row, "sent")} sent email(s)`}>▲{directionalEmailCount(row, "sent")}</i>
                    </span>
                  ) : column.key === "spareBadges" ? (
                    <span className="spare-counts" aria-label="Spare-parts unit counts">
                      {Number((row.spareBadges as { eligible?: number } | undefined)?.eligible || 0) > 0 && <i className="spare-count eligible" title="Eligible / not created">{Number((row.spareBadges as { eligible?: number }).eligible)}</i>}
                      {Number((row.spareBadges as { active?: number } | undefined)?.active || 0) > 0 && <i className={`spare-count active ${(row.spareBadges as { activeColor?: string }).activeColor === "red" ? "overdue" : ""}`} title="Active">{Number((row.spareBadges as { active?: number }).active)}</i>}
                      {Number((row.spareBadges as { completed?: number } | undefined)?.completed || 0) > 0 && <i className="spare-count completed" title="Completed">{Number((row.spareBadges as { completed?: number }).completed)}</i>}
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
                  ) : <>{column.key === "ticketId" && onToggleBulk && <i role="checkbox" aria-checked={Boolean(bulkSelectedRowIds?.has(row.rowId))} className={`bulk-row-check ${bulkSelectedRowIds?.has(row.rowId) ? "checked" : ""}`} title="Select for bulk action" onClick={(event) => { event.stopPropagation(); onToggleBulk(row); }}>{bulkSelectedRowIds?.has(row.rowId) ? "✓" : ""}</i>}{displayValue(row, column.key)}{column.key === "ticketId" && hasDraft && <i className="draft-mark" aria-label="Protected draft" title="This SR has protected unsaved changes">✎</i>}</>}
                </span>
              ))}
            </button>
          );
        })}
      </div>
      <div className="grid-status">
        <span>{rows.length} {countLabel}</span>
        {!detailOpen && <span>{selectedRow ? selectionLabel(selectedRow) : rows.length ? "No row highlighted · ↑↓ selects" : "No rows available in this view"}</span>}
      </div>
    </section>
  );
}
