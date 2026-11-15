import { strict as assert } from "node:assert";
import { test } from "node:test";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { buildSync } from "esbuild";
import { fileId, renderNote } from "../src/render.ts";

// Exercise the real plugin and Couch reader against an in-memory Obsidian vault and HTTP host.
const bundle = buildSync({ entryPoints: [new URL("../src/main.ts", import.meta.url).pathname],
  bundle: true, format: "cjs", platform: "node", external: ["obsidian"], write: false }).outputFiles![0].text;

class File {
  path: string;
  contents: string;
  constructor(path: string, contents: string) { this.path = path; this.contents = contents; }
}
class Folder { path: string; constructor(path: string) { this.path = path; } }
const PNG_HEADER = [137, 80, 78, 71, 13, 10, 26, 10];

function fixture(http?: (options: { url: string; headers: Record<string, string>; method?: string; body?: string }) => Promise<unknown>) {
  const files = new Map<string, File | Folder>();
  const trashed: File[] = [];
  let saved: any = null;
  const server: any = {
    org: [{ _id: "journal:note", type: "journal", schema: 1, notebookId: "note", date: "2026-11-11", createdAt: 1,
      topics: { product: { name: "Product", present: true, counter: 1, writer: "boox" } } }],
    books: [{ _id: "notebook:note", title: "Idea", pageIds: ["page"] }], folders: [], images: [], pages: [], status: 200,
  };
  const notices: string[] = [];
  const api: any = {
    Plugin: class {
      async loadData() { return saved; }
      async saveData(data: any) { saved = JSON.parse(JSON.stringify(data)); }
    },
    PluginSettingTab: class {}, Setting: class {}, TFile: File, TFolder: Folder,
    Notice: class { constructor(message: string) { notices.push(message); } },
    normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, ""),
    requestUrl: async (options: { url: string; headers: Record<string, string>; method?: string; body?: string }) => {
      if (http) return http(options);
      const { url } = options;
      const request = new URL(url);
      let json: unknown;
      let status = 200;
      if (request.pathname.includes("_organization")) {
        status = server.status;
        json = server.rawOrganization ?? { rows: server.org.map((doc: unknown) => ({ doc })) };
      } else if (request.pathname.includes("notes_text")) {
        status = server.textStatus ?? 200;
        json = { results: [], last_seq: "0" };
      } else if (request.pathname.includes("notes_images")) {
        if (request.pathname.endsWith("/page.png")) {
          await server.beforeImage?.();
          return { status: server.imageStatus ?? 200,
            arrayBuffer: new Uint8Array(server.imageBytes ?? PNG_HEADER).buffer };
        }
        status = server.imagesStatus ?? 200;
        json = { rows: server.images.map((doc: unknown) => ({ doc })) };
      } else if (request.pathname.endsWith("/_find")) {
        status = server.pageStatus ?? 200;
        const query = JSON.parse(options.body!);
        assert.equal(options.method, "POST");
        assert.deepEqual(query.fields, ["_id", "_rev", "notebookId", "title", "updatedAt", "blocks", "deletedBlocks"]);
        json = server.rawPages ?? { docs: server.pages.filter((page: any) => query.selector._id.$in.includes(page._id)) };
      } else if (request.searchParams.get("startkey") === '"notebook:"') {
        json = { rows: server.books.map((doc: unknown) => ({ doc })) };
      } else json = { rows: server.folders.map((doc: unknown) => ({ doc })) };
      return { status, json: JSON.parse(JSON.stringify(json)) };
    },
  };
  const module = { exports: {} as any };
  vm.runInNewContext(bundle, { module, exports: module.exports, require: () => api, URL, TextEncoder,
    btoa: (value: string) => Buffer.from(value).toString("base64"),
    crypto: webcrypto, console: { warn() {}, error() {} }, setTimeout, clearTimeout });
  const Plugin = module.exports.default;
  function plugin() {
    const result = new Plugin();
    result.app = { vault: {
      getMarkdownFiles: () => [...files.values()].filter((file): file is File => file instanceof File && file.path.endsWith(".md")),
      getAbstractFileByPath: (path: string) => files.get(path) ?? null,
      read: async (file: File) => file.contents,
      modify: async (file: File, contents: string) => { file.contents = contents; },
      process: async (file: File, change: (contents: string) => string) => {
        await server.beforeProcess?.(file);
        file.contents = change(file.contents);
        return file.contents;
      },
      create: async (path: string, contents: string) => {
        await server.beforeCreate?.(path);
        if (files.has(path)) throw new Error("File already exists");
        const file = new File(path, contents); files.set(path, file); return file;
      },
      createBinary: async (path: string, bytes: ArrayBuffer) => {
        if (files.has(path)) throw new Error("File already exists");
        const file = new File(path, Buffer.from(bytes).toString("hex")); files.set(path, file); return file;
      },
      createFolder: async (path: string) => {
        let parent = "";
        for (const segment of path.split("/")) {
          parent = parent ? `${parent}/${segment}` : segment;
          if (files.get(parent) instanceof File) throw new Error("A file blocks the folder");
          if (!files.has(parent)) files.set(parent, new Folder(parent));
        }
      },
      trash: async (file: File) => { trashed.push(file); files.delete(file.path); },
    }, fileManager: {
      renameFile: async (file: File, path: string) => {
        assert.equal(files.has(path), false);
        files.delete(file.path); file.path = path; files.set(path, file);
      },
    } };
    result.settings.url = "https://first.test";
    return result;
  }
  return { files, trashed, server, notices, plugin, saved: () => saved,
    snapshot: () => [...files.values()].filter((file): file is File => file instanceof File)
      .map(file => [file.path, file.contents]).sort() };
}

