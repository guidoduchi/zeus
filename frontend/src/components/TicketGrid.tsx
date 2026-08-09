import type { ColumnDefinition, TicketSummary } from "../types";
import { WorkspaceGrid, type WorkspaceGridRow } from "./WorkspaceGrid";

interface Props {
  tickets: TicketSummary[];
  columns: ColumnDefinition[];
  selectedRowId: string | null;
  draftTicketIds?: ReadonlySet<string>;
  detailOpen: boolean;
  onHighlight: (ticketId: string) => void;
  onOpen: (ticketId: string) => void;
  onCloseDetail: () => void;
}

export function TicketGrid({
  tickets,
  columns,
  selectedRowId,
  draftTicketIds,
  detailOpen,
  onHighlight,
  onOpen,
  onCloseDetail,
}: Props) {
  return (
    <WorkspaceGrid
      rows={tickets.map((ticket) => ({
        ...ticket,
        rowId: ticket.ticketId,
      } as TicketSummary & WorkspaceGridRow))}
      columns={columns}
      selectedRowId={selectedRowId}
      ariaLabel="Zeus service requests"
      emptyTitle="No matching Zeus ticket records."
      emptyHint="Check the configured Advanced Search source to discover new service requests."
      countLabel="service request(s)"
      draftTicketIds={draftTicketIds}
      detailOpen={detailOpen}
      selectionLabel={(ticket) => `SR ${ticket.ticketId}${ticket.summary ? ` · ${ticket.summary}` : ""}`}
      onHighlight={(ticket) => onHighlight(ticket.ticketId)}
      onOpen={(ticket) => onOpen(ticket.ticketId)}
      onCloseDetail={onCloseDetail}
    />
  );
}
