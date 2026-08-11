# Changelog

## 3.1.12 - 2026-08-11

- Adds a first-class **Upcoming** workspace for several concurrent Maintenance
  Windows, each linked to several Service Requests, while enforcing one
  unfinished MW per SR and atomic revision-safe scheduling.
- Completes a shared MW through an explicit review of every linked SR, defaulting
  each outcome to **Completed** and archiving the reviewed result in each SR's
  own structured history.
- Adds optional `:00`/`:30` start and finish times, infers the next day when the
  finish clock precedes the start, and rejects recorded durations over 12 hours.
- Retains all matched sent and received email bodies per ticket by default;
  Configuration can still set a finite maximum or `0` for counters only.

## 3.1.11 - 2026-08-11

- Reorders Service Request work fields around one full-width Maintenance Window
  editor, derives Unplanned/Planned/Incomplete automatically from its date, and
  places manual **Completed** and archived-cycle **New MW** actions beside Save.
- Protects every editable Active Request fact in browser drafts at every
  lifecycle stage, includes those drafts in the global manager/count, restores
  them after navigation or reload, and supports one-step field/discard undo.
- Moves New Request, BOM catalog, and contextual lifecycle actions into the
  Active Requests upper row, collapsing them to hover-labelled icons on narrow
  screens.
- Hides raw detail History by default in both Service Requests and Active
  Requests, with an off-by-default toggle under Configuration → Developer
  options.

## 3.1.10 - 2026-08-11

- Makes **Confirm SR and RMA** validate and persist the visible Spare SR/RMA
  drafts before advancing, while retaining the existing RMA uniqueness,
  historical-alias, and Fault Tag correction safeguards.
- Records manual dispatch at the current Ecuador time without asking the user
  for a redundant timestamp, and locks dashboard bulk selection to one
  lifecycle stage as soon as its first item is selected.
- Replaces the stage-four export-only action with a **Fault Tag** choice:
  generate/export a new workbook, or create an internal Fault Tag ID and mark
  an externally sent tag as manual. Both paths still require matching warehouse
  email evidence plus final user confirmation.
- Keeps one **Create Request** entry point in SR detail, distinguishes Create
  from Export inside the themed request form, collapses constrained toolbar
  actions to hover-labelled icons, and gives lifecycle actions visible colors.
- Centers the no-email zero in one square badge and narrows Last Email and Spare
  Parts columns to their actual two- and four-badge capacities.

## 3.1.9 - 2026-08-10

- Keeps pre-migration Active Requests usable by supplying safe empty detail
  collections at the API boundary and defensively rendering stage-zero records
  without changing their Added to Zeus lifecycle state.
- Replaces pill and circular email/spare counters with compact, softly rounded
  rectangular badges shared by Service Requests and Spare Requests.

## 3.1.8 - 2026-08-10

- Stabilizes Service Request and Spare Request table geometry and replaces row
  email triangles with a shared Last Email header legend plus fixed received,
  sent, gray-zero, and no-email red-zero badges.
- Reclassifies Service Request spare-unit summaries as gray pending dispatch,
  yellow dispatched, red overdue from displayed day 20 by default, and green
  warehouse-returned, including returned archive items while their SR is open.
- Makes Spare Request controls stage-specific in both item detail and bulk
  selection, restores audited manual request-email confirmation with an
  editable timestamp, and keeps Advanced Search actions in Service Requests.
- Allows audited RMA correction while permanently reserving previous aliases;
  unlocked Fault Tags update and require re-export, while tags with sent or
  warehouse evidence must be deleted and recreated first.

## 3.1.7 - 2026-08-10

- Rebuilds the Spare Request lifecycle as seven fully named stages with
  dashboard bulk advance and one-stage rollback. Email-backed rollback requires
  a second confirmation and audit note; the exact email remains evidence while
  its lifecycle effect stays suppressed on later synchronization.
- Introduces independent multi-item Fault Tag batches with Ecuador timestamp
  IDs, per-item Faulty/New conditions, explicit mixed-site return destinations,
  revision-safe re-export, and a dedicated active view. Export never advances
  an Active Request.
- Locks Fault Tag membership when Zeus detects its first sent email. A mistaken
  batch can still be deleted to release its items without changing lifecycle;
  later additions use a new Fault Tag.
- Requires matching warehouse email evidence plus explicit user confirmation
  before completing each item. Partial batches stay visible until every member
  completes, then archive with the final item.
- Adds New Request Create/Export paths at Added to Zeus, Customer Organization
  filtering/search, directional Last Email triangles, and eligible/active/
  completed spare-unit badges with active items turning red after 20 full days.
- Makes row clicks highlight-only and double-click/Enter open detail, expands
  affected-device batch entry, adds themed destructive confirmations, and
  batches overdue Maintenance Window outcomes with optional rescheduling.
