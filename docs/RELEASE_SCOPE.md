# Zeus 3.1.11 release scope

Included:

- mandatory first-run local profile setup with name, email, and phone required;
  optional local picture and username; no login, password, or remote account;
- a global structured manager for customer organizations, organization-owned
  contacts, independent sites, the current-user requester, and pinned extra
  requesters, with BOM catalog management retained in Spare Requests;
- selectable data storage with a full-clone-plus-20-MiB capacity gate,
  verified restart handoff, safe rollback, and post-restart original deletion;
- bounded Zeus-themed Spare Request autocomplete inputs, automatically derived
  customer initials, required customer email/phone, one unified customer-contact
  name, one automatically loaded TT-level report date, and an explicit red
  configuration action when export is attempted without destinations or
  templates; the in-progress request form remains mounted while Configuration
  is corrected;
- slot-derived physical-unit, future-RMA, and Fault Tag expansion, with a manual
  multiplier for slotless groups and every unit retaining the damaged device's
  newline-delimited faulty serial evidence together in one cell;
- a Service Requests / Spare Requests workspace switcher with independent
  search, sort, direction, and field preferences;
- independent active Spare Request Markdown records, unit-level items, partial
  stock, requested/delivered BOM separation, unique correction-safe RMAs with
  reserved historical aliases, and visible conflict handling;
- Active Requests, Eligible SR Parts, independent Fault Tags, and Completed
  archive subviews; archived source records remain reserved so a later
  replacement uses a new part record;
- one **New Request** flow with Cancel, Create, and Export; Create needs no
  workbook configuration, Export writes XLSX, and both begin at Added to Zeus;
- a post-export acknowledgement reminding the user to attach and send the XLSX;
- configurable local request/return XLSX templates and a one-way export root,
  with exact sheet preservation, dynamic row extension, and revision-safe names;
- locally configured confirmation sender, dispatch/substitution sender, and
  warehouse domain parsing from HTML with plain-text fallback and out-of-order
  replay;
- independent multi-item Fault Tag handling with timestamp IDs, per-item return
  condition, mixed-site destination entry, generated export or internal
  manually-sent registration, same-ID re-export, sent-state membership lock,
  safe deletion, partial warehouse visibility, and archive after every member
  has evidence plus explicit confirmation;
- seven fully named Spare Request stages, bulk one-stage advance/rollback, shared
  request-email selection enforcement, immediate same-stage selection locking,
  SR/RMA auto-save on confirmation, current-time dispatch, and exact-message
  lifecycle suppression after a confirmed email-backed rollback;
- responsive upper-row New Request, BOM catalog, and contextual lifecycle
  controls that collapse to hover-labelled icons on constrained screens;
- mandatory cancellation reasons and dedicated Closed.xlsx archive/email tabs;
- local-only structured Global data and BOM managers that ship empty plus fixed
  180-day active-email and completed-archive retention;
- bundled React/TypeScript master-detail interface served by Python;
- strict `127.0.0.1` binding, local Host/Origin/CSRF controls, and no CORS;
- browser launch, Windows notification-area lifecycle, clean restart/exit, and
  verified multi-instance `zeus_stop.bat` shutdown;
- a database-first authority boundary: validated browser edits commit directly
  to transactional Markdown with optimistic revision conflicts and audit;
- read-only operational Pendings/Closed outputs generated only by explicit
  paired export, with validation, backups, atomic replacement, and deferred
  closure deletion only after success;
- independent ticket-list and detail scrolling; no whole-page scrolling;
- fixed-width columns with locally persisted visibility and order controls;
- native wheel scrolling inside dense tables without wheel-driven row changes,
  plus click-to-highlight and double-click/Enter opening, arrow-driven refresh of an already-open detail,
  and closed-detail customer-contact context;
- a bounded, themed SR-number-prefix autocomplete in Global data and persisted
  Compact, Standard, and Large interface typography presets;
