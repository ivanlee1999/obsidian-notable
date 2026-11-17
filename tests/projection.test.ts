import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Library } from "../src/projection.ts";
import type { FolderDoc, NotebookDoc, PageTextDoc } from "../src/model.ts";
import { flowingText } from "../src/model.ts";

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

test("new blank names follow typed content, keep journal links stable and preserve every manual name", () => {
  const lib = new Library();
  const book = notebook({ _id: "notebook:book-1", title: "" });
  const organization = { _id: "journal:book-1", type: "journal", schema: 1, notebookId: "book-1", date: "2026-11-16", createdAt: 1,
    topics: { work: { name: "Work", present: true, counter: 1, writer: "boox" },
      removed: { name: "Removed", present: false, counter: 2, writer: "ipad" } } };
  lib.applyNotebook(book); lib.applyOrganizationSnapshot([organization]);
  const source = { _id: "page:page-1", _rev: "1-typed", notebookId: "book-1", blocks: [{ id: "body", kind: "md", text: "# Project plan\n\nExact original body" }] };
  lib.applyPageContents([source]);
  const preserved = JSON.stringify({ book, source, organization });
  const initial = lib.plan("Notes"), entry = initial.find(note => !note.kind)!;
  assert.match(entry.contents, /title: "Project plan"/);
  assert.ok(initial.filter(note => note.kind).every(note => note.contents.includes("[Project plan]")));
  assert.equal(JSON.stringify({ book, source, organization }), preserved);
  lib.applyPageContents([{ ...source, _rev: "2-typed", blocks: [{ id: "body", kind: "md", text: "# Revised plan" }] }]);
  const revised = lib.plan("Notes");
  assert.equal(revised.find(note => !note.kind)!.path, entry.path);
  assert.match(revised.find(note => !note.kind)!.contents, /title: "Revised plan"/);
  assert.deepEqual(lib.snapshot().organization, [organization]);
  for (const name of ["My title", "Untitled", "New notebook", "16 Nov 2026 12:45"]) {
    lib.applyNotebook({ ...book, title: name });
    assert.ok(lib.plan("Notes").find(note => !note.kind)!.contents.includes(`title: ${JSON.stringify(name)}\n`));
  }
});