- Simplifies Protected Drafts to Close, Discard selected, and Save Selected,
  with one-level undo for the latest Save or Discard and a reload warning while
  that undo remains available.
- Defaults available Outlook stores to hourly fetch-and-sync, supports linked
  intervals in Configuration, and makes the page-level `S` command explicitly
  fetch and synchronize email while `R` checks Advanced Search.

## 3.1.6 - 2026-08-10

- Replaces the separate dashboard MW and Planned columns with one date-first
  Maintenance Window field backed by a structured status and attempt history.
  A real current date is always shown; undated states remain Unplanned,
  Incomplete, No visibility, or Complete.
- Prompts for the result of every past scheduled MW. Success completes the
  work, while failure records the attempt, clears the current date, and waits
  for a new plan without losing history.
- Adds Configuration → Database maintenance with read-only integrity preview,
  explicit confirmation, complete backup, staged schema migration, canonical
  Markdown regeneration, full validation, and atomic replacement.
- Refuses automatic repair when an embedded Markdown record is missing or
  invalid, directing recovery to a known-good backup instead of guessing.
- Keeps `Planned Date` and `Done?` as generated workbook compatibility
  projections while the 3.1.6 database and web interface use the unified MW
  record.

## 3.1.5 - 2026-08-08

- Removes organization-specific names, sender addresses, domains, and worksheet
  titles from the distributable application. Trusted mail roles are configured
  locally, while selected XLSX worksheet names are preserved by position.
- Replaces native browser confirmation and prompt boxes with Zeus-themed local
  dialogs across data managers, protected drafts, configuration, operations,
  conflict resolution, and archive purging.
- Rebuilds Global data as a friendly Zeus Operations-style card workspace with
  contextual counts, descriptions, record lists, and editors.
- Moves faulty serial evidence to the damaged-device level, removes New SN from
  the SR Spare Parts entry form, adds part notes, and makes unique newline slot
  entries derive physical-unit quantity automatically.
- Prefetches and caches Service Requests and Spare Requests projections in the
  browser and server so workspace changes refresh in place instead of reopening
  the full workbench loading screen.
- Keeps arrows highlight-only while detail is closed, refreshes an already-open
  detail as arrow selection moves, and leaves native wheel input to scroll the
  table without changing selection.
- Defers missing Spare Request export-configuration redirection until an
  explicit export attempt, so manual and eligible-SR request forms open freely
  and remain intact while Configuration is corrected.
- Themes every Spare Request autocomplete, moves required customer email/phone
  and the automatically loaded original TT date into the ticket-level section,
  and makes missing export configuration an explicit red action.
- Replaces the browser-native Global data SR picker with a bounded Zeus-themed
  prefix autocomplete, fixes the two-row narrow Spare Request toolbar, and adds
  persisted Compact, Standard, and Large semantic typography presets.

## 3.1.4 - 2026-08-08

- Fixes the successful-save revision race that could misclassify Zeus's own
  committed Work Fields update as a stale browser draft and keep reload
  protection active after the data was already saved.
- Adds amber protected-draft row markers and a selectable Drafts manager with
  explicit restore semantics, per-SR field summaries, selective discard, and
  confirmed all-or-nothing multi-SR database saves.
- Rebases drafts at field level so unrelated database changes do not cause
  false conflicts, while overlapping changes still require explicit review.
- Makes keyboard focus follow row and detail-tab navigation, eliminating stale
  cyan focus outlines on previously active controls.
- Keeps Global data open after successful saves, disables clean saves, prevents
  accidental dirty dismissal, autocompletes SR customer imports, describes
  every manager collection, and displays the current profile as the default
  requester.

## 3.1.3 - 2026-08-08

- Makes the transactional Markdown database authoritative for current Zeus
  work. Browser saves no longer read or rewrite Pendings.xlsx; they validate the
  ticket revision, commit atomically, and record the audit event.
- Makes Pendings.xlsx and Closed.xlsx explicit generated outputs. Advanced
  Search checks only discover/refresh source records and mark missing IDs for
  deferred closure; a verified paired export finalizes those deletions.
- Protects unsaved Work Fields and Spare Parts drafts across row/tab changes and
  remounts, warns on row navigation, and intercepts reload while drafts exist.
- Adds persisted category filters with OR-within/AND-across semantics, filtered
  ↑/↓ navigation, bounded ←/→ detail-tab navigation, and edit-control shortcut
  suppression.
- Renames the user-facing Done field to MW and combines email age plus cumulative
  count in Last Email, removing the separate count column.
- Makes BOM quantity the sole physical-unit, future-RMA, and Fault Tag row
  multiplier. Each unit's one Faulty SN cell contains the complete diagnostic
  component-serial list.

## 3.1.2 - 2026-08-08

