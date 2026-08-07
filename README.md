# Zeus 2.0.2

Zeus is a local, read-only ticket dashboard around three deliberately separate
sources of trust:

1. `Pendings.xlsx` owns local work fields and per-cell fill/font colours.
2. the newest valid `Advanced Search*.xlsx` owns Huawei online fields and the
   open/closure-pending lifecycle;
3. the configured classic Outlook store supplies private email history.

The CLI never edits ticket work data. Edit it in `Pendings.xlsx`; Zeus imports
the saved workbook every time it starts.

## Windows setup

1. Extract the release to a local folder.
2. Double-click `setup_windows.bat` once.
3. Double-click `run_zeus.bat`.
4. On first launch, select the Pendings/Closed directory and Advanced Search
   download directory. For Outlook, give Zeus the folder containing the local
   stores; Zeus scans it and lets you select the exact `.ost` or `.pst` file.

Python 3.11 or newer is required. The setup accepts the `py`, `python`, or
`python3` command, including Python Install Manager and Microsoft Store
installations. It selects the current compatible Python 3 runtime and creates
the virtual environment with that interpreter's resolved executable path; it
does not require Python 3.11 specifically when a newer version is installed.

`run_zeus.bat` opens Zeus in a new full-screen Windows Terminal window. If
Windows Terminal is unavailable, it falls back to a maximized classic console.
The dashboard uses an alternate screen and erases scrollback on every redraw,
so stale frames cannot be reached with the terminal scrollbar.

Configuration and internal data are stored in `%LOCALAPPDATA%\Zeus`:

```text
%LOCALAPPDATA%\Zeus\
├── zeus_config.json
└── data\
    ├── current\
    │   ├── state.json
    │   ├── closed_index.json
    │   ├── email_staging\messages.ndjson
    │   └── tickets\<SRNo>\
    │       ├── <SRNo>.md
    │       └── mops\*.docx
    ├── backups\*.zip
    └── audit\events.ndjson
```

Every `<SRNo>.md` file is both human-readable and the complete machine record.
There are no SQL services and no cloud APIs.

The operations menu's **Configuration** screen lists every setting by friendly
name and current value. Select its number to edit only that item; paths,
numbers, booleans, and enumerated choices use separate validated controls. Zeus
never asks for a dotted JSON key and never exposes the configuration document
as its interactive editor. The JSON file remains available for deliberate
manual inspection outside Zeus.

For the Outlook setting, enter a folder such as `D:\Email`. Zeus lists the
`.ost`/`.pst` candidates with a selection marker. Selecting a candidate stores
that exact file; selecting the checked candidate again deselects it, and option
`0` disables Outlook email. Zeus 2.0.2 uses zero or one mailbox store at a time.

## Startup behavior

Zeus performs this sequence without generating either workbook:

1. Recover an interrupted publication or Pendings restore, if necessary.
2. Open `Pendings.xlsx` read-only, validate the entire managed workbook, and
   atomically import local fields and cell colours.
3. Select and validate the newest Advanced Search using the 14-digit timestamp
   in its filename.
4. Refresh protected fields, add new tickets as `Done? = N`, and mark missing
   tickets `closure_pending`.
5. Run due Outlook fetch/synchronization operations.
6. Open the dashboard.

If Pendings is invalid, Zeus preserves its database and continues with a
prominent warning. If Advanced Search is invalid, local data remains visible
but mailbox fetching is skipped because ticket eligibility is untrusted.

While open, Zeus checks Advanced Search every 15 minutes by default and
recalculates calendar-day aging after local midnight.

## Keyboard and mouse interface

- `↑` / `↓`: move through tickets/menus or scroll ticket details line by line
- `PgUp` / `PgDn`: move one dashboard/detail page
- `Home` / `End`: jump to the first/last ticket or top/bottom of a detail
- `Enter`: open the selected ticket or run a menu action
- `Esc`: return
- `Ctrl+F`: live partial SR-number search
- `S`: cycle report, SR, planned-date, email-inactivity, and age sorting
- `M`: operations menu
- `←` / `→`: select a different retained email in the open ticket
- `T`: toggle the selected email between compact reply and full quoted thread
- `Q`: exit

The mouse wheel navigates the current view. A ticket row opens on click, a
retained email row selects that email, and an operations-menu item runs on
click. Keyboard and mouse selection stay synchronized.

Search covers every existing Markdown record, including `closure_pending`
tickets, and never searches `Closed.xlsx`.

## Workbook rules

`Pendings.xlsx` Sheet 1 is the work environment. These local fields are
imported:

```text
Planned Date, Site, Cloud, Model, Device, Slot, Part, BOM, Old SN, New SN,
RelatedSR, Notes, Spare, Done?
```

These Advanced Search fields are protected:

```text
SRNo, Problem Summary, Report Date, Customer Contact, Customer Severity,
Product, Current Handler, Status, ResolveBy, Resolve By Suspend
```

Known columns may be reordered. Every canonical header must occur exactly once;
unknown columns, duplicate/invalid IDs, missing previously exported rows, and
formulas block import. Literal text, numbers, and Excel dates are supported.
Completely empty trailing columns are ignored.

`Done?` accepts `Y`, `N`, `P`, and `?`, case-insensitively:

