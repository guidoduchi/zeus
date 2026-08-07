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
4. The default field set preserves the original dashboard and adds Severity
   plus the cumulative number of emails found per ticket.
5. Opening a ticket reveals full detail without requiring every detail column
   in the list.
6. Search, sort, theme, visible columns, and column order remain local to the
   browser profile.
7. Every source operation is visible while it is queued or running.
8. Reloading the web page is a read operation, never a source operation.
9. Planned Date uses a browser calendar; users do not need to infer a text
   format.
10. `S`, `M`, `R`, and Ctrl+F operate at page scope while focus is outside an
    editable control. Text entry must never become an application command.
11. Sort field and ascending/descending direction are separate browser-local
    preferences.
12. Work and Spare Parts editors own a fixed action row above the global command
    strip; scrolling their content never moves or overlaps either command rail.

## Authority invariants

1. Pendings is the first source of truth for local work data.
2. Pendings alone must rebuild the dashboard and Markdown database on a clean
   computer.
3. Web editing writes and validates Pendings before updating Markdown.
4. External Excel and browser edits never resolve by last-write-wins; a stale
   side receives an explicit conflict.
5. Advanced Search owns refreshed online fields and lifecycle when available.
6. Outlook is optional. Without an available selected store, no email operation
   runs and the reason stays visible.
7. Closed is append-only finalized output and is not a prerequisite for startup.
8. Spare is export-only and system-derived: any normalized part with a BOM
   means `Y`; no BOM means `N`. Neither the browser nor stale flat workbook
   content may override that rule.
9. A truly absent Pendings file may be materialized from the current Markdown
   database only when Query or Save explicitly needs it. This exception never
   applies to an existing changed or corrupt workbook, never restores a
   Pendings backup, and never creates or mutates Closed.
10. Multiple damaged devices and parts are represented by the normalized
    `Spare Parts` worksheet and `local.spare_parts`; flat compatibility cells
    must never become a competing nested-data authority.

## Runtime invariants

1. Zeus listens only on `127.0.0.1`.
2. The Python backend survives browser tab closure.
3. The configured default browser is an interchangeable frontend host.
4. `zeus_stop.bat` stops registered Zeus instances without broad process-name
   termination.
5. The work PC requires Python but never requires Node to run the committed UI.
6. Python 3.13 and 3.14 remain blocking compatibility targets.
