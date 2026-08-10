# Zeus 3.1.5 release scope

Included:

- mandatory first-run local profile setup with name, email, and phone required;
  optional local picture and username; no login, password, or remote account;
- a global structured manager for customer organizations, organization-owned
  contacts, independent sites, the current-user requester, and pinned extra
  requesters, with BOM catalog management retained in Spare Requests;
- selectable data storage with a full-clone-plus-20-MiB capacity gate,
  verified restart handoff, safe rollback, and post-restart original deletion;
- autocomplete Spare Request inputs, automatically derived customer initials,
  one unified customer-contact name, and an explicit configuration prompt when
  export destinations or templates are absent;
- slot-derived physical-unit, future-RMA, and Fault Tag expansion, with a manual
  multiplier for slotless groups and every unit retaining the damaged device's
  newline-delimited faulty serial evidence together in one cell;
- a Service Requests / Spare Requests workspace switcher with independent
  search, sort, direction, and field preferences;
- independent active Spare Request Markdown records, unit-level items, partial
  stock, requested/delivered BOM separation, immutable RMAs, and visible
  conflict handling;
- Active Requests, reusable Eligible SR Parts, and Completed archive subviews;
- configurable local request/return XLSX templates and a one-way export root,
  with exact sheet preservation, dynamic row extension, and revision-safe names;
- locally configured confirmation sender, dispatch/substitution sender, and
  warehouse domain parsing from HTML with plain-text fallback and out-of-order
  replay;
- explicit partial return export, user-confirmed archive, mandatory cancellation
  reasons, manual-override notes, and dedicated Closed.xlsx archive/email tabs;
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
  plus click/Enter-only activation and closed-detail customer-contact context;
- a bounded, themed SR-number-prefix autocomplete in Global data and persisted
  Compact, Standard, and Large interface typography presets;
- severity in the default dense dashboard, MW as the UI label for `Done?`, and
  Last Email combining age plus count without a separate count column;
- locally persisted dark/light theme, filters, sort field, and
  ascending/descending direction;
- page-level `S`, `M`, `R`, Ctrl+F, and navigation arrows outside editable
  controls; ↑/↓ follows filtered order and ←/→ changes detail tabs without wrap;
- browser-persisted Work/Spare drafts, row-move notices, stale-draft recovery,
  and reload protection until a draft is saved or discarded;
- visible protected-draft row markers plus a selectable Drafts manager for
  review, explicit restore, selective discard, and confirmed all-or-nothing
  multi-SR database saves;
- overlap-aware three-way draft rebasing, so unrelated database changes do not
  create false conflicts and a successful save cannot recreate its own draft;
- keyboard focus that follows the selected row and active detail tab instead of
  leaving a stale cyan focus rectangle on an earlier control;
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
- service filters for Planning/MW/Severity and Spare Request filters for Status,
  dispatch risk, Site, Cloud, conflicts, and RMA state, using OR-within/AND-across;
- visible serialized startup, scheduled, and manual Advanced Search checks;
- page refreshes that never trigger a source query and cannot silently discard
  protected drafts;
- Advanced Search checks that discover/refresh tickets and defer missing-record
  deletion until the next successful explicit export;
- optional Outlook behavior that is disabled clearly and nonfatally when no
  valid store exists;
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