- severity in the default dense dashboard, one structured MW field with legacy
  workbook projections, Last Email age plus directional received/sent triangles,
  and compact unit-count Spare Parts badges with day-20 active escalation;
- one date-first MW column and full-width editor, with automatic
  Unplanned/Planned/Incomplete states, manual completion after the date passes,
  a New MW cycle action after completion, and durable archived attempt history;
- preview-first Database Maintenance with full backup, staged 3.1.8 migration,
  readable-Markdown repair, blocked-record review, validation, and atomic swap;
- locally persisted dark/light theme, filters, sort field, and
  ascending/descending direction;
- page-level `S` fetch-and-sync, `M` Operations, `R` Advanced Search, Ctrl+F,
  and navigation arrows outside editable controls; ↑/↓ follows filtered order
  and ←/→ changes detail tabs without wrap;
- browser-persisted Work/Spare drafts, row-move notices, stale-draft recovery,
  and reload protection until a draft is saved or discarded;
- browser-persisted Active Request drafts for every editable request/item fact
  at every lifecycle stage, with global draft count/manager visibility and
  one-step field or discard undo in request detail;
- visible protected-draft row markers plus a selectable Drafts manager for
  review, selective discard, confirmed all-or-nothing multi-SR saves, and
  one-level undo for the latest Save or Discard;
- overlap-aware three-way draft rebasing, so unrelated database changes do not
  create false conflicts and a successful save cannot recreate its own draft;
- keyboard focus that follows the selected row and active detail tab instead of
  leaving a stale cyan focus rectangle on an earlier control;
- raw Service Request and Active Request History tabs hidden by default and
  exposed only by an off-by-default Configuration → Developer options toggle;
- a dirty-state-aware Global data manager that remains open after saving,
  disables no-op saves, blocks accidental dismissal while dirty, autocompletes
  SR-based contact imports, explains each collection, and visibly includes the
  current profile as the default requester;
- an Operations-style Global data card workspace plus Zeus-themed local
  confirmations in place of native browser prompt/confirm boxes;
- fixed Work/Spare action rails that remain above the global command strip;
- a normalized, repeatable database-owned damaged-device and spare-parts editor
  with device-level faulty serials, multi-slot BOM groups, notes, no New SN entry,
  and one-row-per-part compatibility output with legacy scalar migration;
- prefetched browser workspaces and revision/date-aware server dashboard caching
  so Service Requests and Spare Requests switch without a repeated boot screen;
- service filters for unified MW state, Severity, and Customer Organization,
  an optional Customer Org. field, and Spare Request filters for Status,
  dispatch risk, Site, Cloud, conflicts, and RMA state, using OR-within/AND-across;
- visible serialized startup, scheduled, and manual Advanced Search checks;
- page refreshes that never trigger a source query and cannot silently discard
  protected drafts;
- Advanced Search checks that discover/refresh tickets and defer missing-record
  deletion until the next successful explicit export;
- hourly fetch-and-sync by default when an Outlook store is available, linked
  interval configuration, and clear nonfatal disablement when no valid store exists;
- the full Advanced Search, closure, Outlook, publishing, recovery, MOP, aging,
  and Markdown transaction behavior inherited from 2.0.3;
- retained non-interactive command-line automation;
- Python 3.13/3.14 Windows CI, React unit tests, real Chrome/Edge interaction tests,
  wheel/static-asset verification, and a PyInstaller path.

Deliberately excluded:

- a network/LAN/cloud server mode;
- an interactive terminal dashboard;
- manual/raw Markdown file editing outside Zeus transactions;
- importing user edits from Pendings.xlsx or generating operational workbooks
  during startup, query, or save;
- draggable column resizing;
- arbitrary/custom managed Excel columns or formulas;
- sending email or attaching generated workbooks automatically;
- email attachments in Excel or the dashboard grid;
- new Outlook, direct OST parsing, sending, moving, deleting, or marking mail;
- reopening completed/cancelled Spare Request items;
- ticket identifiers other than exactly eight decimal digits.
