import type { ColumnDefinition, TicketSummary } from "../types";
import { WorkspaceGrid, type WorkspaceGridRow } from "./WorkspaceGrid";

interface Props {
  tickets: TicketSummary[];
  columns: ColumnDefinition[];
  selectedId: string | null;
  onSelect: (ticketId: string) => void;
  onCloseDetail: () => void;
}

export function TicketGrid({
  tickets,
  columns,
  selectedId,
  onSelect,
  onCloseDetail,
}: Props) {
  return (
    <WorkspaceGrid
      rows={tickets.map((ticket) => ({
        ...ticket,
        rowId: ticket.ticketId,
      } as TicketSummary & WorkspaceGridRow))}
      columns={columns}
      selectedRowId={selectedId}
      ariaLabel="Zeus service requests"
      emptyTitle="No matching Zeus ticket records."
      emptyHint="Check the configured Advanced Search source to discover new service requests."
      countLabel="service request(s)"
      onSelect={(ticket) => onSelect(ticket.ticketId)}
      onCloseDetail={onCloseDetail}
    />
  );
}