test("metadata-only notes generate entry, day and topic files and survive restart", async () => {
  const f = fixture(), p = f.plugin();
  await p.sync(true);
  assert.equal(f.snapshot().length, 3);
  const before = f.snapshot();
  const next = f.plugin();
  await next.loadSettings();
  await next.sync(true);
  assert.deepEqual(f.snapshot(), before);
  assert.match(f.saved().projectionSource, /first\.test/);
});

test("canonical typed blocks sync without OCR and a failed page read cannot erase vault content", async () => {
  const f = fixture(), p = f.plugin();
  f.server.textStatus = 404;
  f.server.pages = [{ _id: "page:page", notebookId: "note", blocks: [
    { id: "body", kind: "md", orderKey: "1", text: "# Typed capture\n\nThe original source." },
    { id: "v", kind: "text-version", text: "Earlier source" },
  ] }];
  await p.sync(true);
  const body = f.snapshot().find(([path]) => path.includes("Entries"))![1];
  assert.match(body, /# Typed capture\n\nThe original source\./);
  assert.match(body, /Previous text versions/);
  assert.match(body, /journal-date: "2026-11-11"/);
  assert.match(body, /topics: \["Product"\]/);
  const before = f.snapshot();
  f.server.pageStatus = 503;
  await p.sync(true);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.trashed.length, 0);
  assert.match(f.notices.at(-1)!, /Reading typed notes failed/);
  f.server.pageStatus = 200;
  f.server.rawPages = { docs: [{ _id: "page:unexpected", notebookId: "note", blocks: [] }] };
  await p.sync(true);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.trashed.length, 0);
});

test("hand edits in managed notes are recovered exactly and never become sync targets", async () => {
  const f = fixture(), p = f.plugin();
  f.server.pages = [{ _id: "page:page", notebookId: "note", blocks: [
    { id: "body", kind: "md", text: "First synced source" },
  ] }];
  await p.sync(true);
  const entry = [...f.files.values()].find(file => file instanceof File && file.path.includes("/Entries/")) as File;
  entry.contents += "\n\nMy hand-edited thoughts #personal\n";
  const manual = entry.contents;
  f.server.pages[0].blocks[0].text = "Second synced source";
  await p.sync(true);
  assert.match(entry.contents, /Second synced source/);
  const recovered = f.snapshot().filter(([path]) => path.includes("/_recovered/"));
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0][1], manual);
  assert.ok(f.notices.some(message => /saved 1 edited note.*_recovered/.test(message)));

  const restarted = f.plugin();
  await restarted.loadSettings();
  f.server.pages[0].blocks[0].text = "Third synced source";
  await restarted.sync(true);
  assert.match(entry.contents, /Third synced source/);
  assert.deepEqual(f.snapshot().filter(([path]) => path.includes("/_recovered/")), recovered);
  assert.equal(f.trashed.some(file => file.path.includes("/_recovered/")), false);
});

