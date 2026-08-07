# Changelog

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
- Made Spare a read-only invariant derived from BOM (`Y` when present, otherwise
  `N`) across Pendings import, web edits, Markdown, and publication.
- Replaced free-form Planned Date entry with a native browser calendar that
  writes a canonical Excel date cell.
- Made the Chrome/Edge save regression use browser-specific values so each
  project exercises a real Pendings transaction.

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
