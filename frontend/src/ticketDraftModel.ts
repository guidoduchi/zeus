import type { StoredDraft, TicketDraftKind } from "./drafts";
import type { SpareDevice, TicketDetail } from "./types";

export const WORK_FIELDS = [
  "Planned Date",
  "Maintenance Window Start Time",
  "Site",
  "Cloud",
  "RelatedSR",
  "Done?",
  "Notes",
] as const;

export type WorkField = typeof WORK_FIELDS[number];
export type WorkDraft = Record<string, string>;
export interface DraftPart {
  part_number: number;
  slot: string;
  part: string;
  bom: string;
  notes: string;
  /** Hidden compatibility value; the Spare Request lifecycle owns new SNs. */
  new_sn: string;
  submitted_request_ids: string[];
  submitted: boolean;
  active_request_ids: string[];
}

export interface DraftDevice {
  device_number: number;
  device: string;
  model: string;
  notes: string;
  faulty_sns: string;
  next_part_number: number;
  active_request_ids: string[];
  has_submitted_parts: boolean;
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
    WORK_FIELDS.map((field) => [field, draftValue(
      field,
      field === "Maintenance Window Start Time"
        ? ticket.maintenanceWindow?.startTime
        : ticket.localFields[field],
    )]),
  );
}

export function changedWorkFields(
  ticket: TicketDetail,
  draft: WorkDraft,
): Record<string, unknown> {
  return Object.fromEntries(
    WORK_FIELDS
      .filter((field) => draftValue(
        field,
        field === "Maintenance Window Start Time"
          ? ticket.maintenanceWindow?.startTime
          : ticket.localFields[field],
      ) !== String(draft[field] ?? ""))
      .map((field) => [field, draft[field] === "" ? null : draft[field]]),
  );
}

export function emptyPart(partNumber = 1): DraftPart {
  return {
    part_number: partNumber,
    slot: "",
    part: "",
    bom: "",
    notes: "",
    new_sn: "",
    submitted_request_ids: [],
    submitted: false,
    active_request_ids: [],
  };
}

export function newlineValues(value: unknown): string[] {
  const raw = (Array.isArray(value) ? value : [value]).flatMap((candidate) =>
    String(candidate || "").split(/\r?\n/)
  );
  const values: string[] = [];
  const seen = new Set<string>();
  for (const candidate of raw) {
    const text = String(candidate || "").trim();
    const key = text.toLocaleLowerCase();
    if (text && !seen.has(key)) {
      seen.add(key);
      values.push(text);
    }
  }
  return values;
}

export function requestedQuantity(slot: unknown): number {
  return Math.max(1, newlineValues(slot).length);
}

export function spareDraft(value: SpareDevice[]): DraftDevice[] {
  return value.map((device, deviceIndex) => ({
    device_number: Number(device.device_number || deviceIndex + 1),
    device: device.device || "",
    model: device.model || "",
    notes: device.notes || "",
    faulty_sns: newlineValues([
      ...(device.faulty_sns || []),
      ...device.parts.flatMap((part) => newlineValues(part.faulty_sn)),
    ]).join("\n"),
    next_part_number: Math.max(
      Number(device.next_part_number || 1),
      ...device.parts.map((part, partIndex) => Number(part.part_number || partIndex + 1) + 1),
    ),
    active_request_ids: [...(device.active_request_ids || [])],
    has_submitted_parts: Boolean(device.has_submitted_parts),
    parts: device.parts.map((part, partIndex) => ({
      part_number: Number(part.part_number || partIndex + 1),
      slot: part.slot || "",
      part: part.part || "",
      bom: part.bom || "",
      notes: part.notes || "",
      new_sn: part.new_sn || "",
      submitted_request_ids: [...(part.submitted_request_ids || [])],
      submitted: Boolean(part.submitted || part.submitted_request_ids?.length),
      active_request_ids: [...(part.active_request_ids || [])],
    })),
  }));
}

export function cleanSpareParts(value: DraftDevice[] | SpareDevice[]): SpareDevice[] {
  return value.flatMap((device, deviceIndex) => {
    const parts = device.parts.flatMap((part) => {
      const cleaned = {
        part_number: Number(part.part_number || 1),
        slot: newlineValues(part.slot).join("\n") || null,
        part: String(part.part || "").trim() || null,
        bom: String(part.bom || "").trim() || null,
        notes: String(part.notes || "").trim() || null,
        new_sn: String(part.new_sn || "").trim() || null,
        submitted_request_ids: [...new Set(
          ("submitted_request_ids" in part ? part.submitted_request_ids || [] : [])
            .filter((requestId) => /^\d{12}$/.test(String(requestId))),
        )],
      };
      return Object.entries(cleaned).some(([key, candidate]) => (
        key === "part_number" ? false : Array.isArray(candidate) ? candidate.length > 0 : Boolean(candidate)
      )) ? [cleaned] : [];
    });
    const cleaned: SpareDevice = {
      device_number: Number(device.device_number || deviceIndex + 1),
      device: String(device.device || "").trim() || null,
      model: String(device.model || "").trim() || null,
      notes: String(("notes" in device ? device.notes : "") || "").trim() || null,
      faulty_sns: newlineValues(
        "faulty_sns" in device ? device.faulty_sns : "",
      ),
      next_part_number: Math.max(
        Number(("next_part_number" in device ? device.next_part_number : 1) || 1),
        ...parts.map((part) => Number(part.part_number || 0) + 1),
      ),
      parts,
    };
    return cleaned.device || cleaned.model || cleaned.notes || cleaned.faulty_sns?.length || cleaned.parts.length ? [cleaned] : [];
  });
}

export function displayDraftField(field: string): string {
  if (field === "Planned Date" || field === "Done?" || field === "Maintenance Window Start Time") return "Maintenance Window";
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