test("pre-upgrade managed files are preserved before their first replacement", async () => {
  const f = fixture(), p = f.plugin();
  await p.sync(true);
  delete f.saved().writtenHashes;
  const before = f.snapshot();
  const restarted = f.plugin();
  await restarted.loadSettings();
  f.server.books[0].title = "Renamed after upgrade";
  await restarted.sync(true);
  const backups = f.snapshot().filter(([path]) => path.includes("/_recovered/"));
  assert.ok(backups.length > 0);
  for (const [, contents] of backups) assert.ok(before.some(([, original]) => original === contents));
});

test("duplicate legacy exports use the intended destination and preserve the extra copy", async () => {
  const f = fixture(), p = f.plugin();
  await p.sync(true);
  const entry = [...f.files.values()].find(file => file instanceof File && file.path.includes("/Entries/")) as File;
  assert.ok(entry);
  const preserved = entry.contents.replace(/^notable-source:.*\n/m, "") + "\nMy old export edits\n";
  // Reproduce an old duplicate arriving before the current destination in the vault listing.
  const duplicate = new File("Handwritten/Another old export.md", preserved);
  const files = [...f.files.entries()];
  f.files.clear();
  f.files.set(duplicate.path, duplicate);
  for (const [path, file] of files) f.files.set(path, file);
  await p.sync(true);
  assert.doesNotMatch(f.notices.at(-1)!, /changed during sync/);
  assert.equal(f.files.get(entry.path), entry);
  assert.ok(f.snapshot().some(([path, contents]) => path.includes("/_recovered/") && contents === preserved));
  assert.ok(f.trashed.includes(duplicate));
});

test("a hand edit during the final atomic write is preserved and retried", async () => {
  const f = fixture(), p = f.plugin();
  await p.sync(true);
  f.server.books[0].title = "Server rename";
  f.server.beforeProcess = async (file: File) => { file.contents += "\nConcurrent hand edit\n"; };
  await p.sync(true);
  assert.match(f.notices.at(-1)!, /changed during sync/);
  const edited = f.snapshot().find(([, contents]) => contents.includes("Concurrent hand edit"));
  assert.ok(edited);
  delete f.server.beforeProcess;
  await p.sync(true);
  assert.ok(f.snapshot().some(([path, contents]) => path.includes("/_recovered/") && contents === edited[1]));
});

test("a hand edit during recovery prevents cleanup from trashing the changed note", async () => {
  const f = fixture(), p = f.plugin();
  await p.sync(true);
  const topic = [...f.files.values()].find(file => file instanceof File && file.path.includes("/Topics/")) as File;
  assert.ok(topic);
  topic.contents += "\nMy topic notes\n";
  f.server.org[0].topics.product = { name: "Product", present: false, counter: 2, writer: "ipad" };
  f.server.beforeCreate = async (path: string) => {
    if (path.includes("/_recovered/")) topic.contents += "\nConcurrent topic edit\n";
  };
  await p.sync(true);
  assert.match(f.notices.at(-1)!, /changed during sync/);
  assert.equal(f.files.get(topic.path), topic);
  const edited = topic.contents;
  delete f.server.beforeCreate;
  await p.sync(true);
  assert.ok(f.snapshot().some(([path, contents]) => path.includes("/_recovered/") && contents === edited));
  assert.ok(f.trashed.some(file => file.contents === edited));
});

