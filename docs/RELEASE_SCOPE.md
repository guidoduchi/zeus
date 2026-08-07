# Zeus 3.1.0 release scope

Included:

- an extensible Service Requests / Spare Parts workspace switcher with
  independent search, sort, direction, and field preferences;
- a dense one-row-per-part Spare Parts management projection that opens the
  parent SR's normalized editor and never becomes a second authority;
- mandatory SR ownership with SR pinned as the first column, plus read-only
  continuity for finalized spare-parts rows through validated Closed.xlsx;
- a configurable, nullable, one-way Spare Parts export destination that is
  excluded from all source queries and imports;
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
- the final Spare Part Request XLSX columns/layout until its format is agreed;
- email subjects, bodies, or attachments in Excel or the dashboard grid;
- new Outlook, direct OST parsing, sending, moving, deleting, or marking mail;
- closed Service Request management outside `Closed.xlsx` (the Spare Parts
  workspace exposes only its archived non-email hardware projection);
- ticket identifiers other than exactly eight decimal digits.
