import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MANAGED_BY, notePath, renderNote, sanitizeFilename, yamlString } from "../src/render.ts";
import type { PageEntry } from "../src/model.ts";

const page = (overrides: Partial<PageEntry> = {}): PageEntry => ({
  pageId: "page-1",
  number: 1,
  title: null,
  text: "milk, eggs",
  stale: false,
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

  assert.match(note, /## Page 1\n/);
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
