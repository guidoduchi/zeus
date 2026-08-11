import type { SpareRequestDetail } from "./types";

export const ACTIVE_REQUEST_DRAFTS_CHANGED_EVENT = "zeus:active-request-drafts-changed";

const STORAGE_PREFIX = "zeus3.active-request-draft.";
const UNDO_PREFIX = "zeus3.active-request-draft-undo.";

export interface ActiveRequestItemDraft {
  rma: string;
  deliveredBom: string;
  newSn: string;
  notes: string;
}

export interface ActiveRequestDraftValue {
  ticketId: string;
  spareSr: string;
  note: string;
  items: Record<string, ActiveRequestItemDraft>;
}

export interface StoredActiveRequestDraft {
  revision: string;
  baseValue: ActiveRequestDraftValue;
  value: ActiveRequestDraftValue;
  updatedAt?: string;
}

export interface ActiveRequestDraftRecord {
  requestId: string;
  draft: StoredActiveRequestDraft;
}

export interface ActiveRequestDraftChanges {
  changes: Record<string, unknown>;
  itemUpdates: Array<Record<string, unknown>>;
  fields: string[];
}

export interface ActiveRequestDraftAnalysis extends ActiveRequestDraftChanges {
  conflictFields: string[];
  rebased: StoredActiveRequestDraft;
}

function draftKey(requestId: string): string {
  return `${STORAGE_PREFIX}${requestId}`;
}

function undoKey(requestId: string): string {
  return `${UNDO_PREFIX}${requestId}`;
}

function announceChange() {
  window.dispatchEvent(new CustomEvent(ACTIVE_REQUEST_DRAFTS_CHANGED_EVENT));
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

export function activeRequestDraftValue(request: SpareRequestDetail): ActiveRequestDraftValue {
  return {
    ticketId: request.ticketId,
    spareSr: request.spareSr || "",
    note: "",
    items: Object.fromEntries((request.items || []).map((item) => [item.item_id, {
      rma: item.rma || "",
      deliveredBom: item.delivered_bom || "",
      newSn: item.new_sn || "",
      notes: item.notes || "",
    }])),
  };
}

function validValue(value: unknown): value is ActiveRequestDraftValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ActiveRequestDraftValue>;
  return typeof candidate.ticketId === "string"
    && typeof candidate.spareSr === "string"
    && typeof candidate.note === "string"
    && Boolean(candidate.items)
    && typeof candidate.items === "object"
    && !Array.isArray(candidate.items);
}

export function readActiveRequestDraft(requestId: string): StoredActiveRequestDraft | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(draftKey(requestId)) || "null") as Partial<StoredActiveRequestDraft> | null;
    if (!parsed || typeof parsed.revision !== "string" || !validValue(parsed.baseValue) || !validValue(parsed.value)) return null;
    return parsed as StoredActiveRequestDraft;
  } catch {
    return null;
  }
}

export function listActiveRequestDrafts(): ActiveRequestDraftRecord[] {
  const records: ActiveRequestDraftRecord[] = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(STORAGE_PREFIX)) continue;
      const requestId = key.slice(STORAGE_PREFIX.length);
      if (!requestId) continue;
      const draft = readActiveRequestDraft(requestId);
      if (draft) records.push({ requestId, draft });
    }
  } catch {
    return [];
  }
  return records.sort((left, right) => left.requestId.localeCompare(right.requestId));
}

export function countActiveRequestDrafts(): number {
  return listActiveRequestDrafts().length;
}

export function writeActiveRequestDraft(
  requestId: string,
  draft: StoredActiveRequestDraft,
  options: { undoBase?: StoredActiveRequestDraft | null } = {},
) {
  try {
    if ("undoBase" in options) {
      localStorage.setItem(undoKey(requestId), JSON.stringify({
        previous: options.undoBase ?? null,
        updatedAt: new Date().toISOString(),
      }));
    }
    localStorage.setItem(draftKey(requestId), JSON.stringify({
      ...draft,
      updatedAt: new Date().toISOString(),
    }));
    announceChange();
  } catch {
    // Browser storage is a safety net; the live editor remains usable.
  }
}

export function clearActiveRequestDraft(requestId: string, options: { keepUndo?: boolean } = {}) {
  try {
    localStorage.removeItem(draftKey(requestId));
    if (!options.keepUndo) localStorage.removeItem(undoKey(requestId));
    announceChange();
  } catch {
    // A storage failure must not make the editor unusable.
  }
}

export function discardActiveRequestDraft(requestId: string): boolean {
  const previous = readActiveRequestDraft(requestId);
  if (!previous) return false;
  try {
    localStorage.setItem(undoKey(requestId), JSON.stringify({
      previous,
      updatedAt: new Date().toISOString(),
    }));
    localStorage.removeItem(draftKey(requestId));
    announceChange();
    return true;
  } catch {
    return false;
  }
}

export function clearActiveRequestDraftUndo(requestId: string) {
  try {
    localStorage.removeItem(undoKey(requestId));
    announceChange();
  } catch {
    // A storage failure must not make the editor unusable.
  }
}

export function hasActiveRequestDraftUndo(requestId: string): boolean {
  try {
    const parsed = JSON.parse(localStorage.getItem(undoKey(requestId)) || "null") as { previous?: unknown } | null;
    return Boolean(parsed && Object.prototype.hasOwnProperty.call(parsed, "previous"));
  } catch {
    return false;
  }
}

