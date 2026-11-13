import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Library } from "../src/projection.ts";
import type { FolderDoc, NotebookDoc, PageTextDoc } from "../src/model.ts";

const notebook = (overrides: Partial<NotebookDoc> & { _id: string }): NotebookDoc => ({
  title: "Notes",
  pageIds: ["page-1"],
  parentFolderId: null,
  ...overrides,
});

const text = (overrides: Partial<PageTextDoc> & { _id: string }): PageTextDoc => ({
  text: "milk, eggs",
  engine: "myscript",
  recognizedClock: "2026-08-18T04:00:00.000Z",
  ...overrides,
});

const folder = (overrides: Partial<FolderDoc> & { _id: string }): FolderDoc => ({
  title: "Work",
  parentFolderId: null,
  ...overrides,
});

function library(): Library {
  const lib = new Library();
  lib.applyNotebook(notebook({ _id: "notebook:book-1" }));
  lib.applyText(text({ _id: "pagetext:page-1" }));
  return lib;
}

test("a notebook with recognized text becomes one note", () => {
  const plan = library().plan("Handwritten");

  assert.equal(plan.length, 1);
  assert.equal(plan[0].path, "Handwritten/Notes.md");
  assert.match(plan[0].contents, /milk, eggs/);
});

test("a notebook nobody has recognized yet produces no note at all", () => {
  // Otherwise pointing the plugin at an established library fills the vault with hundreds of
  // notes that say only "Not recognized yet", which is worse than an empty folder.
  const lib = new Library();
  lib.applyNotebook(notebook({ _id: "notebook:book-1" }));

  assert.deepEqual(lib.plan("Handwritten"), []);
});

test("a trashed notebook is not written", () => {
  const lib = library();
  lib.applyNotebook(notebook({ _id: "notebook:book-1", deletedAt: "2026-08-18T05:00:00.000Z" }));

  assert.deepEqual(lib.plan("Handwritten"), []);
});

test("trashing a folder hides everything inside it", () => {
  // Trashing a folder does not restamp its contents, so a notebook inside one still looks live on
  // its own — the ancestry has to be walked or the vault keeps notes the user thinks they binned.
  const lib = library();
  lib.applyFolder(folder({ _id: "folder:f1", deletedAt: "2026-08-18T05:00:00.000Z" }));
  lib.applyNotebook(notebook({ _id: "notebook:book-1", parentFolderId: "f1" }));

  assert.deepEqual(lib.plan("Handwritten"), []);
});

test("a notebook nested below a trashed folder is hidden too", () => {
  const lib = library();
  lib.applyFolder(folder({ _id: "folder:top", deletedAt: "2026-08-18T05:00:00.000Z" }));
  lib.applyFolder(folder({ _id: "folder:mid", parentFolderId: "top" }));
  lib.applyNotebook(notebook({ _id: "notebook:book-1", parentFolderId: "mid" }));

  assert.deepEqual(lib.plan("Handwritten"), []);
});

test("a notebook whose parent has not arrived remains available", () => {
  const lib = library();
  lib.applyNotebook(notebook({ _id: "notebook:book-1", parentFolderId: "vanished" }));

  assert.equal(lib.plan("Handwritten").length, 1);
});

test("a cycle in the folder chain does not hang the sync", () => {
  const lib = library();
  lib.applyFolder(folder({ _id: "folder:a", parentFolderId: "b" }));
  lib.applyFolder(folder({ _id: "folder:b", parentFolderId: "a" }));
  lib.applyNotebook(notebook({ _id: "notebook:book-1", parentFolderId: "a" }));

  // Whatever it decides, it has to decide it and return.
  lib.plan("Handwritten");
});

test("folders become the note's path", () => {
  const lib = library();
  lib.applyFolder(folder({ _id: "folder:top", title: "Work" }));
  lib.applyFolder(folder({ _id: "folder:mid", title: "2026", parentFolderId: "top" }));
  lib.applyNotebook(notebook({ _id: "notebook:book-1", parentFolderId: "mid" }));

  assert.equal(lib.plan("Handwritten")[0].path, "Handwritten/Work/2026/Notes.md");
});

test("pages appear in the notebook's order, not the order their text arrived", () => {
  const lib = new Library();
  lib.applyNotebook(notebook({ _id: "notebook:book-1", pageIds: ["p1", "p2", "p3"] }));
  lib.applyText(text({ _id: "pagetext:p3", text: "third" }));
  lib.applyText(text({ _id: "pagetext:p1", text: "first" }));
  lib.applyText(text({ _id: "pagetext:p2", text: "second" }));

  const body = lib.plan("Handwritten")[0].contents;
  assert.ok(body.indexOf("first") < body.indexOf("second"));
  assert.ok(body.indexOf("second") < body.indexOf("third"));
});

test("text is stale when its page was written on afterwards", () => {
  const lib = library();
  lib.notePageClock("page-1", "2026-08-18T06:00:00.000Z");

  assert.match(lib.plan("Handwritten")[0].contents, /written on since it was last recognized/);
});

test("text is not stale when the page has not moved since", () => {
  const lib = library();
  lib.notePageClock("page-1", "2026-08-18T04:00:00.000Z");

  assert.doesNotMatch(lib.plan("Handwritten")[0].contents, /written on since/);
});

test("an unknown page clock is not treated as staleness", () => {
  // The plugin does not read page documents, so it usually has no clock at all. Guessing would
  // put a warning on every page in the vault.
  assert.doesNotMatch(library().plan("Handwritten")[0].contents, /written on since/);
});

