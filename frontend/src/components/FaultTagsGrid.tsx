import type { ColumnDefinition, FaultTagSummary } from "../types";
import { WorkspaceGrid, type WorkspaceGridRow } from "./WorkspaceGrid";

interface Props {
  rows: FaultTagSummary[];
  columns: ColumnDefinition[];
  selectedRowId: string | null;
  detailOpen: boolean;
  onHighlight: (row: FaultTagSummary) => void;
  onOpen: (row: FaultTagSummary) => void;
  onCloseDetail: () => void;
}

export function FaultTagsGrid({ rows, columns, selectedRowId, detailOpen, onHighlight, onOpen, onCloseDetail }: Props) {
  return (
    <WorkspaceGrid
      rows={rows.map((row) => ({ ...row, ticketId: "", risk: "none" } as FaultTagSummary & WorkspaceGridRow))}
      columns={columns}
      selectedRowId={selectedRowId}
      ariaLabel="Zeus Fault Tags"
      emptyTitle="No active Fault Tags."
      emptyHint="Confirm Spare replaced items in Active Requests, then export a Fault Tag batch."
      countLabel="active Fault Tag(s)"
      detailOpen={detailOpen}
      selectionLabel={(row) => `${row.memberCount} item(s) · ${row.statusLabel}`}
      onHighlight={onHighlight}
      onOpen={onOpen}
      onCloseDetail={onCloseDetail}
    />
  );
}
