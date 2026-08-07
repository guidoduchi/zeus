# Zeus 3.0.0 release scope

Included:

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
- email subjects, bodies, or attachments in Excel or the dashboard grid;
- new Outlook, direct OST parsing, sending, moving, deleting, or marking mail;
- closed-ticket search outside `Closed.xlsx`;
- ticket identifiers other than exactly eight decimal digits.
