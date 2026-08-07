# Zeus 2.0.2 release scope

Included:

- exact eight-digit SR validation;
- permanent startup Pendings import with field ownership and protected-cell
  baseline validation;
- filename/timestamp/hash Advanced Search discovery and reconciliation;
- deferred `closure_pending` lifecycle and verified final deletion;
- self-contained Markdown ticket records;
- separate Outlook fetch staging and scheduled/after-fetch synchronization;
- cumulative email deduplication, newest-N full bodies, incremental overlap,
  cancellation, and full-history rebuild;
- read-only arrow-key dashboard, partial Ctrl+F search, details, sorting, and
  operations menu;
- two-sheet Pendings output, append-only Closed output, paired rollback and
  backups;
- per-cell fill/font preservation, reordered known columns, and literal-only
  workbook validation;
- configurable calendar-day report thresholds and midnight refresh;
- crash-safe Pendings-backup restore;
- versioned MOP output generation;
- Windows setup and PyInstaller build scripts.

Deliberately excluded:

- editing ticket work fields in the CLI;
- arbitrary/custom Excel columns;
- formulas in managed workbooks;
- email bodies, subjects, or attachments in Excel;
- new Outlook, direct OST parsing, shared-mailbox lookup by name, sending,
  moving, deleting, or marking messages;
- closed-ticket search outside `Closed.xlsx`;
- ticket ID formats other than eight decimal digits.
