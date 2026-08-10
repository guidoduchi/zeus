# Zeus 3.1.6

Zeus is a strictly local ticket workstation. Its Python backend runs in the
background, serves a bundled React interface on `127.0.0.1`, and opens that
interface in the Windows default browser. No Node server, cloud database, or
external web service is required at runtime.

## Windows setup

1. Clone or extract Zeus to a local folder.
2. Double-click `setup_windows.bat` once.
3. Double-click `run_zeus.bat` whenever you want to open Zeus.
4. On first launch, save your name, email, and phone number. A picture and
   username are optional; Zeus does not create an account or ask for a password.
5. Use the Configuration gear to choose the workbook and optional source paths.

The setup accepts `py -3`, `python`, or `python3`, creates `.venv`, and installs
the Python application plus optional Classic Outlook support. Python 3.13 and
3.14 are the tested work runtimes. The project remains compatible with Python
3.11 or newer.

`run_zeus.bat` starts `pythonw` without a console, leaves the backend available
in the Windows notification area, and opens Zeus in Chrome, Edge, or whichever
browser Windows has configured as default. The tray menu provides **Open
Zeus**, **Logs**, **Restart**, and **Exit**.

Use `zeus_stop.bat` to stop every registered Zeus frontend/backend instance.
It first sends each instance its private local control token, then targets an
exact PID only when its process-creation marker still matches. It never kills
Chrome, Edge, unrelated Python programs, or a process that merely reused an old
PID. `run_zeus_console.bat` is available for diagnostics.

## Data authority

Zeus deliberately keeps separate sources of truth:

| Data | Authority | Required? |
|---|---|---:|
| Current tickets, local work fields, Spare Parts, and lifecycle state | transactional Markdown database | Yes |
| Online/protected ticket fields and current ticket set | newest valid `Advanced Search*.xlsx` | No |
| Active-ticket export | generated `Pendings.xlsx` | Only when requested |
| Finalized closed rows | generated/append-only `Closed.xlsx` | Only when requested |
| Private email history | one configured Classic Outlook `.ost`/`.pst` store | No |
| Active Spare Requests | independent Markdown under `current/spare_requests/active` | No |
| Completed/cancelled Spare Request items | dedicated tabs in `Closed.xlsx` | No |
| Request/return workbooks | one-way exports built from configured local templates | No |

The Markdown database is the source of truth for all current Zeus work.
`Pendings.xlsx` and `Closed.xlsx` are read-only operational outputs: ordinary
startup, query, and save paths neither import nor rewrite them. **Export
Pendings + Closed** generates both from one committed database snapshot.

If Outlook is disabled or the configured store is unavailable, Zeus runs no
email fetch or synchronization work. The dashboard says why. Database editing,
exports, reports, MOP generation, and non-email operations remain usable.

## Query behavior

Starting Zeus queues one visible source query. After that:

- the configured **Data query interval** checks for the newest Advanced Search
  workbook in the background; `0` disables scheduled checks;
- **Check Advanced Search** runs that discovery manually;
- the activity banner shows queued/running stage, message, progress, and safe
  cancellation where supported;
- if a newer Advanced Search file contains fewer SRs, the absent database
  records become `closure_pending`; they remain recoverable until export, and
  reappearing in a later source cancels the pending closure;
- a successful explicit export writes active rows to Pendings, appends pending
  closures to Closed, verifies both workbooks, and only then removes finalized
  current records;
- refreshing or reopening the browser page only reads current Markdown state;
  it never touches Excel, Advanced Search, or Outlook. Unsaved editor drafts are
  stored in the browser and trigger reload protection.

The default preferred URL is `http://127.0.0.1:8765`. If that port is occupied,
Zeus tries the next local ports and finally an operating-system-assigned local
port. The server cannot bind to another machine or network interface.

## Workspaces, dashboard, and ticket panel

The blue title rail switches seamlessly between two management workspaces:

- **Service Requests** keeps the original dense ticket dashboard: SR,
  lifecycle, the unified date-first MW, age, Last Email, severity, and summary;
- **Spare Requests** manages independent replacement requests and their
  per-unit RMA lifecycle. It contains **Active Requests**, reusable **Eligible
  SR Parts**, and read-only **Completed** archive views.

Last Email combines age and cumulative count in one cell: the age remains text,
while the total is enclosed in a compact badge. Zero is red and every positive
total uses the same neutral color; there is no separate email-count column. Lifecycle attendance
is a separate black/gray/green signal; the
dispatch timer is normal through day 14, amber on days 15–19, and red from day
20 until the item is confirmed returned and archived. Selecting an eligible SR
part opens the export form; selecting an active unit opens its independent
request, spare-only email, conflict, return, and archive history.

The damaged-device **Spare Parts** editor remains inside SR detail and saves
directly to the database. Exporting from that editor immediately writes a
template-based XLSX and creates an independent request. If the XLSX was prepared
and sent outside Zeus, **Already sent manually** creates the same Active Request
without needing export configuration, a Spare SR, or an RMA. The exact source
part leaves Eligible SR Parts while active and returns after completion or
cancellation.

