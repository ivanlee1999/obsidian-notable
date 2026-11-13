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

Journal entries also carry `journal-date` and a `topics` list containing the exact topic labels.
They appear even before handwriting recognition has run. Their managed files have stable paths
under `Entries`; generated `Journal` day indexes and `Topics` indexes link to those originals.
Topic labels stay in `topics` rather than being flattened into Obsidian hashtags, which cannot
represent every handwritten topic name faithfully.

This remains a read-only projection of the tablets. Edit topics and journal notes in Notable or
Bopa. Your own Obsidian daily notes can link or embed the generated indexes; the plugin does not
rewrite those daily notes or upload edits made in generated frontmatter.

## What it will and will not touch

Every generated file carries `managed-by: "notable-handwriting"` and a stable identity.

- It only ever modifies or deletes files carrying that marker, inside the folder you configure.
- Delete the marker line from a note and the plugin will leave it alone from then on — that is
  how you take a note into your own keeping.
- Renaming a notebook updates the same generated note. Journal entry paths remain stable.
- Trashing a notebook on the tablet moves its note to the system trash, recoverable.
- A missing notebook or unavailable database never counts as an instruction to delete a note.
- File collisions preserve manual files and differently owned generated notes.

## Setup

1. Provision CouchDB with Bopa's `provision.sh`, including `notes`, `notes_text`, and
   `notes_organization`. For a custom notes database, organization uses its name plus `_organization`.
2. Turn on recognition in the tablet apps' sync settings if you want transcripts as well as metadata.
3. Install this plugin, and fill in the server URL, credentials, and databases.
4. "Test" checks the configured databases; "Sync handwriting now" pulls immediately.

Rendered handwriting is read from `notes_images` and cached under `_ink` beside the notes.
Leave Images database empty for transcripts only. Turn on "Handwriting beside the text" to use
the bundled side-by-side layout. Existing image caches and this preference survive upgrades;
image read failures leave the previous notes intact, and old cached images are retained.

The plugin polls while Obsidian is open — it is not a background service, so a vault that has
been closed for a week catches up when you next open it.

## Databases

| Database | Access | Why |
|---|---|---|
| `notes` | read | Notebook names, page order, folders. Page documents are never fetched — they hold stroke data. |
| `notes_text` | read | One `pagetext:<pageId>` document per recognized page. |
| `notes_organization` | read | Capture dates and independently versioned topic assignments/removals. |
| `notes_images` | read | Optional `pageimage:<pageId>` records and rendered `page.png` attachments. |

The last valid organization snapshot is cached with its server/database identity. A failed or
malformed snapshot leaves the existing generated files unchanged. Keep the organization database
in the same backup/restore plan as your ink database; its tag removal markers are authoritative.

The document shape is specified in `docs/recognized-text.md` in the bopa repo, which the two
tablet apps implement against too.

## Development

```bash
npm install
npm test          # the rendering and projection logic, no Obsidian needed
npm run build     # typecheck, then bundle to main.js
npm run dev       # rebuild on change
```
