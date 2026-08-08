export const DRAFT_STORAGE_PREFIX = "zeus3.ticket-draft.";
export const DRAFTS_CHANGED_EVENT = "zeus:drafts-changed";

export interface StoredDraft<Value, BaseValue = Value> {
  revision: string;
  baseValue: BaseValue;
  value: Value;
}

export type TicketDraftKind = "work" | "spares";

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
    localStorage.setItem(storageKey(ticketId, kind), JSON.stringify(draft));
    announceChange();
  } catch {
    // Browser storage is a safety net; the live React draft remains usable.
  }
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
  try {
    const prefix = ticketId ? `${DRAFT_STORAGE_PREFIX}${ticketId}.` : DRAFT_STORAGE_PREFIX;
    let count = 0;
    for (let index = 0; index < localStorage.length; index += 1) {
      if (localStorage.key(index)?.startsWith(prefix)) count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}
