# Zeus 3 data model

## Authority boundaries

| Record area | Authoritative writer |
|---|---|
| `upstream.fields` | Advanced Search reconciliation, or the protected snapshot carried by Pendings when rebuilding from Pendings alone |
| `local.fields` | validated Pendings import/restore/web-edit transaction; `Spare` is derived from `BOM` |
| `local.presentation.cell_styles` | validated Pendings import/restore |
| `lifecycle` | Advanced Search reconciliation and verified publication |
| `email` | optional Outlook staging and synchronization |
| `mop` | MOP output generation |

Every current ticket lives at `current/tickets/<SRNo>/<SRNo>.md`. The first
Markdown line carries a base64-encoded JSON record marker; the remaining text
is a rendered human view of that exact record. A staged transaction rewrites
both together.

Lifecycle is `active` or `closure_pending`. Finalized tickets no longer remain
in the Markdown database; their non-email fields are appended to `Closed.xlsx`
and the ID remains in `closed_index.json`.

## Pendings-first bootstrap

Pendings includes protected columns as an integrity snapshot plus the local
work columns it owns. When no Markdown database exists, a valid Pendings file
can seed both areas and produce the complete dashboard. Advanced Search later
refreshes protected fields and lifecycle without overwriting local fields.

Closed is not required to import Pendings. When present it is validated and
indexed. Advanced Search is not required to show Pendings-derived tickets.
Outlook is never required to build or query the database.

## Missing-Pendings materialization

When a manual or scheduled Query, or a browser Save, finds that
`Pendings.xlsx` is genuinely absent, Zeus may materialize a replacement from
every current Markdown record. It preserves the last known valid header order
when available, writes active and closure-pending rows, builds the report sheet,
verifies all ticket IDs, and establishes a new protected-field snapshot before
ordinary import continues.

This recovery is not publication and is not backup restore. It never reads a
Pendings backup, creates or modifies `Closed.xlsx`, or finalizes a ticket. An
existing workbook—even invalid or externally changed—remains protected by the
normal validation and conflict rules. Preparation and replacement are
journaled so startup can finalize a verified replacement after interruption.

## Browser edit transaction

A web edit is a Pendings transaction, not a direct Markdown mutation. Its
preconditions are the ticket revision and the SHA-256 of the last imported
Pendings file. A mismatch produces a conflict before any value is written.

The candidate workbook is written and validated off to the side. Zeus then
creates a recoverable original copy, replaces Pendings atomically, imports that
file through the existing reconciliation path, and writes the audit event. If
the Markdown import fails, the workbook backup is atomically restored.

`Spare` remains a workbook and Markdown column for compatibility, but it is not
an editable field. Normalization enforces `Y` when trimmed `BOM` content exists
and `N` otherwise. A browser BOM edit writes both cells in the same workbook
transaction. Planned dates cross the browser boundary as `YYYY-MM-DD` and are
stored in Excel as date cells rather than free-form display text.

## State markers

`state.json` contains system-owned markers:

- newest processed Advanced Search filename, timestamp, SHA-256, row count,
  and processing time;
- Pendings import SHA-256, result, and protected-field snapshot;
- successful email fetch and synchronization times;
- full-scan, staged-message, publication, and recovery status.

Configuration contains user choices only. Runtime markers are never accepted
from the configuration API.

## Transaction boundary

Markdown records, `state.json`, `closed_index.json`, and email staging form the
`current/` transaction boundary. A mutation copies this tree below the same
writable data root, validates it, swaps it atomically, and appends a local audit
event. Keeping staging below the data root preserves Windows ACL inheritance
and avoids cross-volume replacement failures.

Workbook publication, Pendings restore/recreation, and web edits add their own
backup or journal boundary. Startup recovers a verified operation or discards
its uncommitted preparation before ordinary import begins.

## Email privacy

Email staging contains only messages associated with active IDs. Synced ticket
records retain cumulative seen-message hashes and the newest configured message
bodies. Final closure removes the ticket directory, staged associations, and
internal whole-state snapshots that could preserve those bodies. Operational
workbooks and workbook backups never contain subjects or bodies.
