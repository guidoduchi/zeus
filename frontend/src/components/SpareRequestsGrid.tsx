import type { ColumnDefinition, SpareRequestItemSummary } from "../types";
import { WorkspaceGrid, type WorkspaceGridRow } from "./WorkspaceGrid";

interface Props {
  rows: SpareRequestItemSummary[];
  columns: ColumnDefinition[];
  selectedRowId: string | null;
  onSelect: (row: SpareRequestItemSummary) => void;
  onCloseDetail: () => void;
}

export function SpareRequestsGrid({ rows, columns, selectedRowId, onSelect, onCloseDetail }: Props) {
  return (
    <WorkspaceGrid
      rows={rows as Array<SpareRequestItemSummary & WorkspaceGridRow>}
      columns={columns}
      selectedRowId={selectedRowId}
      ariaLabel="Zeus Spare Requests"
      emptyTitle="No matching Spare Request items."
      emptyHint="Export a request from an eligible SR part or create one manually."
      countLabel="unit item(s)"
      onSelect={onSelect}
      onCloseDetail={onCloseDetail}
    />
  );
}
