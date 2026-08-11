# Zeus 3 product contract

## Filtered simulation

Zeus should simulate the work, not imitate a physical terminal, spreadsheet,
or ticket portal. The design preserves the useful shape of the original CLI—
dense fixed columns, a bright title rail, cyan facts, semantic warning colors,
and a compact command footer—then lets the user's perception reconstruct the
system behind it.

This is the same abstraction principle used by strong low-resolution games and
illustration: retain the decisive contours and discard literal detail. A fake
terminal window inside a browser would be imitation. A native web workspace
whose information rhythm feels immediately legible to a CLI user is the intended
filtered interface.

Consequences:

- visual decoration must encode state or hierarchy;
- density is valuable when columns remain stable and scannable;
- color has a semantic job and is never the only accessible signal;
- browser-native controls are used where they improve operation;
- the interface does not copy paper cards, desktop windows, or terminal chrome;
- master/detail disclosure carries depth without removing list context.

## Interaction invariants

1. The document viewport never becomes the ticket-list scrollbar.
2. Wheel input over the dashboard moves the dashboard; the ticket panel owns
   its own scroll position.
3. Columns may be toggled and reordered, but not resized.
4. The default field set has one MW column. It shows the current date whenever
   one exists; only an undated state or `Complete` is rendered as text. Last
   Email shows age plus separate colored received/sent triangle counts and no
   cumulative-count badge.
5. Opening a ticket reveals full detail without requiring every detail column
   in the list.
6. Search, category filters, sort, theme, visible columns, and column order
   remain local to the browser profile. Filter values are OR within a category
   and categories are AND across one another.
7. Every source operation is visible while it is queued or running.
8. Reloading the web page is a read operation, never a source operation.
   Unsaved drafts are persisted and standard reload attempts are intercepted
   until the user saves or discards them.
9. MW uses a browser calendar. A past date produces an explicit success/failure
   prompt: success completes it, while failure records the attempt and waits
   for another date.
10. `S`, `M`, `R`, Ctrl+F, and navigation arrows operate at page scope while
    focus is outside an editable control. `S` fetches and synchronizes email,
    `M` opens Operations, and `R` checks Advanced Search. Text entry must never
    become an application command.
11. Sort field and ascending/descending direction are separate browser-local
    preferences.
12. Work and Spare Parts editors own a fixed action row above the global command
    strip; scrolling their content never moves or overlaps either command rail.
13. Top-level work is organized as extensible workspaces. Service Requests and
    Spare Requests share the same dense interaction grammar without sharing
    incompatible sort, search, filter, or column preferences.
14. Spare Requests has Active Requests, reusable Eligible SR Parts, Fault Tags,
    and Completed subviews. Eligible rows remain a projection. Create and Export
    both persist an independent request at Added to Zeus; only Export writes the
    XLSX, and neither pretends an email was sent. Its exact TT/device/part source
    is withheld from eligibility while active and remains reserved after archive.
15. TT, RMA, and Last Email are first-class active-request fields. Last Email
    renders age beside received/sent triangle counts; lifecycle attendance and
    dispatch aging use separate visual signals.
16. The damaged-device Spare Parts editor remains inside SR detail. Once its
    request is created or exported, later request work is available in Active
    Requests. Spare SR and RMA may arrive later in either path.
17. Warehouse email only creates exact-match evidence. Complete requires that
    evidence plus one explicit user confirmation; manual evidence cannot replace
    the warehouse match.
18. The first usable screen is local profile setup until name, email, and phone
    are valid. Picture and username are optional; password and login controls do
    not exist.
19. Global data uses ordinary record forms, never raw JSON. Customer contacts
    must select an organization; sites do not. The current profile is the
    default requester and additional favorite requesters may be pinned.
20. Spare export chooses customer, site, requester, and BOM through bounded,
    Zeus-themed autocomplete controls. Customer email and phone are required,
    customer initials are derived, and one TT-level original report date is
    loaded automatically for active SRs (or entered once for an unknown manual
    TT). Missing export paths turn the export action into an explicit red
    Configuration gate before any workbook write begins.
21. One request group contains one BOM and zero or more unique newline slots.
    Slot count creates physical units; only a slotless manual group uses an
    explicit quantity multiplier.
22. Newline-only faulty component serials are device evidence, not extra units.
    Every physical unit's single Faulty SN cell contains the entire serial list.
23. ↑/↓ follows the currently visible server-sorted and filtered row order.
    With detail closed it moves only the persistent highlight; with detail
    already open it also refreshes that panel to the newly highlighted row,
    keeps the active detail tab, preserves drafts, and informs the user when a
    draft was left protected. ←/→ changes detail tabs without wrapping.
24. Service filters cover unified MW state and Severity. Spare Request filters
    cover Status, dispatch risk, Site, Cloud, conflict state, and RMA state.
25. The mouse wheel scrolls the table viewport without changing its highlighted
    row. One click highlights and only double-click or Enter opens a closed
    detail panel; arrow keys may
    refresh an already-open panel but never open one from the closed state.
26. Global data SR lookup is hidden until a numeric prefix is typed, remains
    height-bounded, and scrolls independently. Interface typography uses one
    persisted Compact, Standard, or Large semantic scale.
27. Active Request lifecycle uses seven full labels. Dashboard bulk actions move
    every selected unit exactly one stage. The first selected unit immediately
    locks selection to that lifecycle stage. The shared request-email stage may
    change only when every active unit in that request is selected. Confirming
    SR and RMA validates and saves the visible values before advancing; dispatch
    records the current Ecuador time without a user-entered timestamp.
