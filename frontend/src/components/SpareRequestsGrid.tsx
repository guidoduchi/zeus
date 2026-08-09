import type { ColumnDefinition, SpareRequestItemSummary } from "../types";
import { WorkspaceGrid, type WorkspaceGridRow } from "./WorkspaceGrid";

interface Props {
  rows: SpareRequestItemSummary[];
  columns: ColumnDefinition[];
  selectedRowId: string | null;
  detailOpen: boolean;
  onHighlight: (row: SpareRequestItemSummary) => void;
  onOpen: (row: SpareRequestItemSummary) => void;
  onCloseDetail: () => void;
}

export function SpareRequestsGrid({ rows, columns, selectedRowId, detailOpen, onHighlight, onOpen, onCloseDetail }: Props) {
  return (
    <WorkspaceGrid
      rows={rows as Array<SpareRequestItemSummary & WorkspaceGridRow>}
      columns={columns}
      selectedRowId={selectedRowId}
      ariaLabel="Zeus Spare Requests"
      emptyTitle="No matching Spare Request items."
      emptyHint="Export a request from an eligible SR part or create one manually."
      countLabel="unit item(s)"
      detailOpen={detailOpen}
      selectionLabel={(row) => `TT ${row.ticketId}${row.part ? ` · ${row.part}` : ""}`}
      onHighlight={onHighlight}
      onOpen={onOpen}
      onCloseDetail={onCloseDetail}
    />
  );
}
