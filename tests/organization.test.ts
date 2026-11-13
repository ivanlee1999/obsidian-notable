import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mergeOrganization, organizationSnapshot, topicKey, type OrganizationDoc } from "../src/organization.ts";
import { Library } from "../src/projection.ts";
import { fileId, managedIdentity, renderNote, reservePath } from "../src/render.ts";

const vectors = JSON.parse(readFileSync(new URL("./journal-sync-vectors.json", import.meta.url), "utf8"));
const doc = (changes: Partial<OrganizationDoc> = {}): OrganizationDoc => ({
  _id: "journal:note", type: "journal", schema: 1, notebookId: "note", date: "2026-11-11",
  createdAt: 1, topics: { product: { name: "Product", present: true, counter: 1, writer: "boox" } }, ...changes,
});
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

for (const vector of vectors.normalization) test(`shared topic key ${JSON.stringify(vector.input)}`, () => {
  assert.equal(topicKey(vector.input), vector.key);
});
for (const vector of vectors.merges) test(`shared merge ${vector.name}`, () => {
  const [a, b, expected] = organizationSnapshot([vector.left, { ...vector.right, notebookId: "unused", _id: "journal:unused" },
    { ...vector.expected, notebookId: "expected", _id: "journal:expected" }]);
  b.notebookId = a.notebookId; b._id = a._id;
  expected.notebookId = a.notebookId; expected._id = a._id;
  assert.deepEqual(plain(mergeOrganization(a, b)), plain(expected));
  assert.deepEqual(plain(mergeOrganization(b, a)), plain(expected));
  assert.deepEqual(plain(mergeOrganization(expected, a)), plain(expected));
});

test("a stored leading hash in a normalized label is not stripped twice", () => {
  assert.equal(organizationSnapshot([doc({ topics: { "#idea": { name: "#Idea", present: true, counter: 1, writer: "a" } } })]).length, 1);
});

test("invalid dates, ids, revisions, topic keys and tombstones fail closed", () => {
  const invalid: unknown[] = [
    doc({ date: "2026-02-30" }), doc({ date: "2026-2-2" }), doc({ createdAt: Number.MAX_SAFE_INTEGER + 1 }),
    { ...doc(), _id: "journal:other" }, { ...doc(), _deleted: true }, { ...doc(), schema: 2 },
    doc({ topics: { wrong: { name: "Product", present: true, counter: 1, writer: "a" } } }),
    doc({ topics: { product: { name: "Product", present: true, counter: -1, writer: "a" } } }),
    { ...doc(), notebookId: "é", _id: "journal:é" },
    doc({ topics: { product: { name: "Product", present: true, counter: 1, writer: "é" } } }),
    doc({ topics: { "e\u0301": { name: "e\u0301", present: true, counter: 1, writer: "a" } } }),
  ];
  for (const value of invalid) assert.throws(() => organizationSnapshot([value]));
});

test("cached metadata survives omission and merges incoming removals", () => {
  const lib = new Library();
  lib.applyNotebook({ _id: "notebook:note", title: "Idea", pageIds: ["page"] });
  lib.applyOrganizationSnapshot([doc()]);
  const original = lib.plan("Ink");
  lib.applyOrganizationSnapshot([]);
  assert.deepEqual(lib.plan("Ink"), original);
  assert.throws(() => lib.applyOrganizationSnapshot([doc({ date: "invalid" })]));
  assert.deepEqual(lib.plan("Ink"), original);
  lib.applyOrganizationSnapshot([doc({ topics: { product: { name: "Product", present: false, counter: 2, writer: "ipad" } } })]);
  const removed = lib.plan("Ink");
  assert.equal(removed.filter(n => n.kind === "topic").length, 0);
  assert.match(removed[0].contents, /topics: \[\]/);
  assert.match(removed[0].contents, /journal-date: "2026-11-11"/);
});

