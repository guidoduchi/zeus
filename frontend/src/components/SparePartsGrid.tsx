import type { ColumnDefinition, SparePartSummary } from "../types";
import { WorkspaceGrid, type WorkspaceGridRow } from "./WorkspaceGrid";

interface Props {
  rows: SparePartSummary[];
  columns: ColumnDefinition[];
  selectedRowId: string | null;
  draftTicketIds?: ReadonlySet<string>;
  onSelect: (row: SparePartSummary) => void;
  onCloseDetail: () => void;
}

export function SparePartsGrid({
  rows,
  columns,
  selectedRowId,
  draftTicketIds,
  onSelect,
  onCloseDetail,
}: Props) {
  return (
    <WorkspaceGrid
      rows={rows as Array<SparePartSummary & WorkspaceGridRow>}
      columns={columns}
      selectedRowId={selectedRowId}
      ariaLabel="Zeus spare parts"
      emptyTitle="No matching spare-parts records."
      emptyHint="Add damaged devices and parts from an SR's Spare Parts editor."
      countLabel="part row(s)"
      draftTicketIds={draftTicketIds}
      onSelect={onSelect}
      onCloseDetail={onCloseDetail}
    />
  );
}
