import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  MANAGED_BY,
  notePath,
  pageLabel,
  renderNote,
  sanitizeFilename,
  yamlString,
} from "../src/render.ts";
import type { PageEntry } from "../src/model.ts";

const page = (overrides: Partial<PageEntry> = {}): PageEntry => ({
  pageId: "page-1",
  number: 1,
  title: null,
  text: "milk, eggs",
  stale: false,
  inkPath: null,
  ...overrides,
});

test("a note carries the marker that makes it the plugin's to overwrite", () => {
  const note = renderNote({ notebookId: "book-1", title: "Groceries", pages: [page()] });

  assert.match(note, new RegExp(`managed-by: "${MANAGED_BY}"`));
  assert.match(note, /notable-id: "book-1"/);
});

test("pages are numbered and titled from the notebook's order", () => {
  const note = renderNote({
    notebookId: "book-1",
    title: "Notes",
    pages: [page({ number: 1 }), page({ number: 2, title: "Second thoughts", text: "later" })],
  });

  // An untitled page takes its label from the first line it was read as; an explicit page title
  // wins over that.
  assert.match(note, /## Page 1 — milk, eggs/);
  assert.match(note, /## Page 2 — Second thoughts/);
});

test("a page nobody has recognized says so instead of appearing empty", () => {
  const note = renderNote({
    notebookId: "book-1",
    title: "Notes",
    pages: [page({ text: null })],
  });

  assert.match(note, /\*Not recognized yet\.\*/);
});

test("a page with no writing on it reads differently from one never recognized", () => {
  // The difference matters: one is waiting on a tablet, the other is a blank page.
  const note = renderNote({ notebookId: "b", title: "N", pages: [page({ text: "   " })] });

  assert.match(note, /\*No handwriting found on this page\.\*/);
  assert.doesNotMatch(note, /Not recognized yet/);
});

test("stale text is flagged in a comment, not in the prose", () => {
  const note = renderNote({
    notebookId: "book-1",
    title: "Notes",
    pages: [page({ stale: true })],
  });

  assert.match(note, /<!-- This page has been written on since it was last recognized\. -->/);
  // The writing itself must still read as the writing.
  assert.match(note, /milk, eggs/);
});

test("rendering is deterministic, so a replay rewrites the same bytes", () => {
  const input = { notebookId: "book-1", title: "Notes", pages: [page(), page({ number: 2 })] };

  assert.equal(renderNote(input), renderNote(input));
});

test("a title with YAML punctuation does not break the frontmatter", () => {
  assert.equal(yamlString('Q3: "plans"'), '"Q3: \\"plans\\""');
  assert.equal(yamlString("- a list?"), '"- a list?"');

  const note = renderNote({ notebookId: "b", title: 'Q3: "plans"', pages: [page()] });
  const frontmatter = note.slice(0, note.indexOf("\n---", 4));
  assert.equal(frontmatter.split("\n").length, 4);
});

test("a filename keeps its meaning but loses what a vault cannot store", () => {
  assert.equal(sanitizeFilename("Q3: plans"), "Q3 plans");
  assert.equal(sanitizeFilename("a/b\\c"), "a b c");
  // # ^ [ ] carry meaning inside links; a note containing them would be unlinkable.
  assert.equal(sanitizeFilename("costs [2026] #draft"), "costs 2026 draft");
  assert.equal(sanitizeFilename("....."), "Untitled");
  assert.equal(sanitizeFilename("   "), "Untitled");
  assert.equal(sanitizeFilename(".hidden"), "hidden");
});

test("two notebooks with one name get separate notes", () => {
  const first = notePath("Handwritten", [], "Journal", "aaaaaaaa-1111", true);
  const second = notePath("Handwritten", [], "Journal", "bbbbbbbb-2222", true);

  assert.notEqual(first, second);
  assert.equal(first, "Handwritten/Journal ~aaaaaaaa.md");
});

test("a unique name is left alone", () => {
  assert.equal(notePath("Handwritten", [], "Journal", "id", false), "Handwritten/Journal.md");
});

test("folders on the tablet become folders in the vault", () => {
  assert.equal(
    notePath("Handwritten", ["Work", "2026"], "Standups", "id", false),
    "Handwritten/Work/2026/Standups.md",
  );
});

test("a page embeds its ink under the text when there is a render of it", () => {
  const note = renderNote({
    notebookId: "n1",
    title: "Groceries",
    pages: [page({ inkPath: "Handwritten/_ink/page-1-a1b2c3d4.png" })],
  });
  // Under the text, not above it: the note reads top to bottom as writing, with the ink there
  // to check a line against when it looks wrong.
  assert.match(note, /milk, eggs\n\n!\[\[Handwritten\/_ink\/page-1-a1b2c3d4\.png\]\]/);
});

test("a page with no render of its ink embeds nothing", () => {
  const note = renderNote({ notebookId: "n1", title: "Groceries", pages: [page()] });
  assert.doesNotMatch(note, /!\[\[/);
});

test("an unrecognized page still shows its ink", () => {
  // The ink is the only thing worth having on a page nothing has read yet, so it must not be
  // conditional on there being text.
  const note = renderNote({
    notebookId: "n1",
    title: "Groceries",
    pages: [page({ text: null, inkPath: "Handwritten/_ink/page-1-a1b2c3d4.png" })],
  });
  assert.match(note, /\*Not recognized yet\.\*\n\n!\[\[Handwritten\/_ink\/page-1-a1b2c3d4\.png\]\]/);
});

test("a page heading is labelled from the first line it was read as", () => {
  // Without this an outline of a seven-page notebook is "Page 1" through "Page 7", which is a
  // list of numbers the reader already had.
  const note = renderNote({
    notebookId: "n1",
    title: "Meeting",
    pages: [page({ text: "opik vs longsmith\n& might use it,\n\nRCB ← database" })],
  });
  assert.match(note, /## Page 1 — opik vs longsmith\n/);
  // And the line stays in the body: a note that is not everything the page said, to save one
  // repeated line, is the wrong trade.
  assert.match(note, /\n\nopik vs longsmith\n/);
});

test("a label drops list markers and is cut to a length that is still a label", () => {
  assert.equal(pageLabel(page({ text: "1. Deterministic investigation" })), "Deterministic investigation");
  assert.equal(pageLabel(page({ text: "- milk, eggs" })), "milk, eggs");
  assert.equal(pageLabel(page({ text: "### a heading" })), "a heading");
  assert.equal(pageLabel(page({ text: "x".repeat(200) })), "x".repeat(60) + "…");
});

test("a label never carries a wikilink into the outline", () => {
  // Headings render links, so a transcription containing brackets would put one in the outline
  // pointing wherever the handwriting happened to land.
  assert.equal(pageLabel(page({ text: "[[Some Note]] and more" })), "Some Note and more");
});

test("a page with nothing read yet has no label", () => {
  assert.equal(pageLabel(page({ text: null })), null);
  assert.equal(pageLabel(page({ text: "   " })), null);
});

test("side by side puts the ink before the text and sets the cssclass", () => {
  // The float in the snippet only has text to sit beside if that text follows it.
  const note = renderNote({
    notebookId: "n1",
    title: "Meeting",
    sideBySide: true,
    pages: [page({ text: "milk, eggs", inkPath: "Handwritten/_ink/p-1.png" })],
  });
  assert.match(note, /cssclasses:\n {2}- notable-side-by-side/);
  assert.match(note, /!\[\[Handwritten\/_ink\/p-1\.png\]\]\n\nmilk, eggs/);
});

test("stacked keeps the ink after the text and adds no cssclass", () => {
  const note = renderNote({
    notebookId: "n1",
    title: "Meeting",
    pages: [page({ text: "milk, eggs", inkPath: "Handwritten/_ink/p-1.png" })],
  });
  assert.doesNotMatch(note, /cssclasses/);
  assert.match(note, /milk, eggs\n\n!\[\[Handwritten\/_ink\/p-1\.png\]\]/);
});
