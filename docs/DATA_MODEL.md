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
| `current/spare_requests/active` | explicit Create/Export actions, configured-mail facts, and revision-safe lifecycle transactions |
| `current/spare_requests/fault_tags` | Fault Tag export/re-export, linked sent/warehouse email evidence, and explicit member confirmation |
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
tabs in validated Closed.xlsx. A source part is identified by TT, Device #, and
Part #. It remains in the SR database but is withheld from eligibility while an
Active Request owns that identity, then becomes eligible again after the active
units are completed or cancelled.

The request ID is a unique Ecuador `YYMMDDHHmmss` allocated at initial Create
or Export. One request carries one eight-digit TT, one original TT report date, at
most one `SR` plus seven-digit Spare SR, a profile snapshot, original BOM groups,
and quantity-expanded unit items. The report date is captured once at TT level
and propagated to unit/Fault Tag output; it is not independently edited per BOM.
Each group stores exactly one requested BOM, zero or more unique slots, notes,
and the damaged device's faulty-serial evidence. When slots exist, their
unique newline count determines quantity and each unit receives one slot; a
slotless manual group retains an explicit multiplier. Those serials are
device-level evidence, not positional unit
assignments: one whole-server BOM can retain the serials of several damaged
internal parts, and every unit's single Faulty SN cell contains the whole list.
Each unit item owns at most one immutable `C` plus ten-digit RMA. It stores
requested and delivered BOM separately, plus New SN, attendance, dispatch,
replacement confirmation, linked Fault Tag IDs, warehouse evidence, lifecycle
suppressions, conflicts, and audit history. Partial confirmation assigns
available RMAs and leaves remaining units in Awaiting stock under the same
request.

Lifecycle is contiguous and uses Added to Zeus, Request email sent, SR and RMA
confirmed, Spare parts dispatched, Spare replaced, Warehouse evidence received,
and Complete. A request-level sent-email fact is shared by every unit; changing
that stage requires selecting all active units in the request. A rollback of an
email-backed stage retains the message and appends a suppression keyed by exact
message identity, so replay cannot restore the lifecycle effect.

## Fault Tag records

Each active Fault Tag lives at
`current/spare_requests/fault_tags/active/<FT-ID>/<FT-ID>.md`; completed batches
move to the sibling `completed` collection. Its ID is an Ecuador
`FT-YYMMDDHHmmss`, independent from request IDs. A record snapshots the actual
return site, export revisions, sent-email identity, lock state, and one or more
members with request/item identity, Faulty/New condition, warehouse evidence,
and explicit-user-confirmation time.

Export and re-export do not change request lifecycle. The first detected sent
Fault Tag email sets the immutable membership lock. Only one active Fault Tag
may own an item. Deleting a mistaken batch removes its links from active items
without changing their stages. A confirmed member can leave active request
Markdown while a partial batch remains active; stored member snapshots keep
same-ID re-export possible. The final confirmed member archives the batch.

## Local profile and global reference data

`global/user_profile.json` contains name, email, phone, optional username, and
an optional compact image data URL. A valid profile is a startup precondition
and is synthesized as the first pinned/current requester without duplicating it
inside `reference_data.json`.

`global/reference_data.json` contains customer organizations, customer
contacts, independent sites, and additional requesters. Every contact stores a
required organization ID. A new Spare Request snapshot also requires the chosen
customer contact's email and phone. Requesters store their own contact details and a
favorite/pinned flag. `global/spare_request_boms.json` is deliberately separate
because it is managed from the Spare Requests workspace. Saved requests always
retain a complete profile snapshot, so later manager edits cannot rewrite old
exports.

Outlook facts are applied in confirmation-before-dispatch order irrespective of
message arrival. Existing contradictory TT, Spare SR, RMA, delivered BOM, or New
SN facts are never silently overwritten. Warehouse messages with exact RMA +
Spare SR matches create evidence only. One explicit user confirmation completes
that item; manual evidence cannot bypass the warehouse match.

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

### Maintenance Window schema

Zeus 3.1.6 introduced MW truth under `local.maintenance_window`:

```json
{
  "schema_version": 1,
  "status": "planned",
  "date": "2026-08-21",
  "attempts": [],
  "review_required": false
}
```

`status` is `planned`, `unplanned`, `incomplete`, `completed`, or
`no_visibility`. A past planned date requires an outcome. A failed outcome is
appended to `attempts`, changes status to `incomplete`, and clears `date`; a
later plan sets a new date without deleting the old attempt. A successful
outcome preserves its date in history and changes the visible value to
`Complete`.

`local.fields["Planned Date"]` and `local.fields["Done?"]` remain generated
compatibility projections for Pendings/Closed export and older scripts. They
are synchronized during every normalized write and do not form two independent
sources of MW truth.

## State markers

`state.json` contains system-owned markers:

- newest processed Advanced Search filename, timestamp, SHA-256, row count,
  and processing time;
- successful publication hashes, protected-field snapshot, and closed index;
- successful email fetch and synchronization times;
- full-scan, staged-message, publication, and recovery status.
- database format version and last successful Database Maintenance timestamp.

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

Ticket, Spare Request, and Fault Tag Markdown records, `state.json`,
`closed_index.json`, and email staging form the `current/` transaction boundary.
A mutation copies this tree below the same
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