- Adds mandatory first-run local contact setup with optional profile picture
  and username. There is no account, password, authentication, or remote
  profile; the saved contact becomes the default Spare Request requester.
- Adds a human-oriented Global data manager for customer organizations,
  organization-owned customer contacts, independent sites, and pinned
  requesters. The BOM catalog remains inside Spare Requests.
- Adds verified data-folder relocation with a 20 MiB reserve check, complete
  SHA-256 clone verification, soft restart, rollback on mismatch, and delayed
  deletion of the original only after the restarted process accepts the clone.
- Reworks Spare Request export around autocomplete fields, one customer-contact
  field, automatic initials, configuration readiness prompts, and one BOM plus
  quantity per group. Multiple faulty serials are entered one per line and
  remain independent from the requested BOM quantity in records and XLSX output.

## 3.1.1 - 2026-08-08

- Adds independent, per-unit Spare Request records with immutable TT/RMA rules,
  partial-stock handling, requested-versus-delivered BOM tracking, and conflict
  review instead of silent overwrites.
- Adds template-preserving initial and return XLSX exports, local profile/BOM
  managers, spare-only Outlook parsing, explicit warehouse confirmation, and
  180-day retention across active email and completed archives.
- Replaces the old top-level Spare Parts projection with Active Requests,
  Eligible SR Parts, and Completed Spare Requests views; SR detail continues to
  own the damaged-device Spare Parts editor.

## 3.1.0

- Added an extensible top-level workspace switcher. Service Requests retains
  the existing ticket dashboard, while Spare Parts presents one dense
  management row per normalized damaged part.
- Made the two workspaces independent browser views with their own search,
  sort field, sort direction, visible fields, and field order preferences.
- Made every Spare Parts row resolve back to its parent SR and open directly in
  the normalized Spare Parts editor. Pendings remains the mutation authority;
  the new dashboard is a Markdown projection, not a second database.
- Added Spare Parts counters for affected tickets, devices, parts, BOM
  coverage, and recorded replacement serial numbers.
- Added a nullable Spare Parts export-folder setting to the web and console
  configuration. The destination is one-way by contract: Query, startup, and
  reconciliation never read generated request workbooks from it.
- Established the 3.1 export boundary without guessing the pending Spare Part
  Request XLSX schema. File generation will be completed against the agreed
  columns and layout.
- Pinned SR as the first non-optional column in every workspace and made it the
  permanent owner of every damaged-device/part row.
- Extended the Spare Parts projection across lifecycle finalization: current
  SRs remain editable through Pendings, while finalized SR parts remain
  visible and read-only through the validated Closed.xlsx archive.

## 3.0.0 - 2026-08-07

- Replaced the interactive terminal dashboard with a bundled React/TypeScript
  master-detail web interface while preserving the CLI's dense, semantic
  information shape rather than drawing a fake terminal.
- Added a strictly local Python server, default-browser launch, native Windows
  tray controls, verified singleton registry, graceful restart/exit, and
  `zeus_stop.bat` for exact multi-instance shutdown.
- Made Pendings a complete clean-PC bootstrap source: it can rebuild Markdown
  and the dashboard without Closed, Advanced Search, or Outlook.
- Added conflict-safe browser editing that checks ticket and workbook versions,
  writes Pendings first, validates a staged workbook, backs up and atomically
  replaces it, then imports the same values into Markdown.
- Added fixed, configurable dashboard columns with Severity by default,
  browser-local order/visibility/theme/sort preferences, separate list/detail
  scrolling, and retained keyboard commands.
- Added visible serialized jobs for startup, scheduled/manual data queries,
  publishing, Outlook, recovery, diagnostics, and MOP generation. Browser page
  refreshes remain read-only.
- Kept Outlook fully optional and disabled all email work when no valid store is
  selected, with visible nonfatal notices.
- Retained non-interactive CLI commands, Python 3.13/3.14 compatibility, local
  Markdown transactions, publishing/recovery, and privacy boundaries.
- Added React unit tests, real Chrome/Edge interaction coverage, local HTTP
  security regressions, wheel/static bundle checks, and packaged-asset tests.
- Corrected the first-test save path so its response remains a complete ticket
  detail instead of unmounting React, and added an in-page recovery boundary for
  any future display failure.
- Made an absent optional Advanced Search workbook an informational skip rather
  than a failed-looking source warning; Pendings-only queries still complete and
  update the dashboard normally.
- Made Spare a system-derived compatibility invariant across Pendings import,
  web edits, Markdown, and publication; the final interface keeps it export-only.
- Replaced free-form Planned Date entry with a native browser calendar that
  writes a canonical Excel date cell.
- Made the Chrome/Edge save regression use browser-specific values so each
  project exercises a real Pendings transaction.
- Promoted `S`, `M`, `R`, and `Ctrl+F` to page-level commands whenever focus is
  outside an editable control, and added a persisted ascending/descending sort
  direction beside the existing sort field.