export function undoActiveRequestDraft(requestId: string): StoredActiveRequestDraft | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(undoKey(requestId)) || "null") as { previous?: unknown } | null;
    if (!parsed || !Object.prototype.hasOwnProperty.call(parsed, "previous")) return readActiveRequestDraft(requestId);
    localStorage.removeItem(undoKey(requestId));
    const previous = parsed.previous;
    if (!previous || typeof previous !== "object") {
      localStorage.removeItem(draftKey(requestId));
      announceChange();
      return null;
    }
    const candidate = previous as Partial<StoredActiveRequestDraft>;
    if (typeof candidate.revision !== "string" || !validValue(candidate.baseValue) || !validValue(candidate.value)) {
      localStorage.removeItem(draftKey(requestId));
      announceChange();
      return null;
    }
    localStorage.setItem(draftKey(requestId), JSON.stringify(candidate));
    announceChange();
    return candidate as StoredActiveRequestDraft;
  } catch {
    return readActiveRequestDraft(requestId);
  }
}

type FlatValue = Map<string, string>;

function flatten(value: ActiveRequestDraftValue): FlatValue {
  const result: FlatValue = new Map([
    ["request:ticketId", text(value.ticketId)],
    ["request:spareSr", text(value.spareSr)],
    ["request:note", text(value.note)],
  ]);
  for (const [itemId, item] of Object.entries(value.items || {})) {
    result.set(`item:${itemId}:rma`, text(item?.rma));
    result.set(`item:${itemId}:deliveredBom`, text(item?.deliveredBom));
    result.set(`item:${itemId}:newSn`, text(item?.newSn));
    result.set(`item:${itemId}:notes`, text(item?.notes));
  }
  return result;
}

function setFlat(value: ActiveRequestDraftValue, path: string, next: string): boolean {
  if (path === "request:ticketId") value.ticketId = next;
  else if (path === "request:spareSr") value.spareSr = next;
  else if (path === "request:note") value.note = next;
  else {
    const match = path.match(/^item:(.+):(rma|deliveredBom|newSn|notes)$/);
    if (!match || !value.items[match[1]]) return false;
    value.items[match[1]][match[2] as keyof ActiveRequestItemDraft] = next;
  }
  return true;
}

function fieldLabel(path: string, request: SpareRequestDetail): string {
  if (path === "request:ticketId") return "Original TT";
  if (path === "request:spareSr") return "Spare SR";
  if (path === "request:note") return "Audit note";
  const match = path.match(/^item:(.+):(rma|deliveredBom|newSn|notes)$/);
  const item = request.items.find((candidate) => candidate.item_id === match?.[1]);
  const unit = item ? `Unit ${item.ordinal}` : "Removed unit";
  const label = ({
    rma: "RMA",
    deliveredBom: "Delivered BOM",
    newSn: "New SN",
    notes: "notes",
  } as Record<string, string>)[match?.[2] || ""] || "field";
  return `${unit} ${label}`;
}

export function activeRequestDraftChanges(
  request: SpareRequestDetail,
  value: ActiveRequestDraftValue,
): ActiveRequestDraftChanges {
  const current = activeRequestDraftValue(request);
  const changes: Record<string, unknown> = {};
  const fields: string[] = [];
  if (value.ticketId !== current.ticketId) {
    changes.ticketId = value.ticketId;
    fields.push("Original TT");
  }
  if (value.spareSr !== current.spareSr) {
    changes.spareSr = value.spareSr;
    fields.push("Spare SR");
  }
  if (value.note !== current.note) {
    changes.note = value.note;
    fields.push("Audit note");
  }
  const itemUpdates = request.items.flatMap((item) => {
    const candidate = value.items[item.item_id];
    if (!candidate) return [];
    const base = current.items[item.item_id];
    const update: Record<string, unknown> = { itemId: item.item_id };
    if (candidate.rma !== base.rma) {
      update.rma = candidate.rma;
      fields.push(`Unit ${item.ordinal} RMA`);
    }
    if (candidate.deliveredBom !== base.deliveredBom) {
      update.deliveredBom = candidate.deliveredBom;
      fields.push(`Unit ${item.ordinal} Delivered BOM`);
    }
    if (candidate.newSn !== base.newSn) {
      update.newSn = candidate.newSn;
      fields.push(`Unit ${item.ordinal} New SN`);
    }
    if (candidate.notes !== base.notes) {
      update.notes = candidate.notes;
      fields.push(`Unit ${item.ordinal} notes`);
    }
    return Object.keys(update).length > 1 ? [update] : [];
  });
  return { changes, itemUpdates, fields };
}

export function analyzeActiveRequestDraft(
  request: SpareRequestDetail,
  stored: StoredActiveRequestDraft,
): ActiveRequestDraftAnalysis | null {
  const current = activeRequestDraftValue(request);
  const currentFlat = flatten(current);
  const baseFlat = flatten(stored.baseValue);
  const valueFlat = flatten(stored.value);
  const changedPaths = [...valueFlat.keys()].filter((path) => valueFlat.get(path) !== baseFlat.get(path));
  if (!changedPaths.length) return null;

  const rebasedValue = structuredClone(current);
  const conflicts: string[] = [];
  for (const path of changedPaths) {
    const incoming = valueFlat.get(path) || "";
    const base = baseFlat.get(path) || "";
    const now = currentFlat.get(path);
    if (now === undefined || (now !== base && now !== incoming)) conflicts.push(fieldLabel(path, request));
    if (!setFlat(rebasedValue, path, incoming)) conflicts.push(fieldLabel(path, request));
  }
  const result = activeRequestDraftChanges(request, rebasedValue);
  if (!result.fields.length) return null;
  return {
    ...result,
    conflictFields: [...new Set(conflicts)],
    rebased: {
      revision: request.revision,
      baseValue: current,
      value: rebasedValue,
      updatedAt: stored.updatedAt,
    },
  };
}
