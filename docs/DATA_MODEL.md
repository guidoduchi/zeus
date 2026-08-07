# Zeus 2.0.2 data model

## Authority boundaries

| Record area | Sole writer |
|---|---|
| `upstream.fields` | Advanced Search reconciliation |
| `local.fields` | validated Pendings import/restore |
| `local.presentation.cell_styles` | validated Pendings import/restore |
| `lifecycle` | Advanced Search reconciliation and verified publication |
| `email` | email synchronization |
| `mop` | MOP output generation |

Every ticket lives at `current/tickets/<SRNo>/<SRNo>.md`. The first Markdown
line contains a base64-encoded JSON record marker; the rest is a rendered human
view of the same record. A staged transaction always rewrites both together.

Lifecycle status is either `active` or `closure_pending`. Finalized closed
tickets do not remain in the Markdown database; their non-email fields are
appended to `Closed.xlsx` and the ID is retained in `closed_index.json`.

## State markers

`state.json` contains system-managed markers:

- last processed Advanced Search full filename, embedded timestamp, SHA-256,
  processed time, and row count;
- Pendings import result and last protected-field snapshot;
- last successful full email fetch and email synchronization timestamps;
- initial/full-scan and staged-update status.

Configuration contains user choices only. Runtime markers are never imported
from the configuration file.

## Transaction boundary

All Markdown records, state, `closed_index.json`, and email staging comprise the
`current/` transaction boundary. A mutation copies this tree beneath the same
writable data root, validates it, swaps it atomically, and records an audit
event. Staging beneath the data root preserves Windows ACL inheritance and
avoids Python 3.13 temporary-directory permission failures.

Workbook publication and Pendings restore add explicit journals. Startup either
finishes a verified swap or discards an uncommitted preparation before ordinary
Pendings import begins.

## Email privacy

Email staging contains only messages matched to active IDs. Synced ticket
records retain cumulative seen-message hashes and the newest configured message
bodies. Closure deletes the entire ticket directory, removes any staged
association, and purges internal whole-state ZIP snapshots. Operational
workbooks and their backups never contain email subjects or bodies.