const pageImage = { _id: "pageimage:page", pageId: "page", _attachments: { "page.png": { digest: "md5-abc12345", length: PNG_HEADER.length } } };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

for (const stop of ["unload", "source change"]) {
  test(`a deferred image download cannot write after ${stop}`, async () => {
    const f = fixture(), p = f.plugin();
    await p.sync(true);
    const before = f.snapshot(), saved = JSON.stringify(f.saved()), notices = f.notices.length;
    const started = deferred(), release = deferred();
    f.server.images = [pageImage];
    f.server.beforeImage = async () => { started.resolve(); await release.promise; };
    const pending = p.sync(true);
    await started.promise;
    if (stop === "unload") p.onunload(); else p.settings.url = "https://second.test";
    release.resolve();
    await pending;
    assert.deepEqual(f.snapshot(), before);
    assert.equal(JSON.stringify(f.saved()), saved);
    assert.equal(f.notices.length, notices);
    assert.equal(f.trashed.length, 0);
  });
}

test("unloading during a vault read prevents obsolete modifications, trash and checkpoint saves", async () => {
  const f = fixture(), p = f.plugin();
  await p.sync(true);
  const before = f.snapshot(), saved = JSON.stringify(f.saved()), notices = f.notices.length;
  f.server.org[0].topics.product = { name: "Product", present: false, counter: 2, writer: "boox" };
  const started = deferred(), release = deferred();
  const read = p.app.vault.read;
  p.app.vault.read = async (file: File) => { started.resolve(); await release.promise; return read(file); };
  const pending = p.sync(true);
  await started.promise;
  p.onunload();
  release.resolve();
  await pending;
  await p.saveSettings();
  assert.deepEqual(f.snapshot(), before);
  assert.equal(JSON.stringify(f.saved()), saved);
  assert.equal(f.notices.length, notices);
  assert.equal(f.trashed.length, 0);
});

test("upgrading the installed plugin preserves settings and cached ink while migrating its managed note", async () => {
  const f = fixture(), original = f.plugin();
  await original.saveData({ ...original.settings, sideBySide: true, checkpoint: "old-checkpoint" });
  const prior = new File("Handwritten/Idea.md", renderNote({ notebookId: "note", title: "Idea", pages: [] }));
  const image = new File("Handwritten/_ink/page-abc12345.png", "existing handwriting bytes");
  f.files.set(prior.path, prior);
  f.files.set(image.path, image);
  f.server.images = [pageImage];
  f.server.imageStatus = 500;
  const upgraded = f.plugin();
  await upgraded.loadSettings();
  assert.equal(upgraded.settings.checkpoint, "0");
  assert.equal(upgraded.settings.sideBySide, true);
  await upgraded.sync(true);
  assert.equal(f.files.get(image.path), image);
  assert.equal(f.files.get("Handwritten/Idea.md"), undefined);
  assert.equal(f.files.get(`Handwritten/Entries/${fileId("note")}.md`), prior);
  assert.match(prior.contents, /notable-side-by-side/);
  assert.match(prior.contents, /!\[\[Handwritten\/_ink\/page-abc12345.png\]\]/);
  assert.equal(f.trashed.length, 0);
});

test("installed image settings, embeds and journal metadata survive sync and restart", async () => {
  const f = fixture(), p = f.plugin();
  p.settings.sideBySide = true;
  f.server.images = [pageImage];
  await p.sync(true);
  const note = f.snapshot().find(([path]) => path.endsWith(".md") && path.includes("Entries"))![1];
  assert.match(note, /!\[\[Handwritten\/_ink\/page-abc12345.png\]\]/);
  assert.match(note, /cssclasses:\n  - notable-side-by-side/);
  assert.match(note, /journal-date: "2026-11-11"/);
  assert.match(note, /topics: \["Product"\]/);
  assert.equal(f.saved().imagesDatabase, "notes_images");
  const before = f.snapshot();
  const next = f.plugin();
  await next.loadSettings();
  assert.equal(next.settings.sideBySide, true);
  // An existing cached image does not need downloading again.
  f.server.imageStatus = 500;
  await next.sync(true);
  assert.deepEqual(f.snapshot(), before);
  // Manifest omission does not invalidate image links from the persisted projection.
  f.server.images = [];
  await next.sync(true);
  assert.deepEqual(f.snapshot(), before);
});

