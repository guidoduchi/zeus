# Changelog

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