test("automatic handwriting names require current owned source and disappear after erasing", () => {
  const lib = new Library(), book = notebook({ _id: "notebook:book-1", title: "" });
  const source = { _id: "page:page-1", _rev: "1-ink", notebookId: "book-1", blocks: [] };
  const recognized = text({ _id: "pagetext:page-1", pageId: "page-1", notebookId: "book-1", sourceRev: "1-ink",
    sourceFingerprint: "sha256:" + "a".repeat(64), pipelineVersion: "scribe-v2:" + "b".repeat(64), text: "# Meal plan" });
  lib.applyNotebook(book); lib.applyPageContents([source]); lib.applyText(recognized);
  assert.equal(lib.plan("Notes")[0].path, "Notes/Meal plan.md");
  for (const invalid of [
    { sourceRev: undefined }, { sourceFingerprint: undefined }, { pipelineVersion: undefined },
    { pageId: "different" }, { notebookId: "different" },
  ]) {
    lib.applyText({ ...recognized, ...invalid });
    const note = lib.plan("Notes")[0];
    assert.equal(note.path, "Notes/Untitled.md");
    assert.doesNotMatch(note.contents, /## Page 1 — Meal plan/);
    assert.match(note.contents, /Meal plan/); // Body compatibility remains available.
  }
  lib.applyText(recognized);
  lib.applyPageContents([{ ...source, _rev: "2-ink" }]);
  assert.equal(lib.plan("Notes")[0].path, "Notes/Untitled.md");
  lib.applyText({ ...recognized, sourceRev: "2-ink", notebookId: "different", text: "Foreign name" });
  assert.equal(lib.plan("Notes")[0].path, "Notes/Untitled.md");
  lib.applyText({ ...recognized, sourceRev: "2-ink", text: "# Revised meal" });
  assert.equal(lib.plan("Notes")[0].path, "Notes/Revised meal.md");
  lib.applyNotebook({ ...book, title: "Pinned by hand" });
  lib.applyText({ ...recognized, sourceRev: "2-ink", text: "# Late recognition" });
  assert.equal(lib.plan("Notes")[0].path, "Notes/Pinned by hand.md");
  lib.applyNotebook(book); lib.applyPageContents([{ ...source, _rev: "3-erased" }]);
  lib.applyText({ ...recognized, sourceRev: "3-erased", text: "" });
  assert.equal(lib.plan("Notes")[0].path, "Notes/Untitled.md");
  assert.equal(book.title, "");
});

test("derived names cannot recreate wiki-links or tags removed from the organization", () => {
  const lib = new Library();
  lib.applyNotebook(notebook({ _id: "notebook:book-1", title: "" }));
  lib.applyPageContents([{ _id: "page:page-1", notebookId: "book-1", blocks: [{ id: "b", text: "[[Private|Visible]] #removed" }] }]);
  lib.applyOrganizationSnapshot([{ _id: "journal:book-1", type: "journal", schema: 1, notebookId: "book-1", date: "2026-11-16", createdAt: 1,
    topics: { work: { name: "Work", present: true, counter: 1, writer: "boox" }, removed: { name: "removed", present: false, counter: 2, writer: "ipad" } } }]);
  const plan = lib.plan("Notes");
  const entry = plan.find(note => !note.kind)!;
  assert.match(entry.contents, /title: "Visible #removed"/);
  assert.match(entry.contents, /topics: \["Work"\]/);
  for (const index of plan.filter(note => note.kind)) {
    assert.match(index.contents, /\[Visible &#35;removed\]/);
    assert.doesNotMatch(index.contents, /\[\[Private|(?<!&)#removed/);
  }
});

test("automatic names follow live page order and collisions use resolved names", () => {
  const lib = new Library();
  lib.applyNotebook(notebook({ _id: "notebook:first", title: "", pageIds: ["empty", "named", "later"] }));
  lib.applyNotebook(notebook({ _id: "notebook:second", title: "", pageIds: ["other"] }));
  lib.applyPageContents([
    { _id: "page:later", notebookId: "first", blocks: [{ id: "b", text: "Later content" }] },
    { _id: "page:other", notebookId: "second", blocks: [{ id: "b", text: "Different" }] },
    { _id: "page:named", notebookId: "first", title: "Page name", blocks: [{ id: "b", text: "Typed content" }] },
    { _id: "page:empty", notebookId: "first", blocks: [] },
  ]);
  assert.deepEqual(lib.plan("Notes").map(note => note.path), ["Notes/Page name.md", "Notes/Different.md"]);
  lib.applyPageContents([{ _id: "page:empty", notebookId: "first", blocks: [{ id: "b", text: "First page" }] }]);
  assert.equal(lib.plan("Notes")[0].path, "Notes/First page.md");
  lib.applyPageContents([{ _id: "page:other", notebookId: "second", blocks: [{ id: "b", text: "First page" }] }]);
  const collision = lib.plan("Notes");
  assert.equal(new Set(collision.map(note => note.path)).size, 2);
  assert.deepEqual(collision.map(note => note.path), ["Notes/First page ~first.md", "Notes/First page ~second.md"]);
});

test("removing every typed block clears an automatic name while retaining the empty notebook", () => {
  const lib = new Library();
  const book = notebook({ _id: "notebook:book-1", title: "" });
  lib.applyNotebook(book);
  lib.applyPageContents([{ _id: "page:page-1", _rev: "1", notebookId: "book-1", blocks: [{ id: "body", text: "# Old content" }] }]);
  assert.equal(lib.plan("Notes")[0].path, "Notes/Old content.md");
  const erased = { _id: "page:page-1", _rev: "2", notebookId: "book-1", blocks: [], deletedBlocks: [{ id: "body" }] };
  lib.applyPageContents([erased]);
  const note = lib.plan("Notes")[0];
  assert.equal(note.path, "Notes/Untitled.md");
  assert.doesNotMatch(note.contents, /Old content/);
  assert.deepEqual(lib.snapshot().pageContents, [erased]);
  assert.equal(book.title, "");
});

test("typed blocks render without OCR and preserve their source across restart and missing arrivals", () => {
  const lib = new Library();
  lib.applyNotebook(notebook({ _id: "notebook:book-1" }));
  lib.applyPageContents([{ _id: "page:page-1", notebookId: "book-1", blocks: [
    { id: "b", kind: "md", orderKey: "20", text: "Second paragraph" },
    { id: "a", kind: "md", orderKey: "10", text: "# First paragraph" },
    { id: "placed", kind: "md", text: "Placed annotation", x: 10, y: 20 },
    { id: "removed", kind: "md", text: "Deleted paragraph" },
  ], deletedBlocks: [{ id: "removed" }] }]);
  assert.equal(lib.isEmpty, false);
  const before = lib.plan("Notes");
  assert.equal(before.length, 1);
  assert.match(before[0].contents, /# First paragraph\n\nSecond paragraph/);
  assert.doesNotMatch(before[0].contents, /Not recognized|Placed annotation|Deleted paragraph/);
  const restored = new Library();
  assert.equal(restored.restore(lib.snapshot()), true);
  restored.replaceLibrary([notebook({ _id: "notebook:book-1" })], []);
  restored.applyPageContents([]);
  assert.deepEqual(restored.plan("Notes"), before);
  restored.applyPageContents([{ _id: "page:page-1", notebookId: "book-1", blocks: [] }]);
  assert.deepEqual(restored.plan("Notes"), []);
});

test("flow ordering is bytewise and recovered sources are separate, deduplicated and remove-wins", () => {
  const flow = flowingText({ _id: "page:p", notebookId: "b", blocks: [
    { id: "astral", kind: "md", orderKey: "😀", text: "last" },
    { id: "bmp", kind: "md", orderKey: "\uE000", text: "first", x: 4 },
    { id: "text-version:p:b", kind: "text-version", text: "previous" },
    { id: "text-version:p:a", kind: "text-version", text: "previous" },
    { id: "text-version:p:c", kind: "text-version", text: "last" },
    { id: "text-version:p:d", kind: "text-version", text: "removed version" },
  ], deletedBlocks: [{ id: "text-version:p:d" }] });
  assert.deepEqual(flow, { text: "first\n\nlast", versions: ["previous"] });
});

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

test("exact source revisions detect new ink even when clocks stay equal or move backwards", () => {
  for (const updatedAt of ["2026-08-18T04:00:00.000Z", "2026-08-18T03:00:00.000Z"]) {
    const lib = library();
    lib.applyText(text({ _id: "pagetext:page-1", sourceRev: "2-old" }));
    lib.applyPageContents([{ _id: "page:page-1", _rev: "3-new", notebookId: "book-1", updatedAt }]);
    const note = lib.plan("Handwritten")[0].contents;
    assert.match(note, /Updating handwriting transcription/);
    assert.match(note, /milk, eggs/);

    lib.applyText(text({ _id: "pagetext:page-1", sourceRev: "3-new", text: "milk, eggs, bread" }));
    const current = lib.plan("Handwritten")[0].contents;
    assert.doesNotMatch(current, /Updating handwriting transcription/);
    assert.match(current, /milk, eggs, bread/);
  }
});

test("revision-aware recognition remains marked updating until its source is known, including after restart", () => {
  const lib = library();
  lib.applyText(text({ _id: "pagetext:page-1", sourceRev: "2-current" }));
  assert.match(lib.plan("Handwritten")[0].contents, /Updating handwriting transcription/);
  lib.applyPageContents([{ _id: "page:page-1", _rev: "2-current", notebookId: "book-1" }]);
  assert.doesNotMatch(lib.plan("Handwritten")[0].contents, /Updating handwriting transcription/);

  const restored = new Library();
  restored.restore(lib.snapshot());
  restored.replaceLibrary([notebook({ _id: "notebook:book-1" })], []);
  assert.deepEqual(restored.plan("Handwritten"), lib.plan("Handwritten"));
  restored.applyPageContents([{ _id: "page:page-1", _rev: "3-new", notebookId: "book-1" }]);
  assert.match(restored.plan("Handwritten")[0].contents, /Updating handwriting transcription/);
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
