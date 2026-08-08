import type { StoredDraft, TicketDraftKind } from "./drafts";
import type { SpareDevice, SparePart, TicketDetail } from "./types";

export const WORK_FIELDS = [
  "Planned Date",
  "Site",
  "Cloud",
  "RelatedSR",
  "Done?",
  "Notes",
] as const;

export type WorkField = typeof WORK_FIELDS[number];
export type WorkDraft = Record<string, string>;
export type DraftPart = Record<keyof SparePart, string>;

export interface DraftDevice {
  device: string;
  model: string;
  parts: DraftPart[];
}

export interface DraftAnalysis {
  kind: TicketDraftKind;
  changedFields: string[];
  conflictFields: string[];
  changes: Record<string, unknown>;
  rebased: StoredDraft<unknown, unknown>;
}

export function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function draftValue(field: string, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (field === "Planned Date") {
    const match = String(value).trim().match(/^(\d{4}-\d{2}-\d{2})/);
    return match?.[1] || "";
  }
  return String(value);
}

export function workFieldValues(ticket: TicketDetail): WorkDraft {
  return Object.fromEntries(
    WORK_FIELDS.map((field) => [field, draftValue(field, ticket.localFields[field])]),
  );
}

export function changedWorkFields(
  ticket: TicketDetail,
  draft: WorkDraft,
): Record<string, unknown> {
  return Object.fromEntries(
    WORK_FIELDS
      .filter((field) => draftValue(field, ticket.localFields[field]) !== String(draft[field] ?? ""))
      .map((field) => [field, draft[field] === "" ? null : draft[field]]),
  );
}

export function emptyPart(): DraftPart {
  return { slot: "", part: "", bom: "", faulty_sn: "", new_sn: "" };
}

export function spareDraft(value: SpareDevice[]): DraftDevice[] {
  return value.map((device) => ({
    device: device.device || "",
    model: device.model || "",
    parts: device.parts.map((part) => ({
      slot: part.slot || "",
      part: part.part || "",
      bom: part.bom || "",
      faulty_sn: part.faulty_sn || "",
      new_sn: part.new_sn || "",
    })),
  }));
}

export function cleanSpareParts(value: DraftDevice[] | SpareDevice[]): SpareDevice[] {
  return value.flatMap((device) => {
    const parts = device.parts.flatMap((part) => {
      const cleaned: SparePart = {
        slot: String(part.slot || "").trim() || null,
        part: String(part.part || "").trim() || null,
        bom: String(part.bom || "").trim() || null,
        faulty_sn: String(part.faulty_sn || "").trim() || null,
        new_sn: String(part.new_sn || "").trim() || null,
      };
      return Object.values(cleaned).some(Boolean) ? [cleaned] : [];
    });
    const cleaned: SpareDevice = {
      device: String(device.device || "").trim() || null,
      model: String(device.model || "").trim() || null,
      parts,
    };
    return cleaned.device || cleaned.model || cleaned.parts.length ? [cleaned] : [];
  });
}

export function displayDraftField(field: string): string {
  if (field === "Done?") return "MW";
  if (field === "Spare Parts") return "Spare Parts";
  return field;
}

export function analyzeTicketDraft(
  ticket: TicketDetail,
  kind: TicketDraftKind,
  raw: StoredDraft<unknown, unknown>,
): DraftAnalysis | null {
  if (kind === "work") {
    if (!raw.value || typeof raw.value !== "object" || Array.isArray(raw.value)) return null;
    if (!raw.baseValue || typeof raw.baseValue !== "object" || Array.isArray(raw.baseValue)) return null;
    const current = workFieldValues(ticket);
    const value = raw.value as WorkDraft;
    const base = raw.baseValue as WorkDraft;
    const changedFields = WORK_FIELDS.filter((field) => String(value[field] ?? "") !== String(base[field] ?? ""));
    if (!changedFields.length) return null;
    const conflictFields = changedFields.filter((field) => String(current[field] ?? "") !== String(base[field] ?? ""));
    const rebasedValue: WorkDraft = { ...current };
    for (const field of changedFields) rebasedValue[field] = String(value[field] ?? "");
    const changes = changedWorkFields(ticket, rebasedValue);
    if (!Object.keys(changes).length) return null;
    return {
      kind,
      changedFields: [...changedFields],
      conflictFields,
      changes,
      rebased: {
        revision: ticket.revision,
        baseValue: current,
        value: rebasedValue,
        updatedAt: raw.updatedAt,
      },
    };
  }

  if (!Array.isArray(raw.value) || !Array.isArray(raw.baseValue)) return null;
  const value = raw.value as DraftDevice[];
  const base = cleanSpareParts(raw.baseValue as SpareDevice[]);
  const current = cleanSpareParts(ticket.spareParts);
  const cleaned = cleanSpareParts(value);
  if (sameValue(cleaned, base)) return null;
  if (sameValue(cleaned, current)) return null;
  return {
    kind,
    changedFields: ["Spare Parts"],
    conflictFields: sameValue(current, base) ? [] : ["Spare Parts"],
    changes: { "Spare Parts": cleaned },
    rebased: {
      revision: ticket.revision,
      baseValue: current,
      value,
      updatedAt: raw.updatedAt,
    },
  };
}
