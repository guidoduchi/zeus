import type { ColumnDefinition, SparePartSummary } from "../types";
import { WorkspaceGrid, type WorkspaceGridRow } from "./WorkspaceGrid";

interface Props {
  rows: SparePartSummary[];
  columns: ColumnDefinition[];
  selectedRowId: string | null;
  draftTicketIds?: ReadonlySet<string>;
  detailOpen: boolean;
  onHighlight: (row: SparePartSummary) => void;
  onOpen: (row: SparePartSummary) => void;
  onCloseDetail: () => void;
}

export function SparePartsGrid({
  rows,
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
      rows={rows as Array<SparePartSummary & WorkspaceGridRow>}
      columns={columns}
      selectedRowId={selectedRowId}
      ariaLabel="Zeus spare parts"
      emptyTitle="No matching spare-parts records."
      emptyHint="Add affected devices and any replacement parts from an SR's Work Fields or Spare Parts editor."
      countLabel="part row(s)"
      draftTicketIds={draftTicketIds}
      detailOpen={detailOpen}
      selectionLabel={(row) => `SR ${row.ticketId}${row.part ? ` · ${row.part}` : ""}${row.slot ? ` · ${row.slot}` : ""}`}
      onHighlight={onHighlight}
      onOpen={onOpen}
      onCloseDetail={onCloseDetail}
    />
  );
}
