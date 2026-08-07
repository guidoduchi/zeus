import { useEffect, useMemo, useRef } from "react";
import type { ColumnDefinition, TicketSummary } from "../types";

interface Props {
  tickets: TicketSummary[];
  columns: ColumnDefinition[];
  selectedId: string | null;
  onSelect: (ticketId: string) => void;
  onCloseDetail: () => void;
}

function displayValue(ticket: TicketSummary, key: string): string {
  if (key === "risk") return "";
  const value = (ticket as unknown as Record<string, unknown>)[key];
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function displayTone(ticket: TicketSummary, key: string): string {
  if (key === "plannedDate") return ticket.plannedColor || "none";
  if (key === "ticketAgeDays") return ticket.ticketAgeColor || "none";
  if (key === "emailLabel") return ticket.emailColor || "none";
  return "none";
}

export function TicketGrid({
  tickets,
  columns,
  selectedId,
  onSelect,
  onCloseDetail,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const gridTemplate = useMemo(
    () => columns.map((column) => column.flex ? `minmax(${column.width}px, 1fr)` : `${column.width}px`).join(" "),
    [columns],
  );
  const selectedIndex = selectedId ? tickets.findIndex((ticket) => ticket.ticketId === selectedId) : -1;

  useEffect(() => {
    if (selectedId) rowRefs.current.get(selectedId)?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  function moveSelection(index: number) {
    if (!tickets.length) return;
    const bounded = Math.max(0, Math.min(tickets.length - 1, index));
    onSelect(tickets[bounded].ticketId);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const current = selectedIndex >= 0 ? selectedIndex : 0;
    if (event.key === "ArrowDown") moveSelection(current + 1);
    else if (event.key === "ArrowUp") moveSelection(current - 1);
    else if (event.key === "PageDown") moveSelection(current + 12);
    else if (event.key === "PageUp") moveSelection(current - 12);
    else if (event.key === "Home") moveSelection(0);
    else if (event.key === "End") moveSelection(tickets.length - 1);
    else if (event.key === "Enter" && tickets[current]) onSelect(tickets[current].ticketId);
    else if (event.key === "Escape") onCloseDetail();
    else return;
    event.preventDefault();
  }

  return (
    <section className="ticket-grid" aria-label="Zeus tickets">
      <div className="grid-header" style={{ gridTemplateColumns: gridTemplate }} role="row">
        {columns.map((column) => <div role="columnheader" key={column.key}>{column.label}</div>)}
      </div>
      <div
        className="ticket-scroll"
        data-testid="dashboard-scroll"
        ref={scrollRef}
        role="grid"
        aria-rowcount={tickets.length}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        {tickets.length === 0 ? (
          <div className="empty-grid">
            <strong>No matching Markdown ticket records.</strong>
            <span>Configure or query Pendings.xlsx to build the dashboard.</span>
          </div>
        ) : tickets.map((ticket) => {
          const selected = ticket.ticketId === selectedId;
          return (
            <button
              type="button"
              role="row"
              data-ticket-id={ticket.ticketId}
              aria-selected={selected}
              className={`ticket-row ${selected ? "selected" : ""}`}
              style={{ gridTemplateColumns: gridTemplate }}
              key={ticket.ticketId}
              ref={(element) => {
                if (element) rowRefs.current.set(ticket.ticketId, element);
                else rowRefs.current.delete(ticket.ticketId);
              }}
              onClick={() => onSelect(ticket.ticketId)}
            >
              {columns.map((column) => (
                <span
                  role="gridcell"
                  className={`ticket-cell column-${column.key} tone-${displayTone(ticket, column.key)}`}
                  title={displayValue(ticket, column.key)}
                  key={column.key}
                >
                  {column.key === "risk" ? <i className={`risk-mark risk-${ticket.risk}`} aria-label={`${ticket.risk} risk`} /> : displayValue(ticket, column.key)}
                </span>
              ))}
            </button>
          );
        })}
      </div>
      <div className="grid-status">
        <span>{tickets.length} ticket(s)</span>
        <span>Wheel scrolls this list</span>
      </div>
    </section>
  );
}