The gear beside **Fields** can show/hide and reorder every available field.
Each workspace remembers its own search, filters, sort field,
ascending/descending direction, visible fields, and field order in the browser
profile. Multiple values are OR within a filter category and categories are
ANDed together. The dark/light theme is shared. Column resizing is intentionally
not supported. Configuration offers Compact, Standard, and Large interface text
presets; every view derives its typography from the same semantic scale.

The page itself never scrolls. The ticket list owns its wheel and keyboard
scrolling; the ticket detail panel has a separate scroll area. A row opens in a
master/detail panel with:

- lifecycle and aging facts;
- protected Advanced Search fields;
- editable database-owned work fields plus derived work-state fields;
- retained email replies with compact/full-thread viewing;
- versioned MOP output;
- ticket audit history.

Keyboard shortcuts preserve the useful CLI grammar: ↑/↓ follows the visible
server-sorted and filtered row order, while ←/→ moves among detail tabs without
wrapping. Moving rows preserves the active tab and any draft, and reports that
the draft remains safe. Page Up/Down selects rows, Enter opens, and Escape
closes. Anywhere in the active Zeus page outside an input, textarea, selector,
or editable region, Ctrl+F searches, `S` cycles the sort field, `M` opens
Operations, and `R` checks Advanced Search.

## Safe browser editing

Saving a work field uses the same transactional database as the rest of Zeus:

1. checks that the open ticket revision is current;
2. validates only recognized Zeus work fields and normalized Spare Parts;
3. writes the complete ticket record through a staged atomic transaction;
4. appends the audit event and returns the newly committed revision.

Existing, missing, changed, or Excel-locked operational workbooks cannot block
a save because they are not consulted. They change only on explicit export.
Optimistic revision conflicts stop a stale browser from overwriting newer
database values.

Work and Spare Parts changes are also written to protected browser drafts while
the user types. Drafts survive row navigation, tab changes, detail closure, and
page remount. Standard reload attempts are blocked or receive the browser's
leave-page warning until the user saves or discards the draft.

Rows with protected changes carry an amber edit marker, and the command strip
opens a **Protected drafts** manager. That manager groups changes by SR, shows
the pending fields, lets the user select exactly which SRs to restore, save, or
discard, and lists every selected SR before confirmation. A multi-SR save is a
single database transaction: every reviewed revision commits or none do.
**Restore changes** reapplies protected values over the latest database values
for review; it never implies that the values have already been saved.

Browser-editable database-owned fields are:

```text
Maintenance Window, Site, Cloud, RelatedSR, Notes
```

Maintenance Window uses one date-first editor and one dashboard column. When a
current date exists, Zeus shows that date instead of a generic state label.
After the date passes, Zeus asks whether the MW succeeded. Success changes the
display to `Complete`; failure records an `Incomplete` attempt, clears the
current date, and waits for another date. `Unplanned` and `No visibility`
remain distinct undated states. Every completed or failed attempt remains in
the structured local history.

For operational-workbook compatibility, Zeus still generates `Planned Date`
as a real Excel date plus `Done?` (`Y`, `N`, `P`, or `?`). Those columns are
projections of the structured MW record, not independent database authorities.

Hardware replacement data has its own **Spare Parts** section. A ticket may
contain zero or more damaged devices; every device has its own model and zero
or more parts with Slot, Part, BOM (part number), Faulty SN, and New SN. The
same hierarchy is emitted to a normalized `Spare Parts` worksheet, one row per
part, without packing nested data into one cell. Historical single-device
records migrate automatically.

The original flat Model/Device/Slot/Part/BOM/Old SN/New SN cells remain derived
compatibility columns in the primary worksheet. `Spare` is export-only and is
generated as `Y` when any normalized part has a BOM, otherwise `N`; neither
value appears as an editable site field.

Configuration accepts a **Spare Request export folder**, a local two-sheet
request template, and a local one-sheet return template. Templates remain
outside the installation and repository. Zeus preserves the exact template
sheet set, extends item rows in place, verifies generated values, and writes
numbered revisions under `Requests` and `Returns`; it never imports these
outputs as authority.

Zeus opens the request form even when export paths are missing. Only an explicit
Zeus export redirects to Configuration; manual registration remains available.
After a successful XLSX export, Zeus advances to Active Requests and displays a
reminder to attach and send the file. Customer, site, requester, and BOM inputs autocomplete from
local data. The top-bar **Global data** manager owns the workstation profile,
customer organizations, customer contacts, sites, and additional requesters;
favorite requesters can be pinned. The **BOM catalog** remains in the Spare
Requests toolbar.

Global data does not show SR suggestions until a numeric prefix is typed. Its
themed result list is height-bounded and owns its wheel scrolling, so a broad
prefix never expands the modal beyond the Zeus workspace.

Each customer contact belongs to a customer organization, while sites remain
independent. The selected contact name is also the workbook customer-contact
name; there is no redundant second contact-name field. Filename initials are
derived from that name rather than entered manually.

