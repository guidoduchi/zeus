export const DRAFT_STORAGE_PREFIX = "zeus3.ticket-draft.";
export const DRAFTS_CHANGED_EVENT = "zeus:drafts-changed";

export interface StoredDraft<Value, BaseValue = Value> {
  revision: string;
  baseValue: BaseValue;
  value: Value;
  updatedAt?: string;
}

export type TicketDraftKind = "work" | "spares";

export interface TicketDraftRecord {
  ticketId: string;
  kind: TicketDraftKind;
  draft: StoredDraft<unknown, unknown>;
}

function storageKey(ticketId: string, kind: TicketDraftKind): string {
  return `${DRAFT_STORAGE_PREFIX}${ticketId}.${kind}`;
}

function announceChange() {
  window.dispatchEvent(new CustomEvent(DRAFTS_CHANGED_EVENT));
}

export function readTicketDraft<Value, BaseValue = Value>(
  ticketId: string,
  kind: TicketDraftKind,
): StoredDraft<Value, BaseValue> | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(ticketId, kind)) || "null") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const candidate = parsed as Partial<StoredDraft<Value, BaseValue>>;
    if (typeof candidate.revision !== "string" || !("value" in candidate) || !("baseValue" in candidate)) {
      return null;
    }
    return candidate as StoredDraft<Value, BaseValue>;
  } catch {
    return null;
  }
}

export function writeTicketDraft<Value, BaseValue = Value>(
  ticketId: string,
  kind: TicketDraftKind,
  draft: StoredDraft<Value, BaseValue>,
) {
  try {
    localStorage.setItem(storageKey(ticketId, kind), JSON.stringify({
      ...draft,
      updatedAt: new Date().toISOString(),
    }));
    announceChange();
  } catch {
    // Browser storage is a safety net; the live React draft remains usable.
  }
}

export function listTicketDrafts(): TicketDraftRecord[] {
  const records: TicketDraftRecord[] = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(DRAFT_STORAGE_PREFIX)) continue;
      const match = key.slice(DRAFT_STORAGE_PREFIX.length).match(/^(\d{8})\.(work|spares)$/);
      if (!match) continue;
      const kind = match[2] as TicketDraftKind;
      const draft = readTicketDraft(match[1], kind);
      if (draft) records.push({ ticketId: match[1], kind, draft });
    }
  } catch {
    return [];
  }
  return records.sort((left, right) => (
    left.ticketId.localeCompare(right.ticketId)
    || left.kind.localeCompare(right.kind)
  ));
}

export function ticketIdsWithDrafts(): Set<string> {
  return new Set(listTicketDrafts().map((record) => record.ticketId));
}

export function clearTicketDraft(ticketId: string, kind: TicketDraftKind) {
  try {
    localStorage.removeItem(storageKey(ticketId, kind));
    announceChange();
  } catch {
    // A storage failure must not make the editor unusable.
  }
}

export function countUnsavedDrafts(ticketId?: string): number {
  const records = listTicketDrafts();
  return ticketId
    ? records.filter((record) => record.ticketId === ticketId).length
    : records.length;
}