- Made manual and scheduled **Query data** plus **Save through Pendings**
  recreate an absent `Pendings.xlsx` from the current Markdown database. The
  verified recovery neither restores a backup nor creates or changes
  `Closed.xlsx`, and interrupted recreation is journaled.
- Replaced the scroll-container sticky save footer with a bounded two-row
  editor layout, preventing Work fields from overlapping the global query bar
  at the bottom of the panel.
- Split hardware replacement work into a repeatable **Spare Parts** section:
  tickets may hold multiple damaged devices and multiple parts per device, with
  Slot, Part, BOM, Faulty SN, and New SN stored in a normalized workbook sheet.
  Existing scalar records migrate automatically; flat columns and the
  export-only `Spare` flag remain generated compatibility output.
- Added a default dashboard **Emails** column showing cumulative received plus
  sent messages without opening each ticket.

## 2.0.3 - 2026-08-06

- Made every automatic Outlook operation nonfatal. Transient COM, RPC,
  namespace, store, and synchronization failures now become dashboard warnings
  instead of closing Zeus.
- Added a rotating local diagnostic log at
  `%LOCALAPPDATA%\Zeus\logs\zeus.log`; unexpected exceptions retain their full
  traceback without serializing ticket records or email bodies.
- Added a console runner that keeps the terminal open after an unexpected exit
  and points directly to the diagnostic log.
- Fixed Windows Terminal mouse delivery by forcing a real console-mode
  transition, enabling and verifying native mouse/window plus VT input, and
  enabling SGR click/wheel reporting on Windows as well as Unix terminals.
- Added dual mouse decoding: classic console `MOUSE_EVENT` records and Windows
  Terminal SGR sequences now feed the same click/wheel handlers.
- Added Windows compatibility CI for Python 3.13 and Python 3.14.
- Added regressions for cold-Outlook startup failure, diagnostic persistence,
  crash-visible launch behavior, Windows mouse transport, and the runtime
  compatibility matrix.

## 2.0.2 - 2026-08-06

- Fixed Windows Terminal startup after successful setup. The launcher now
  normalizes its working directory before passing it to `wt.exe`, preventing a
  trailing backslash from corrupting the title, options, and executable path.
- Added a regression test for the exact `0x80070002` launch failure.
- Fixed Windows setup when Python Install Manager reports a missing minor
  runtime with a negative HRESULT. Runtime probes now require an exact zero
  status, accept the current compatible Python 3 version, retain its resolved
  executable path, and correctly fall through to `python`/`python3`.
- Added a full-screen Windows Terminal launcher with a maximized classic-console
  fallback, alternate-screen rendering, hard scrollback clearing, and
  physical-row drawing that prevents long coloured summaries from wrapping
  and scrolling the Zeus header away.
- Added native Windows mouse input and portable terminal mouse input: ticket
  rows, retained-email rows, and menu items are clickable; the wheel, arrows,
  Page Up/Down, Home/End, and resize events navigate the matching viewport.
- Reworked ticket email details into a selectable one-reply-at-a-time view.
  Quoted Outlook history is collapsed by default, localized reply headers are
  recognized, and `T` reveals the preserved full thread on demand.
- Replaced the raw JSON/dotted-key configuration editor with a numbered,
  schema-driven menu and typed controls for every user setting.
- Added Outlook store folder scanning with visible select/deselect state,
  canonical exact-file persistence, empty-folder protection, and automatic
  repair of the accidental root-level `outlook_store_path` produced by the old
  editor.
- Reject unknown app-side setting keys and directory-valued Outlook stores at
  the save boundary so ignored duplicate keys cannot be created again.
- Hotfix: reject Outlook store directories during setup/configuration and give
  a concise exact-store suggestion when an open mailbox file is detected.
- Made Pendings the permanent startup authority for local work fields while
  keeping Advanced Search authority over online fields.
- Replaced immediate close/delete behavior with `closure_pending` and verified
  workbook publication.
- Added self-contained Markdown records, protected-cell baselines,
  `closed_index.json`, crash journals, and policy-safe backup cleanup.
- Added separate Outlook fetch staging and synchronization schedules, newest-N
  full bodies, cumulative deduplication, new-ticket history, cancellation, and
  incremental scanning through one COM worker.
- Added the read-only arrow-key dashboard, partial Ctrl+F search, aging report,
  summary counters, two-sheet Pendings output, append-only Closed output, and
  per-cell colour preservation.
- Added explicit fresh-workbook confirmation, Pendings-backup preview/restore,
  literal-only validation, paired rollback, and real-workbook integration QA.

## 2.0.1 - 2026-08-04

- Accepted Microsoft Store Python installations without requiring `py.exe`.

## 2.0.0 - 2026-08-04

- Introduced the transactional file-backed Zeus architecture.