test("image manifest, download and malformed metadata failures preserve prior output", async () => {
  const f = fixture(), p = f.plugin();
  f.server.images = [pageImage];
  await p.sync(true);
  const before = f.snapshot();
  f.server.org[0].topics.product = { name: "Product", present: false, counter: 2, writer: "boox" };
  f.server.imagesStatus = 503;
  await p.sync(true);
  assert.deepEqual(f.snapshot(), before);
  f.server.imagesStatus = 200;
  f.server.images = [{ ...pageImage, _attachments: { "page.png": { digest: "md5-new", length: PNG_HEADER.length } } }];
  f.server.imageStatus = 500;
  await p.sync(true);
  assert.deepEqual(f.snapshot(), before);
  f.server.imageStatus = 200;
  f.server.imageBytes = [1];
  await p.sync(true);
  assert.deepEqual(f.snapshot(), before);
  f.server.imageBytes = PNG_HEADER.map(() => 0);
  await p.sync(true);
  assert.deepEqual(f.snapshot(), before);
  assert.match(f.notices.at(-1)!, /Invalid handwriting PNG/);
  f.server.images = [{ ...pageImage, pageId: "../manual" }];
  await p.sync(true);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.trashed.length, 0);
});

test("image-only notebooks remain visible and historical PNGs are not pruned", async () => {
  const f = fixture(), p = f.plugin();
  f.server.org = [];
  f.server.images = [pageImage];
  const manual = new File("Handwritten/_ink/manual.png", "independent image");
  f.files.set(manual.path, manual);
  await p.sync(true);
  assert.match(f.snapshot().find(([path]) => path === "Handwritten/Idea.md")![1], /!\[\[Handwritten\/_ink\/page-abc12345.png\]\]/);
  assert.equal(f.files.get(manual.path), manual);
  assert.equal(f.trashed.length, 0);
});

test("malformed or unavailable organization snapshot never rewrites or trashes prior files", async () => {
  const f = fixture(), p = f.plugin();
  await p.sync(true);
  const before = f.snapshot();
  f.server.status = 404;
  await p.sync(false);
  assert.deepEqual(f.snapshot(), before);
  assert.match(f.notices.at(-1)!, /notes_organization/);
  f.server.status = 200;
  f.server.org = [{ ...f.server.org[0], date: "2026-02-30" }];
  await p.sync(true);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.trashed.length, 0);
  f.server.rawOrganization = { rows: [{}] };
  await p.sync(true);
  assert.deepEqual(f.snapshot(), before);
});

test("metadata received before ink remains cached until its notebook arrives", async () => {
  const f = fixture(), p = f.plugin();
  const books = f.server.books;
  f.server.books = [];
  await p.sync(true);
  assert.equal(f.saved().projection.organization.length, 1);
  assert.equal(f.snapshot().length, 0);
  f.server.books = books;
  await p.sync(true);
  assert.equal(f.snapshot().length, 3);
});

test("missing OCR database does not hide journal entries", async () => {
  const f = fixture(), p = f.plugin();
  f.server.textStatus = 404;
  await p.sync(true);
  assert.equal(f.snapshot().length, 3);
});

test("manual collisions and another managed note are never overwritten", async () => {
  const f = fixture(), p = f.plugin();
  const entry = `Handwritten/Entries/${fileId("note")}.md`;
  const manual = new File(entry, "My independent note");
  const daily = new File("Handwritten/Journal/2026-11-11.md", "My daily writing");
  const other = new File("Handwritten/elsewhere.md", renderNote({ notebookId: "other", title: "Other", pages: [] }));
  f.files.set(entry, manual); f.files.set(daily.path, daily); f.files.set(other.path, other);
  await p.sync(true);
  assert.equal(manual.contents, "My independent note");
  assert.equal(daily.contents, "My daily writing");
  assert.equal(f.files.get(other.path), other);
  assert.equal(f.trashed.length, 0);
  assert.equal(f.snapshot().length, 6);
  const generatedDay = f.snapshot().find(([path]) => path.includes("/Journal/") && path !== daily.path)!;
  assert.match(generatedDay[1], /\.\.\/Entries\/[^>]+%20~/);
});