| Code | Meaning |
|---|---|
| `Y` | Completed successfully |
| `N` | Not completed |
| `P` | An attempted maintenance-window operation failed |
| `?` | Outside your visibility/ownership but still tracked |

Blank or other values become `N` and are reported in the import summary. None
of these values closes a ticket; only disappearance from Advanced Search does.

Sheet 2 (`Report`) is generated output. It contains aggregate email counts and
aging facts, but never email subjects or bodies. It is never imported and any
manual changes are overwritten on publication.

## Publishing and closure

Choose **Publish Pendings.xlsx + Closed.xlsx** from the operations menu. Zeus:

1. rereads and imports the latest saved Pendings edits;
2. validates both current workbooks;
3. creates paired timestamped copies in `Zeus Backups`;
4. appends final `closure_pending` rows to `Closed.xlsx`;
5. generates Pendings Sheet 1 (SR descending) and Report Sheet 2;
6. verifies both staged workbooks and atomically replaces the pair;
7. deletes finalized Markdown records and matched staged email only afterward.

Existing Closed rows are never regenerated or reordered. Their values and
styles survive; Zeus only validates IDs and appends new rows. The two recognized
historical aliases `Old SerialNumber` and `New SerialNumber` remain supported.

If a missing workbook should be recreated, Zeus requires explicit confirmation.
It never overwrites a corrupted workbook merely because creation would be
convenient.

## Outlook email

Zeus uses classic Outlook COM to select the configured local store by
`Store.FilePath`; it never parses `.ost` bytes directly. It scans Inbox and all
Inbox subfolders plus Sent Items once, matching all active SRs in that stream.
The configuration screen accepts a containing directory only as a scan
location and persists the selected exact file, so a folder cannot be mistaken
for the Outlook store identity.

- In `Spare Request` subjects, only an eight-digit `TT` token matches; `SR`
  tokens are ignored.
- In other subjects, any standalone known active eight-digit SR number matches.
- One message may count toward multiple tickets.
- Message IDs are deduplicated, so cumulative received/sent totals never fall.
- The newest configurable `N` sent/received messages combined retain their
  complete plain-text bodies (`N = 7` by default; `0` stores no bodies).
- Ticket details show those messages as a selectable newest-first list and
  display only the newly authored part of one reply at a time. English,
  Spanish, Portuguese, French, and German Outlook reply headers plus standard
  quoted blocks are recognized. Press `T` when the original complete thread is
  actually needed; no source text is discarded.

Fetching and synchronization are distinct. Fetching stages successful results;
synchronization applies them to Markdown. Defaults are independent seven-day
calendar schedules. `-1` means every startup and `0` means manual only.
`email.sync_mode = "after_fetch"` makes both stages one atomic operation.

The initial scan is complete; later scans use a configurable seven-day overlap.
**Rebuild email history** performs another complete merge without lowering
totals or deleting messages no longer present in Outlook. Outlook access runs on
one dedicated worker and expensive bodies are requested only for newest-message
candidates. A startup fetch may be cancelled with `Esc`; cancellation commits
nothing and changes no successful-fetch timestamp.

Email subjects and bodies never enter either ticket list or `Closed.xlsx`.
When closure is finalized, the Markdown record, staged associations, and
internal state snapshots that could retain email bodies are removed. Workbook
backups remain because they never contain email bodies.

## Report thresholds

All aging uses local calendar days. Defaults are configurable:

| Fact | Yellow | Red |
|---|---:|---:|
| Communication inactivity | 3 days | 7 days |
| Ticket age | 14 days | 30 days |
| Planned Date | due within 2 days | overdue |
| ResolveBy | due within 3 days | overdue |

`Unplanned` is amber, `No email found` is grey, and a suspended status displays
`Suspended` without ResolveBy urgency colour. Automatic colours affect only the
CLI and Report sheet; Sheet 1 colours remain manually controlled.

The default report order is overdue Planned Date, Unplanned, future Planned
Date (nearest first), then longest email inactivity and newest SR. `No email
found` sorts last for communication inactivity. Pending-closure records have a
separate section and are excluded from active counters.

## Recovery

The operations menu lists retained `Pendings_*.xlsx` backups. Restore shows a
preview, imports only local fields and colours for still-existing Markdown
records, ignores protected/closed IDs and email, and rewrites the current
Pendings so the next startup cannot undo it. Restore and publication both use
recovery journals for crash consistency.

## Command line

```powershell
zeus startup
zeus list --status active
zeus show 12345678

zeus paths show
zeus paths set --workbooks "D:\MOPs" `
  --advanced-search "$env:USERPROFILE\Downloads" `
  --outlook-store "D:\OutlookData\primary-mailbox.ost"

zeus sync-advanced --dry-run
zeus publish --yes --create-missing
zeus mail fetch
zeus mail sync
zeus mail rebuild
zeus doctor
```

Non-interactive publication and restore require explicit `--yes`.

## Test and build

```powershell
.venv\Scripts\python.exe -m unittest discover -s tests -v
build_windows.bat
```

The executable is written to `dist\zeus.exe`. Outlook integration requires
Windows, classic Outlook, and the locally installed `pywin32` dependency.
