# Zeus 3 data model

## Authority boundaries

| Record area | Authoritative writer |
|---|---|
| `upstream.fields` | Advanced Search reconciliation |
| `local.fields` | validated database edit transactions; flat compatibility values are derived |
| `local.spare_parts` | validated database edit transactions |
| `local.presentation.cell_styles` | retained legacy presentation metadata and export defaults |
| `lifecycle` | Advanced Search reconciliation and verified publication |
| `email` | optional Outlook staging and synchronization |
| `mop` | MOP output generation |
| `global/user_profile.json` | explicit local profile setup/edit |
| `global/reference_data.json` | structured Global data manager |
| `global/spare_request_boms.json` | Spare Requests BOM catalog |
| `current/spare_requests/active` | explicit Spare Request export plus configured-mail and manual lifecycle transactions |
| Completed Spare Request rows/email | dedicated `Closed.xlsx` tabs; never copied back to active Markdown |

Every current ticket lives at `current/tickets/<SRNo>/<SRNo>.md`. The first
Markdown line carries a base64-encoded JSON record marker; the remaining text
is a rendered human view of that exact record. A staged transaction rewrites
both together.

Lifecycle is `active` or `closure_pending`. Finalized tickets no longer remain
in the Markdown database; their non-email fields are appended to `Closed.xlsx`
and the ID remains in `closed_index.json`.

## Database-first discovery and closure

Advanced Search is the discovery source for current Service Requests. A new
valid workbook adds unknown IDs and refreshes protected fields on known IDs
without overwriting local fields. Existing database IDs absent from that source
become `closure_pending`, remain in Markdown, and can be reactivated by a later
source before export.

Pendings and Closed are not startup inputs. They may be absent, externally
changed, or locked without affecting normal database reads and edits. Outlook
is never required to build or query the database.

## Spare-parts hierarchy

`local.spare_parts` is a list of damaged devices. Each device stores `device`,
`model`, newline-delimited `faulty_sns`, and a list of parts; each part stores
newline-delimited `slot`, `part`, `bom`, and `notes`. Legacy part-level fault
and replacement serials upgrade without data loss, but new replacement serials
belong to the independent Spare Request lifecycle. An explicit export emits a
normalized `Spare Parts` worksheet with one row per part and explicit Device #
and Part # ordering. Every exported SR has at least one row: a blank sentinel
means that the ticket deliberately has no spare-parts record.

Legacy records with single Model, Device, Slot, Part, BOM, Old SN, and New SN
values migrate to one device/part record. The next explicit export writes the
normalized worksheet. The flat primary-sheet columns remain generated export
summaries, not a second editable hierarchy.

## Spare Request records and outputs

Service Requests projects current ticket Markdown. The top-level Spare Requests
workspace is different: Active Requests projects independent records under
`current/spare_requests/active/<request_id>/`; Eligible SR Parts is a reusable
projection of current `local.spare_parts`; Completed reads the two dedicated
tabs in validated Closed.xlsx. An eligible source part is never consumed and
may seed multiple independent requests.

The request ID is a unique Ecuador `YYMMDDHHmmss` allocated at initial XLSX
export. One request carries one eight-digit TT, at most one `SR` plus seven-digit
Spare SR, a profile snapshot, original BOM groups, and quantity-expanded unit
items. Each group stores exactly one requested BOM, zero or more unique slots,
notes, and the damaged device's faulty-serial evidence. When slots exist, their
unique newline count determines quantity and each unit receives one slot; a
slotless manual group retains an explicit multiplier. Those serials are
device-level evidence, not positional unit
assignments: one whole-server BOM can retain the serials of several damaged
internal parts, and every unit's single Faulty SN cell contains the whole list.
Each unit item owns at most one immutable `C`
plus ten-digit RMA. It stores requested and delivered BOM separately, plus New
SN, attendance, dispatch, return export, warehouse candidate, conflicts, and
audit history. Partial confirmation assigns available RMAs and leaves remaining
units in Awaiting stock under the same request.

## Local profile and global reference data

`global/user_profile.json` contains name, email, phone, optional username, and
an optional compact image data URL. A valid profile is a startup precondition
and is synthesized as the first pinned/current requester without duplicating it
inside `reference_data.json`.

