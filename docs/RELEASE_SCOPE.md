# Zeus 3.1.2 release scope

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
- newline-only multiple faulty serials per BOM group, kept independent from its
  quantity multiplier throughout Markdown state and request/fault-tag XLSX rows;

- a Service Requests / Spare Requests workspace switcher with independent
  search, sort, direction, and field preferences;
- independent active Spare Request Markdown records, unit-level items, partial
  stock, requested/delivered BOM separation, immutable RMAs, and visible
  conflict handling;
- Active Requests, reusable Eligible SR Parts, and Completed archive subviews;
- configurable local request/return XLSX templates and a one-way export root,
  with exact sheet preservation, dynamic row extension, and revision-safe names;
- LASpare confirmation, iCare dispatch/substitution, and exact ITSAnet warehouse
  candidate parsing from HTML with plain-text fallback and out-of-order replay;
- explicit partial return export, user-confirmed archive, mandatory cancellation
  reasons, manual-override notes, and dedicated Closed.xlsx archive/email tabs;
- local-only structured Global data and BOM managers that ship empty plus fixed
  180-day active-email and completed-archive retention;
- bundled React/TypeScript master-detail interface served by Python;
- strict `127.0.0.1` binding, local Host/Origin/CSRF controls, and no CORS;
- browser launch, Windows notification-area lifecycle, clean restart/exit, and
  verified multi-instance `zeus_stop.bat` shutdown;
- Pendings-only database bootstrap without Closed, Advanced Search, or Outlook;
- safe Pendings-first browser edits with optimistic ticket and workbook
  conflict detection, candidate validation, backups, rollback, and audit;
- independent ticket-list and detail scrolling; no whole-page scrolling;
- fixed-width columns with locally persisted visibility and order controls;
- severity in the default dense dashboard plus every original CLI fact;
- locally persisted dark/light theme, sort field, and ascending/descending
  direction;
- page-level `S`, `M`, `R`, and Ctrl+F commands outside editable controls;
- fixed Work/Spare action rails that remain above the global command strip;
- a normalized, repeatable damaged-device and spare-parts editor backed by a
  one-row-per-part Pendings worksheet and legacy scalar migration;
- a default dashboard Emails column showing cumulative messages found;
- visible serialized startup, scheduled, and manual source-query work;
- page refreshes that never trigger a source query;
- Pendings-only queries that succeed with an informational skip when no
  Advanced Search workbook is available;
- database-driven recreation of a deleted Pendings workbook during Query or
  Save, without backup restoration, Closed creation, or closure finalization;
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
- direct Markdown work-field editing;
- draggable column resizing;
- arbitrary/custom managed Excel columns or formulas;
- sending email or attaching generated workbooks automatically;
- email attachments in Excel or the dashboard grid;
- new Outlook, direct OST parsing, sending, moving, deleting, or marking mail;
- reopening completed/cancelled Spare Request items;
- ticket identifiers other than exactly eight decimal digits.