test("same-prefix notebook IDs and sanitized names cannot collide", async () => {
  const f = fixture(), p = f.plugin();
  f.server.org = [];
  f.server.books = [
    { _id: "notebook:aaaaaaaa-first", title: "A:B", pageIds: [] },
    { _id: "notebook:aaaaaaaa-second", title: "A?B", pageIds: [] },
  ];
  // Organization records make unrecognized notes available without relying on OCR fixtures.
  f.server.org = f.server.books.map((book: any) => ({ _id: `journal:${book._id.slice(9)}`, type: "journal", schema: 1,
    notebookId: book._id.slice(9), date: null, createdAt: 1, topics: {} }));
  await p.sync(true);
  assert.equal(f.snapshot().length, 2);
});

test("tag removal updates properties and indexes while retaining the original note", async () => {
  const f = fixture(), p = f.plugin();
  await p.sync(true);
  f.server.org = [{ ...f.server.org[0], topics: {
    product: { name: "Product", present: false, counter: 2, writer: "ipad" },
  } }];
  await p.sync(true);
  assert.equal(f.snapshot().length, 2);
  assert.match(f.snapshot().find(([path]) => path.includes("/Entries/"))![1], /topics: \[\]/);
  assert.equal(f.trashed.length, 1);
  assert.match(f.trashed[0].path, /\/Topics\//);
});

test("switching servers does not mix cached dates/tags or overwrite the prior library", async () => {
  const f = fixture(), p = f.plugin();
  await p.sync(true);
  const old = f.snapshot();
  p.settings.url = "https://second.test";
  f.server.org = [{ ...f.server.org[0], date: "2026-11-12", topics: {} }];
  await p.sync(true);
  for (const [path, contents] of old) assert.equal((f.files.get(path) as File).contents, contents);
  const fresh = f.snapshot().filter(([path]) => !old.some(([oldPath]) => oldPath === path));
  assert.equal(fresh.length, 2);
  assert.ok(fresh.some(([, contents]) => contents.includes('journal-date: "2026-11-12"')));
  assert.ok(fresh.every(([, contents]) => !contents.includes('"Product"')));
});

test("bare notebook absence preserves its exported note; explicit Trash is recoverable", async () => {
  const f = fixture(), p = f.plugin();
  await p.sync(true);
  const entry = f.snapshot().find(([path]) => path.includes("/Entries/"))!;
  f.server.books = [];
  await p.sync(true);
  assert.equal((f.files.get(entry[0]) as File).contents, entry[1]);
  f.server.books = [{ _id: "notebook:note", title: "Idea", pageIds: ["page"], deletedAt: "2026-11-12T00:00:00Z" }];
  await p.sync(true);
  assert.equal(f.files.has(entry[0]), false);
  f.server.books = [{ _id: "notebook:note", title: "Idea", pageIds: ["page"] }];
  await p.sync(true);
  assert.equal(f.files.has(entry[0]), true);
});

test("real CouchDB metadata pulls, removals and outage preserve the vault", {
  skip: !process.env.NOTABLE_ORG_LIVE_URL,
}, async () => {
  const url = process.env.NOTABLE_ORG_LIVE_URL!.replace(/\/$/, "");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname), "Live test must use isolated local CouchDB");
  const user = process.env.NOTABLE_ORG_LIVE_USER ?? "";
  const password = process.env.NOTABLE_ORG_LIVE_PASSWORD ?? "";
  const headers = { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`,
    "Content-Type": "application/json" };
  const database = `obsidian_journal_test_${Math.random().toString(36).slice(2)}`;
  const databases = [database, `${database}_text`, `${database}_organization`];
  const put = async (path: string, body?: unknown) => {
    const response = await fetch(`${url}/${path}`, { method: "PUT", headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.ok(response.ok, `PUT ${path}: ${response.status}`);
    return response.json() as Promise<{ rev: string }>;
  };
  try {
    for (const name of databases) await put(name);
    await put(`${database}/notebook:note`, { title: "Live journal entry", pageIds: ["page"] });
    const page = { notebookId: "note", updatedAt: "2026-11-11T12:00:00.000Z", blocks: [
      { id: "body", kind: "md", orderKey: "1", text: "Live typed source\n\nSecond paragraph." },
      { id: "history", kind: "text-version", text: "Earlier exact source" },
    ], deletedBlocks: [] };
    const pageRevision = await put(`${database}/page:page`, page);
    const recognition = { pageId: "page", notebookId: "note", text: "First handwriting transcript",
      sourceRev: pageRevision.rev, sourceFingerprint: "sha256:test", pipelineVersion: "scribe-v2:test",
      recognizedClock: page.updatedAt };
    const textRevision = await put(`${database}_text/pagetext:page`, recognition);
    let organization = { type: "journal", schema: 1, notebookId: "note", date: "2026-11-11", createdAt: 1,
      topics: { product: { name: "Product", present: true, counter: 1, writer: "boox" } } };
    const initial = await put(`${database}_organization/journal:note`, organization);
    const f = fixture(async ({ url, headers, method, body }) => {
      const response = await fetch(url, { headers, method, body });
      return { status: response.status, json: await response.json() };
    });
    const p = f.plugin();
    Object.assign(p.settings, { url, username: user, password, notesDatabase: database, textDatabase: `${database}_text`, imagesDatabase: "" });
    await p.sync(true);
    assert.equal(f.snapshot().length, 3);
    const typed = f.snapshot().find(([path]) => path.includes("/Entries/"))![1];
    assert.match(typed, /Live typed source\n\nSecond paragraph\./);
    assert.match(typed, /Earlier exact source/);
    assert.match(typed, /First handwriting transcript/);
    assert.doesNotMatch(typed, /Updating handwriting transcription/);
    const nextPageRevision = await put(`${database}/page:page`, { ...page, _rev: pageRevision.rev,
      title: "New ink revision with the same clock" });
    await p.sync(true);
    const updating = f.snapshot().find(([path]) => path.includes("/Entries/"))![1];
    assert.match(updating, /Updating handwriting transcription/);
    assert.match(updating, /First handwriting transcript/);
    assert.match(updating, /Live typed source/);
    assert.match(updating, /topics: \["Product"\]/);
    assert.match(updating, /journal-date: "2026-11-11"/);
    await put(`${database}_text/pagetext:page`, { ...recognition, _rev: textRevision.rev,
      sourceRev: nextPageRevision.rev, text: "Updated handwriting transcript" });
    await p.sync(true);
    const refreshed = f.snapshot().find(([path]) => path.includes("/Entries/"))![1];
    assert.match(refreshed, /Updated handwriting transcript/);
    assert.doesNotMatch(refreshed, /First handwriting transcript|Updating handwriting transcription/);
    assert.match(refreshed, /Earlier exact source/);
    organization = { ...organization, topics: { product: { name: "Product", present: false, counter: 2, writer: "ipad" } } };
    await put(`${database}_organization/journal:note`, { ...organization, _rev: initial.rev });
    await p.sync(true);
    assert.equal(f.snapshot().length, 2);
    assert.match(f.snapshot().find(([path]) => path.includes("/Entries/"))![1], /topics: \[\]/);
    const before = f.snapshot();
    const removed = await fetch(`${url}/${database}_organization`, { method: "DELETE", headers });
    assert.ok(removed.ok);
    await p.sync(true);
    assert.deepEqual(f.snapshot(), before);
  } finally {
    for (const name of databases) await fetch(`${url}/${name}`, { method: "DELETE", headers });
  }
});