`global/reference_data.json` contains customer organizations, customer
contacts, independent sites, and additional requesters. Every contact stores a
required organization ID. Requesters store their own contact details and a
favorite/pinned flag. `global/spare_request_boms.json` is deliberately separate
because it is managed from the Spare Requests workspace. Saved requests always
retain a complete profile snapshot, so later manager edits cannot rewrite old
exports.

Outlook facts are applied in confirmation-before-dispatch order irrespective of
message arrival. Existing contradictory TT, Spare SR, RMA, delivered BOM, or New
SN facts are never silently overwritten. Warehouse messages with exact RMA +
Spare SR matches create candidates only; archive remains an explicit user
action.

The configured export directory and local request/return templates are outside
the authority graph. Request output retains the supplied two sheets and return
output retains the supplied one sheet; additional units extend rows rather than
adding sheets. Startup, Query, recovery, and reconciliation never import output
workbooks. Completed/cancelled items leave active Markdown permanently and are
appended to `Spare Requests`; associated retained mail is appended to `Spare
Request Emails`.

## Operational workbook export

An explicit export builds a temporary Pendings workbook from active database
records and a temporary Closed workbook with all `closure_pending` rows
appended. Zeus validates the generated IDs and both file hashes, creates paired
backups when existing outputs are present, and atomically replaces the pair.
Only after that verified replacement succeeds does the publication transaction
remove finalized ticket records and update `closed_index.json`.

An interrupted paired export is journaled and recovered. Normal startup may
finish journals created by older releases, but it does not otherwise import,
materialize, or rewrite operational workbooks.

## Browser edit transaction

A web edit is a staged Markdown-database mutation. Its precondition is the
ticket revision. The candidate local fields or normalized Spare Parts hierarchy
are validated, written to a staging tree, checked against the revision again,
and atomically committed with an audit event. Pendings is not read or written.

`Spare` remains a workbook and Markdown compatibility value but is absent from
the site. Normalization enforces `Y` when any normalized part has a non-empty
BOM and `N` otherwise. A browser hierarchy edit stores the normalized record
and recalculates `Spare` in one database transaction. Flat compatibility cells
are generated on export. Planned dates cross the browser boundary as
`YYYY-MM-DD` and are exported as date cells rather than free-form display text.

## State markers

`state.json` contains system-owned markers:

- newest processed Advanced Search filename, timestamp, SHA-256, row count,
  and processing time;
- successful publication hashes, protected-field snapshot, and closed index;
- successful email fetch and synchronization times;
- full-scan, staged-message, publication, and recovery status.

Configuration contains user choices only. Runtime markers are never accepted
from the configuration API.

`paths.data_directory` is the one exception that generic setting edits cannot
write. The dedicated move transaction clones and hashes the complete mutable
root, records `data_migration.json` in the fixed application home, updates the
pointer, and requests a soft restart. Startup revalidates the prepared clone and
original. A verified clone becomes authoritative before original cleanup; a
mismatch restores the previous pointer. Failed Windows cleanup is marked
`cleanup_pending` and retried without ever rolling back to a partially deleted
old tree.

## Transaction boundary

Ticket and Spare Request Markdown records, `state.json`, `closed_index.json`, and email staging form the
`current/` transaction boundary. A mutation copies this tree below the same
writable data root, validates it, swaps it atomically, and appends a local audit
event. Keeping staging below the data root preserves Windows ACL inheritance
and avoids cross-volume replacement failures.

Workbook publication and legacy restore/recreation add their own backup or
journal boundary. Startup recovers a verified interrupted operation before
ordinary Advanced Search reconciliation begins.

## Email privacy

Email staging contains only messages associated with active IDs. Synced ticket
records retain cumulative seen-message hashes and the newest configured message
bodies. Final closure removes the ticket directory, staged associations, and
internal whole-state snapshots that could preserve those bodies. Operational
Pendings workbooks and their backups never contain subjects or bodies. The
dedicated Spare Request archive email tab is the sole exception and is purged
with its completed item at 180 days. Active retained spare email is purged at
the same age; either archive may be purged manually.