28. Rolling back an email-backed stage requires a second confirmation and audit
    note. The message remains retained evidence, while that exact message key's
    lifecycle effect stays suppressed on every later sync.
29. Fault Tags are independent multi-item batches with `FT-YYMMDDHHmmss` IDs,
    per-item Faulty/New conditions, and an explicit actual return destination
    for mixed source sites. Zeus may generate/export the workbook or create an
    internal ID for a Fault Tag already sent outside Zeus. Neither path changes
    request lifecycle.
30. The first detected sent Fault Tag email locks exported membership; manual
    sent confirmation locks it immediately. Re-export keeps the same ID and
    members; additions use a new batch. Deleting a mistaken batch releases
    members without changing their stages. Every path still requires matching
    warehouse email evidence and explicit final user confirmation.
31. Partial warehouse evidence remains visible per Fault Tag member. A batch
    stays active until every member receives evidence and explicit confirmation,
    then archives with the final member.
32. Protected Drafts exposes Close, Discard selected, and Save Selected. The
    latest Save or Discard has one-level undo, and reload warns while that
    in-memory undo is available.
33. Service Request rows may filter by Customer Organization and optionally show
    the Advanced Search `Customer Org.` column. Spare badges count physical
    units, hide zeros, and use yellow eligible, green active, day-21 red active,
    and gray completed states.
34. Every elapsed Maintenance Window is offered for review at startup. Standalone
    SRs choose Completed, Incomplete, or Review later; shared windows are reviewed
    atomically, default each linked SR to Completed, and allow per-SR correction
    plus an optional half-hour finish time before saving.
35. Upcoming counts every elapsed linked window awaiting review, including a
    standalone SR window. It can create an unlinked MW, atomically attach or
    detach active SRs during revision-safe edits, and delete the current plan
    from every linked SR without deleting archived attempts.

## Authority invariants

1. The transactional Markdown database is the source of truth for current
   tickets, local work fields, normalized Spare Parts, active requests, and
   active/completed Fault Tag records.
2. Pendings.xlsx and Closed.xlsx are read-only operational outputs. Startup,
   scheduled/manual Advanced Search checks, and browser saves never import or
   recreate them.
3. Web editing validates the ticket revision and writes the database directly
   through a staged atomic transaction. A stale browser receives an explicit
   conflict and cannot overwrite newer data.
4. Advanced Search discovers new tickets, refreshes protected online fields,
   and marks missing current IDs `closure_pending`; it never owns local work
   fields.
5. A later Advanced Search file can reactivate a pending closure before export.
   A successful explicit export writes Pendings and Closed from one snapshot,
   verifies both, and only then deletes finalized current records.
6. Outlook is optional. Without an available selected store or at least one
   active email-eligible database record, no email operation runs and the reason
   stays visible.
7. Closed is append-only finalized output and is not a prerequisite for startup
   or ordinary database editing.
8. Spare is export-only and system-derived: any normalized part with a BOM
   means `Y`; no BOM means `N`. Neither the browser nor stale flat workbook
   content may override that rule.
9. Existing, missing, changed, corrupt, or locked Pendings output cannot block a
   browser save. Explicit export is the only ordinary path that replaces it.
10. Multiple damaged devices and parts are authoritative in
    `local.spare_parts`; the normalized `Spare Parts` worksheet and flat cells
    are generated compatibility output and never competing authority.
11. Spare Request and return workbooks are generated outputs only. Their configured
    destination is excluded from every startup, Query, import, reconciliation,
    and recovery scan.
12. One active request owns one eight-digit TT and at most one Spare SR. Each
    quantity-expanded unit owns at most one globally unique immutable RMA;
    requested and delivered BOM are different fields.
13. Email/manual contradictions produce conflicts. Existing RMA and New SN facts
    are never silently overwritten.
14. Completed/cancelled items are appended to dedicated Closed.xlsx tabs,
    removed from active request Markdown, and cannot reopen. Completion requires
    warehouse evidence plus explicit confirmation and also confirms the Fault
    Tag member. Active spare email and completed private/archive data are
    retained for at most 180 days.
15. The local user profile and global reference collections live with the
    mutable data root. Only the tiny location pointer and runtime bootstrap stay
    in the fixed application-data home after relocation.
16. A data-root move requires capacity for the current tree plus a 20 MiB
    reserve. The clone is hash-verified before restart and reverified afterward;
    the old tree is deleted only after that handoff, otherwise Zeus rolls back.
17. A customer contact cannot exist without a referenced customer organization.
    Sites and BOM records have no customer-organization ownership.
18. Faulty serial evidence and requested BOM quantity are separate values. A
    whole-device request may retain several internal-component serials without
    generating extra unit records, RMAs, or Fault Tag rows; the complete list
    stays together in each unit's Faulty SN cell.
19. Database Maintenance is preview-first and explicitly confirmed. It creates
    a full backup, upgrades or repairs a staging copy, validates the complete
    transaction boundary, and swaps atomically. An invalid embedded record
    blocks automatic repair; readable Markdown may be regenerated only from a
    valid embedded authority record.
20. One active Fault Tag may own an item at a time. A confirmed member may leave
    active request Markdown while its partially completed batch remains valid;
    member snapshots preserve same-ID re-export until the batch archives.

## Runtime invariants

1. Zeus listens only on `127.0.0.1`.
2. The Python backend survives browser tab closure.
3. The configured default browser is an interchangeable frontend host.
4. `zeus_stop.bat` stops registered Zeus instances without broad process-name
   termination.
5. The work PC requires Python but never requires Node to run the committed UI.
6. Python 3.13 and 3.14 remain blocking compatibility targets.
7. Background source work pauses below 20 MiB free space and the current data
   location remains visible and movable through Configuration.
