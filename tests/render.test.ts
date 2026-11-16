import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MANAGED_BY, notePath, pageHeadingTitle, renderNote, sanitizeFilename, yamlString, transcriptMarkdown } from "../src/render.ts";
import { Library } from "../src/projection.ts";
import type { PageEntry } from "../src/model.ts";

const page = (overrides: Partial<PageEntry> = {}): PageEntry => ({
  pageId: "page-1",
  number: 1,
  title: null,
  text: "milk, eggs",
  stale: false,
  ...overrides,
});

test("typed source, handwriting and previous versions remain distinct and keep the ink embed", () => {
  const note = renderNote({ notebookId: "b", title: "Mixed", pages: [page({
    flowText: "# Typed heading\n\nA typed follow-up.", text: "Original handwritten thought.",
    inkPath: "ink.png", previousText: ["An older typed thought."],
  })] });
  assert.match(note, /## Page 1 — Typed heading/);
  assert.match(note, /# Typed heading\n\nA typed follow-up\./);
  assert.match(note, /### Handwriting\n\nOriginal handwritten thought\./);
  assert.match(note, /<summary>Previous text versions<\/summary>/);
  assert.match(note, /An older typed thought\./);
  assert.match(note, /!\[\[ink.png\]\]/);
  const typed = renderNote({ notebookId: "b", title: "Typed", pages: [page({ flowText: "Typed only", text: null })] });
  assert.doesNotMatch(typed, /Not recognized|No handwriting|### Handwriting/);
});

test("canonical Markdown indentation is retained and unclosed recovered fences cannot absorb later versions", () => {
  const source = "    an indented code block  \n\nParagraph with trailing spaces  \n";
  const note = renderNote({ notebookId: "b", title: "Typed", pages: [page({ text: null,
    flowText: source, previousText: ["```\nunclosed code", "a later version"] })] });
  assert.ok(note.includes(source));
  assert.match(note, /````markdown\n```\nunclosed code\n````/);
  assert.match(note, /```markdown\na later version\n```/);
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

  assert.match(note, /## Page 1 — milk, eggs\n/);
  assert.match(note, /## Page 2 — Second thoughts/);
});

test("handwriting remains embedded beside or below recognized text", () => {
  const input = { notebookId: "b", title: "Notes", pages: [page({ inkPath: "Handwritten/_ink/page-1.png" })] };
  const beside = renderNote({ ...input, sideBySide: true });
  assert.match(beside, /cssclasses:\n  - notable-side-by-side/);
  assert.ok(beside.indexOf("![[Handwritten/_ink/page-1.png]]") < beside.lastIndexOf("milk, eggs"));
  const below = renderNote(input);
  assert.ok(below.indexOf("![[Handwritten/_ink/page-1.png]]") > below.lastIndexOf("milk, eggs"));
  assert.doesNotMatch(below, /cssclasses/);
  assert.match(renderNote({ ...input, pages: [page({ text: null, inkPath: "ink.png" })] }), /!\[\[ink.png\]\]/);
});

test("page headings retain installed OCR title suggestions", () => {
  assert.equal(pageHeadingTitle(page({ text: "\n- [ ] # First idea\nMore", title: null })), "First idea");
  assert.equal(pageHeadingTitle(page({ text: "1. Heading" })), "Heading");
  assert.equal(pageHeadingTitle(page({ title: "Explicit\nheading" })), "Explicit heading");
  assert.equal(pageHeadingTitle(page({ text: "😀".repeat(65) })), "😀".repeat(60) + "…");
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

test("stale text stays available with a visible updating indicator", () => {
  const note = renderNote({
    notebookId: "book-1",
    title: "Notes",
    pages: [page({ stale: true })],
  });

  assert.match(note, /<!-- This page has been written on since it was last recognized\. -->/);
  assert.match(note, /\*Updating handwriting transcription…\*/);
  // The writing itself must still read as the writing.
  assert.match(note, /milk, eggs/);
});

test("updating handwriting never replaces typed text or describes a stale blank as current", () => {
  const mixed = renderNote({ notebookId: "b", title: "N", pages: [
    page({ stale: true, flowText: "My exact typed source", text: "old handwriting" }),
  ] });
  assert.match(mixed, /My exact typed source/);
  assert.match(mixed, /### Handwriting\n\n[\s\S]*Updating handwriting transcription…[\s\S]*old handwriting/);

  const blank = renderNote({ notebookId: "b", title: "N", pages: [page({ stale: true, text: "" })] });
  assert.match(blank, /Updating handwriting transcription/);
  assert.doesNotMatch(blank, /No handwriting found/);
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

const structured = "# Project\n\n## Tasks\n- [x] Done\n- [ ] Next\n  - detail\n1. First\n2. Second\n\n| Item | Qty | Note |\n| :--- | ---: | :---: |\n| Milk | 2 | |\n| A \\| B | 1 | yes |";
const renderedStructured = structured.replace("| Milk | 2 | |", "| Milk | 2 |  |");

test("marked transcripts retain headings, list order/indent, task state and table cells/alignment", () => {
  assert.equal(transcriptMarkdown(structured, "markdown"), renderedStructured);
  assert.equal(transcriptMarkdown("paragraph\nA | B\n--- | ---\n| | value |", "markdown"),
    "paragraph\n\n| A | B |\n| --- | --- |\n|  | value |");
  assert.equal(transcriptMarkdown("| | |\n| --- | --- |\n| Milk | 2 |", "markdown"),
    "|  |  |\n| --- | --- |\n| Milk | 2 |");
  assert.equal(transcriptMarkdown("- [ ]\n- [X]", "markdown"), "- [ ] \n- [x]");
  assert.equal(transcriptMarkdown("| A | B |\n| --- | ---: |\n| one | two | three |\n| last |", "markdown"),
    "| A | B |  |\n| --- | ---: | --- |\n| one | two | three |\n| last |  |  |");
});

test("missing/unknown format remains literal, including apparent tasks and headings", () => {
  for (const format of [undefined, "plain", "html", "Markdown"]) {
    const rendered = transcriptMarkdown(structured, format);
    assert.match(rendered, /^&#35; Project/);
    assert.match(rendered, /\\- &#91;x&#93; Done/);
    assert.doesNotMatch(rendered, /^#{1,6} |^\s*- \[[ x]\]|^\|/m);
    assert.match(rendered, /1\\\. First/);
    assert.equal(transcriptMarkdown("Title\n===\n   ---", format), "Title  \n\\===  \n   \\---");
  }
});

test("derived content cannot embed vault files, load remote images, execute queries, hide comments or create tags", () => {
  const source = "# <img src=https://example.invalid/x>\n![[Private]]\n![remote](https://example.invalid/x)\n```dataviewjs\nalert(1)\n```\n#newtag %%hidden%% ^block $math$";
  const rendered = transcriptMarkdown(source, "markdown");
  assert.match(rendered, /^# &#60;img/);
  assert.doesNotMatch(rendered, /!\[|<img|```|#newtag|%%|\^block|\$math\$/);
  const note = renderNote({ notebookId: "b", title: "N", pages: [{ pageId: "p", number: 1,
    title: null, text: source, format: "markdown", stale: false, inkPath: "ink.png",
    flowText: "# My exact typed source\n\n- [x] Original typed task\n![[My own embed]]" }] });
  assert.match(note, /# My exact typed source\n\n- \[x\] Original typed task\n!\[\[My own embed\]\]/);
  assert.match(note, /!\[\[ink.png\]\]/);
  assert.doesNotMatch(note, /<img|!\[\[Private\]\]|```dataviewjs/);
});

test("format survives cache restart, metadata changes, staleness and erasing without changing canonical blocks/topics", () => {
  const lib = new Library();
  lib.applyNotebook({ _id: "notebook:b", title: "Notes", pageIds: ["p"] });
  const organization = { _id: "journal:b", type: "journal", schema: 1, notebookId: "b", date: "2026-11-16", createdAt: 1,
    topics: { keep: { name: "Keep", present: true, counter: 1, writer: "boox" },
      removed: { name: "Removed", present: false, counter: 2, writer: "ipad" } } };
  lib.applyOrganizationSnapshot([organization]);
  const source = { _id: "page:p", _rev: "1-source", notebookId: "b", title: "Plan", blocks: [
    { id: "typed", kind: "md", text: "Exact typed paragraph.", orderKey: "1" },
  ] };
  lib.applyPageContents([source]);
  lib.applyText({ _id: "pagetext:p", notebookId: "b", text: structured, format: "markdown", sourceRev: "1-source" });
  const planned = lib.plan("Notes");
  assert.ok(planned[0].contents.includes(renderedStructured));
  const restored = new Library();
  assert.equal(restored.restore(lib.snapshot()), true);
  restored.applyNotebook({ _id: "notebook:b", title: "Notes", pageIds: ["p"] });
  assert.deepEqual(restored.plan("Notes"), planned);
  restored.applyPageContents([{ ...source, _rev: "2-edit" }]);
  assert.match(restored.plan("Notes")[0].contents, /Updating handwriting transcription/);
  restored.applyText({ _id: "pagetext:p", notebookId: "b", text: "", format: "markdown", sourceRev: "2-edit" });
  const blank = restored.plan("Notes")[0].contents;
  assert.match(blank, /Exact typed paragraph\./);
  assert.doesNotMatch(blank, /# Project|Tasks|Milk|Updating handwriting/);
  assert.match(blank, /journal-date: "2026-11-16"/);
  assert.match(blank, /topics: \["Keep"\]/);
  assert.deepEqual(restored.snapshot().organization, [organization]);
  assert.equal(source.blocks[0].text, "Exact typed paragraph.");
});