test("notes without OCR appear under separate captured days and exact topic names", () => {
  const lib = new Library();
  lib.applyOrganizationSnapshot([doc(), doc({ _id: "journal:second", notebookId: "second", date: "2026-11-12", createdAt: 2 })]);
  lib.replaceLibrary([{ _id: "notebook:note", title: "First", pageIds: ["p1"] },
    { _id: "notebook:second", title: "Second", pageIds: ["p2"] }], []);
  const plan = lib.plan("Ink");
  assert.equal(plan.filter(n => !n.kind).length, 2);
  assert.equal(plan.filter(n => n.kind === "day").length, 2);
  assert.equal(plan.filter(n => n.kind === "topic").length, 1);
  assert.match(plan[0].contents, /Not recognized yet/);
  assert.match(plan.find(n => n.kind === "day")!.contents, /\.\.\/Entries\//);
  const restored = new Library();
  restored.restore(lib.snapshot());
  restored.applyNotebook({ _id: "notebook:note", title: "Renamed", pageIds: ["p1"] });
  assert.equal(restored.plan("Ink")[0].path, plan[0].path);
});

test("tagging an ordinary notebook does not manufacture a journal day", () => {
  const lib = new Library();
  lib.applyNotebook({ _id: "notebook:note", title: "Legacy", pageIds: [] });
  lib.applyOrganizationSnapshot([doc({ date: null })]);
  assert.equal(lib.plan("Ink").filter(n => n.kind === "day").length, 0);
  assert.equal(lib.plan("Ink").filter(n => n.kind === "topic").length, 1);
});

test("managed identity protects unmarked, differently owned, and differently scoped files", () => {
  const a = renderNote({ notebookId: "a", title: "A", pages: [] });
  const identity = JSON.stringify(["notebook", "a"]);
  const occupied = new Map<string, string | null>([["Ink/A.md", null]]);
  const path = reservePath("Ink/A.md", identity, occupied);
  assert.notEqual(path, "Ink/A.md");
  assert.equal(reservePath("Ink/A.md", identity, occupied), path);
  assert.notEqual(reservePath("Ink/A.md", JSON.stringify(["notebook", "b"]), occupied), path);
  assert.equal(managedIdentity(a), identity);
  assert.equal(managedIdentity(a.replace(/\n/g, "\r\n")), identity);
  assert.equal(managedIdentity(a.replace("---\n", '---\nnotable-source: "old"\n'), "new"), null);
  assert.equal(managedIdentity("# User's own writing"), null);
  assert.equal(fileId("a"), fileId("a"));
});

test("day indexes order captures by time and topic indexes show newest first", () => {
  const lib = new Library();
  lib.applyOrganizationSnapshot([doc({ createdAt: 2 }),
    doc({ _id: "journal:second", notebookId: "second", createdAt: 1 })]);
  lib.replaceLibrary([{ _id: "notebook:note", title: "Later" }, { _id: "notebook:second", title: "Earlier" }], []);
  const day = lib.plan("Ink").find(note => note.kind === "day")!.contents;
  const topic = lib.plan("Ink").find(note => note.kind === "topic")!.contents;
  assert.ok(day.indexOf("Earlier") < day.indexOf("Later"));
  assert.ok(topic.indexOf("Later") < topic.indexOf("Earlier"));
});

test("multiline titles and topic punctuation remain valid single-line JSON YAML values", () => {
  const note = renderNote({ notebookId: "note", title: 'Heading\nmanaged-by: "fake"', pages: [],
    journalDate: "2026-11-11", topics: ['Product: [draft]', 'A "quote"\nnew line', "#Idea"] });
  assert.match(note, /title: "Heading\\nmanaged-by:/);
  const topics = note.split("\n").find(line => line.startsWith("topics: "))!.slice(8);
  assert.deepEqual(JSON.parse(topics), ['Product: [draft]', 'A "quote"\nnew line', "#Idea"]);
});