test("a deleted text document removes its text without removing the note", () => {
  const lib = new Library();
  lib.applyNotebook(notebook({ _id: "notebook:book-1", pageIds: ["p1", "p2"] }));
  lib.applyText(text({ _id: "pagetext:p1", text: "kept" }));
  lib.applyText(text({ _id: "pagetext:p2", text: "removed" }));

  lib.applyText({ _id: "pagetext:p2", _deleted: true });

  const body = lib.plan("Handwritten")[0].contents;
  assert.match(body, /kept/);
  assert.doesNotMatch(body, /removed/);
  assert.match(body, /## Page 2\n\n\*Not recognized yet\.\*/);
});

test("text for a page no notebook lists is reported as orphaned", () => {
  const lib = library();
  lib.applyText(text({ _id: "pagetext:page-gone" }));

  assert.deepEqual(lib.orphanedTextIds(), ["page-gone"]);
});

test("text belonging to a trashed notebook counts as orphaned", () => {
  const lib = library();
  lib.applyNotebook(notebook({ _id: "notebook:book-1", deletedAt: "2026-08-18T05:00:00.000Z" }));

  assert.deepEqual(lib.orphanedTextIds(), ["page-1"]);
});

test("two notebooks sharing a name get separate notes", () => {
  const lib = new Library();
  lib.applyNotebook(notebook({ _id: "notebook:aaaa1111", title: "Journal", pageIds: ["p1"] }));
  lib.applyNotebook(notebook({ _id: "notebook:bbbb2222", title: "Journal", pageIds: ["p2"] }));
  lib.applyText(text({ _id: "pagetext:p1" }));
  lib.applyText(text({ _id: "pagetext:p2" }));

  const paths = lib.plan("Handwritten").map((note) => note.path);
  assert.equal(new Set(paths).size, 2);
});

test("notebooks with the same name in different folders keep their plain names", () => {
  const lib = new Library();
  lib.applyFolder(folder({ _id: "folder:a", title: "Work" }));
  lib.applyFolder(folder({ _id: "folder:b", title: "Home" }));
  lib.applyNotebook(
    notebook({ _id: "notebook:1", title: "Journal", pageIds: ["p1"], parentFolderId: "a" }),
  );
  lib.applyNotebook(
    notebook({ _id: "notebook:2", title: "Journal", pageIds: ["p2"], parentFolderId: "b" }),
  );
  lib.applyText(text({ _id: "pagetext:p1" }));
  lib.applyText(text({ _id: "pagetext:p2" }));

  const paths = lib.plan("Handwritten").map((note) => note.path).sort();
  assert.deepEqual(paths, ["Handwritten/Home/Journal.md", "Handwritten/Work/Journal.md"]);
});

test("a deleted notebook takes its note with it", () => {
  const lib = library();
  lib.applyNotebook({ _id: "notebook:book-1", _deleted: true });

  assert.deepEqual(lib.plan("Handwritten"), []);
});

test("an untitled notebook still gets a usable name", () => {
  const lib = new Library();
  lib.applyNotebook(notebook({ _id: "notebook:book-1", title: "  " }));
  lib.applyText(text({ _id: "pagetext:page-1" }));

  assert.equal(lib.plan("Handwritten")[0].path, "Handwritten/Untitled.md");
});

// --- Surviving a restart -------------------------------------------------------------
//
// Notebooks and folders are re-read whole on every sync, but page text arrives through a
// checkpointed feed: once the checkpoint has moved past a document, that document is never
// sent again. So the text projection has to outlive the process, or the plugin wakes up
// believing the library has no text at all — and a library with no text plans no notes, which
// is indistinguishable from "every notebook was deleted".

test("a restored snapshot plans the same notes as the live projection", () => {
  const before = library();
  const planBefore = before.plan("Handwritten");

  const after = new Library();
  // What a restart really looks like: the library documents come back from the server, the
  // text does not, and only the snapshot can supply it.
  after.applyNotebook(notebook({ _id: "notebook:book-1" }));
  const restored = after.restore(before.snapshot());

  assert.equal(restored, true);
  assert.deepEqual(after.plan("Handwritten"), planBefore);
});

test("a library with no text plans nothing, which is why the snapshot matters", () => {
  const starved = new Library();
  starved.applyNotebook(notebook({ _id: "notebook:book-1" }));

  assert.equal(starved.isEmpty, true);
  // An empty plan is not "no changes" to the caller — every managed note is stranded by it and
  // would be trashed. main.ts refuses to write the vault in this state.
  assert.deepEqual(starved.plan("Handwritten"), []);
});

test("restore reports failure for a missing or unknown snapshot", () => {
  const lib = new Library();
  assert.equal(lib.restore(undefined), false);
  // A snapshot from a future version is not guessed at; the caller resets the checkpoint and
  // reads the feed again rather than planning against half-understood data.
  assert.equal(lib.restore({ version: 2 } as never), false);
  assert.equal(lib.isEmpty, true);
});

test("a snapshot round-trips page clocks, so staleness survives a restart too", () => {
  const before = library();
  before.notePageClock("page-1", "2026-08-19T04:00:00.000Z");

  const after = new Library();
  after.applyNotebook(notebook({ _id: "notebook:book-1" }));
  after.restore(before.snapshot());

  // The clock is newer than the recognized text, so the note carries the written-on-since
  // marker — which it would not if the clocks had been dropped on the way through.
  assert.match(
    after.plan("Handwritten")[0].contents,
    /written on since it was last recognized/i,
  );
});