Each request has one immutable eight-digit TT (manual TTs may be corrected with
an audit note), one Ecuador export timestamp ID, and at most one seven-digit
Spare SR. Each BOM group requests one BOM for one or more slots entered one per
line; the unique slot count determines the number of physical unit records,
future RMAs, and Fault Tag rows. A slotless manual request may instead use an
explicit quantity multiplier, and multiple BOM groups may be added to one
request. Faulty serials are entered once at damaged-device level, one per line,
and describe the evidence supporting every BOM group for that device. In a
slotted group, each physical unit receives one slot while retaining the complete
device serial list plus the group's notes. Each unit can later receive one
immutable `C` plus ten-digit RMA, a delivered/substitute BOM distinct from the
requested BOM, and one New SN. Out-of-order request-confirmation and
dispatch-notification messages
are reconciled; contradictory facts become visible conflicts instead of
overwrites. Trusted senders and any warehouse domain are configured locally.
Warehouse candidates still require both an exact RMA and Spare SR match, and a
user must confirm the return or provide a noted manual override.

Protected fields are:

```text
SRNo, Problem Summary, Report Date, Customer Contact, Customer Severity,
Product, Current Handler, Status, ResolveBy, Resolve By Suspend
```

MW completion does not close a ticket. Only the Advanced Search lifecycle plus
verified workbook publication can finalize a closure.

Configuration includes **Database maintenance**. Its integrity check is
read-only. An upgrade/repair requires explicit confirmation, creates a complete
backup, migrates a staging copy, regenerates readable Markdown only from valid
embedded records, validates the full store, and swaps it atomically. Missing or
invalid embedded records block automatic repair so Zeus never invents data.

## Local files and privacy

Configuration and generated data live under `%LOCALAPPDATA%\Zeus`:

```text
%LOCALAPPDATA%\Zeus\
├── zeus_config.json
├── logs\zeus.log
├── runtime\instances\*.json
└── data\
    ├── global\
    │   ├── user_profile.json
    │   ├── reference_data.json
    │   └── spare_request_boms.json
    ├── current\
    │   ├── state.json
    │   ├── closed_index.json
    │   ├── email_staging\messages.ndjson
    │   ├── spare_requests\
    │   │   ├── unmatched_messages.ndjson
    │   │   └── active\<YYMMDDHHmmss>\<YYMMDDHHmmss>.md
    │   └── tickets\<SRNo>\
    │       ├── <SRNo>.md
    │       └── mops\*.docx
    ├── backups\*.zip
    └── audit\events.ndjson
```

Each ticket or active Spare Request Markdown file is both readable text and a
complete machine record. All state-changing operations are serialized and use
staged validation plus atomic replacement. Service-ticket email never enters
Pendings or Closed. Spare-only archive rows and associated email are written to
the two dedicated Closed tabs, retained for at most 180 days, and may be purged
manually earlier. Reference-manager personal data is local-only and ships
empty.

The mutable `data` tree can be moved from Configuration when its drive is low
on space. Zeus requires room for the full clone plus a 20 MiB reserve, compares
the cloned file manifest and SHA-256 hashes, saves the new pointer, and performs
a soft restart. The restarted process verifies both copies before deleting the
old data tree; a mismatch rolls back to the original. A tiny configuration,
runtime-registry, and diagnostic-log bootstrap remains under
`%LOCALAPPDATA%\Zeus` so Zeus can find a relocated database.

The HTTP server enforces loopback binding, Host validation, per-instance CSRF
tokens, origin checks, a restrictive Content Security Policy, no CORS, and
path-safe downloads. It does not expose telemetry or make the UI reachable on
the LAN.

## Non-interactive commands

The interactive terminal dashboard is retired. Existing automation commands
remain available:

```powershell
zeus startup
zeus list --status active
zeus show 12345678
zeus paths show
zeus sync-advanced --dry-run
zeus publish --yes --create-missing
zeus mail fetch
zeus mail sync
zeus mail rebuild
zeus doctor
zeus mop 12345678 --template "D:\Templates\swap.docx"
```

Publication and legacy-backup restore still require explicit confirmation in
non-interactive use. A legacy restore changes database work fields only; the
operational workbooks remain untouched until the next export.

## Development and verification

The React production bundle is committed under `zeus2/web/static`; a cloned
work computer does not need Node. Node is required only to change the frontend:

```powershell
npm ci --prefix frontend
npm run test --prefix frontend
npm run build --prefix frontend
python -m unittest discover -s tests -v
```

GitHub CI repeats the complete Python suite on Windows with 3.13 and 3.14,
rebuilds and checks the locked React bundle, exercises the real UI in Chrome
and Microsoft Edge, builds a wheel, and verifies its embedded assets.

Further contracts are documented in [Architecture](docs/ARCHITECTURE.md),
[Data model](docs/DATA_MODEL.md), [Product contract](docs/PRODUCT_CONTRACT.md),
and [Release scope](docs/RELEASE_SCOPE.md).
