# Notable Handwriting

Brings handwriting recognized on a BOOX (notable) or iPad (bopa) into an Obsidian vault as notes.

The tablets recognize their own ink — the BOOX through its firmware's MyScript engine, the iPad
through Apple's Vision framework — and publish the text to a CouchDB database. This plugin reads
that database and writes one note per notebook.

Nothing recognizes handwriting here. If a page has no text in the vault, no tablet has read it
yet.

## What it writes

One note per notebook, mirroring the tablets' folders:

```markdown
---
title: "Groceries"
created: "2026-07-02T18:40:11Z"
updated: "2026-08-18T04:11:02Z"
notable-id: "b1bf438e-a332-4709-873b-ec034bf33b2c"
managed-by: "notable-handwriting"
---

## Page 1

milk, eggs
bread

## Page 2 — Thursday

<!-- This page has been written on since it was last recognized. -->
call the plumber
```

Notes are regenerated whole on every sync rather than patched, so a replayed change feed, a
restarted plugin, or a lost checkpoint all produce the same file rather than a doubled one.

## What it will and will not touch

Every note it writes carries `managed-by: "notable-handwriting"` and the notebook's id.

- It only ever modifies or deletes files carrying that marker, inside the folder you configure.
- Delete the marker line from a note and the plugin will leave it alone from then on — that is
  how you take a note into your own keeping.
- Renaming a notebook on the tablet renames the note here rather than creating a second one, so
  links to it survive.
- Trashing a notebook on the tablet moves its note to the system trash, recoverable.

## Setup

1. Provision the text database on your CouchDB — `provision.sh` in the bopa repo creates both
   `notes` and `notes_text`.
2. Turn on recognition in the tablet apps' sync settings.
3. Install this plugin, and fill in the server URL, credentials, and databases.
4. "Test" checks both databases are reachable; "Sync handwriting now" pulls immediately.

The plugin polls while Obsidian is open — it is not a background service, so a vault that has
been closed for a week catches up when you next open it.

## Databases

| Database | Access | Why |
|---|---|---|
| `notes` | read | Notebook names, page order, folders. Page documents are never fetched — they hold stroke data. |
| `notes_text` | read | One `pagetext:<pageId>` document per recognized page. |

The document shape is specified in `docs/recognized-text.md` in the bopa repo, which the two
tablet apps implement against too.

## Development

```bash
npm install
npm test          # the rendering and projection logic, no Obsidian needed
npm run build     # typecheck, then bundle to main.js
npm run dev       # rebuild on change
```
