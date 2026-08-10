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
4. The default field set preserves the original dashboard, labels `Done?` as
   MW, and combines email age plus cumulative count in Last Email.
5. Opening a ticket reveals full detail without requiring every detail column
   in the list.
6. Search, category filters, sort, theme, visible columns, and column order
   remain local to the browser profile. Filter values are OR within a category
   and categories are AND across one another.
7. Every source operation is visible while it is queued or running.
8. Reloading the web page is a read operation, never a source operation.
   Unsaved drafts are persisted and standard reload attempts are intercepted
   until the user saves or discards them.
9. Planned Date uses a browser calendar; users do not need to infer a text
   format.
10. `S`, `M`, `R`, Ctrl+F, and navigation arrows operate at page scope while
    focus is outside an editable control. Text entry must never become an
    application command.
11. Sort field and ascending/descending direction are separate browser-local
    preferences.
12. Work and Spare Parts editors own a fixed action row above the global command
    strip; scrolling their content never moves or overlaps either command rail.
13. Top-level work is organized as extensible workspaces. Service Requests and
    Spare Requests share the same dense interaction grammar without sharing
    incompatible sort, search, filter, or column preferences.
14. Spare Requests has Active Requests, reusable Eligible SR Parts, and
    Completed subviews. Eligible rows remain a projection; exporting creates an
    independent persistent request immediately.
15. TT, RMA, and Last Email are first-class active-request fields. Last Email
    renders age and count together (for example `17 days [13]`); lifecycle
    attendance and dispatch aging use separate visual signals.
16. The damaged-device Spare Parts editor remains inside SR detail. Once its
    request XLSX is exported, later request work is available only in the Spare
    Requests workspace.
17. Warehouse email only creates a candidate. Returned archive requires a user
    confirmation, or a manual override with a mandatory note.
18. The first usable screen is local profile setup until name, email, and phone
    are valid. Picture and username are optional; password and login controls do
    not exist.
19. Global data uses ordinary record forms, never raw JSON. Customer contacts
    must select an organization; sites do not. The current profile is the
    default requester and additional favorite requesters may be pinned.
20. Spare export chooses customer, site, requester, and BOM through autocomplete.
    Customer initials are derived, and missing export paths redirect the user
    to Configuration before any workbook write begins.
21. One request group contains one BOM and a quantity multiplier. Quantity
    alone creates the physical unit records, future RMAs, and Fault Tag rows.
22. Newline-only faulty component serials are group evidence, not extra units.
    Every physical unit's single Faulty SN cell contains the entire serial list.
23. ↑/↓ follows the currently visible server-sorted and filtered row order.
    With detail closed it moves only the persistent highlight; with detail
    already open it also refreshes that panel to the newly highlighted row,
    keeps the active detail tab, preserves drafts, and informs the user when a
    draft was left protected. ←/→ changes detail tabs without wrapping.
24. Service filters cover Planning, MW, and Severity. Spare Request filters
    cover Status, dispatch risk, Site, Cloud, conflict state, and RMA state.
25. The mouse wheel scrolls the table viewport without changing its highlighted
    row. Only click or Enter may open a closed detail panel; arrow keys may
    refresh an already-open panel but never open one from the closed state.
26. Global data SR lookup is hidden until a numeric prefix is typed, remains
    height-bounded, and scrolls independently. Interface typography uses one
    persisted Compact, Standard, or Large semantic scale.

## Authority invariants

1. The transactional Markdown database is the source of truth for current
   tickets, local work fields, normalized Spare Parts, and active requests.
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
6. Outlook is optional. Without an available selected store, no email operation
   runs and the reason stays visible.
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
    removed from active Markdown, and cannot reopen. Active spare email and
    completed private/archive data are retained for at most 180 days.
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
