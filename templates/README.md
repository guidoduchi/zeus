# MOP templates

Keep master `.docx` templates here or configure another directory. Zeus never edits a master template. It creates a new version in the ticket's `mops/` folder.

Run `zeus mop fields <SRNo>` to see every available placeholder and `zeus mop generate <SRNo> --template <file.docx>` to generate a draft.

Zeus replaces placeholders in normal paragraphs, tables, headers, and footers. It intentionally leaves Word drawing text boxes and content controls untouched. Template generation is an output operation only; ticket work fields remain Pendings-owned even when edited through the Zeus web panel.
