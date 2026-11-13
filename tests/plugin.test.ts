import { strict as assert } from "node:assert";
import { test } from "node:test";
import vm from "node:vm";
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

function fixture(http?: (options: { url: string; headers: Record<string, string> }) => Promise<unknown>) {
  const files = new Map<string, File | Folder>();
  const trashed: File[] = [];
  let saved: any = null;
  const server: any = {
    org: [{ _id: "journal:note", type: "journal", schema: 1, notebookId: "note", date: "2026-11-11", createdAt: 1,
      topics: { product: { name: "Product", present: true, counter: 1, writer: "boox" } } }],
    books: [{ _id: "notebook:note", title: "Idea", pageIds: ["page"] }], folders: [], status: 200,
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
    requestUrl: async (options: { url: string; headers: Record<string, string> }) => {
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
      } else if (request.searchParams.get("startkey") === '"notebook:"') {
        json = { rows: server.books.map((doc: unknown) => ({ doc })) };
      } else json = { rows: server.folders.map((doc: unknown) => ({ doc })) };
      return { status, json: JSON.parse(JSON.stringify(json)) };
    },
  };
  const module = { exports: {} as any };
  vm.runInNewContext(bundle, { module, exports: module.exports, require: () => api, URL, TextEncoder,
    btoa: (value: string) => Buffer.from(value).toString("base64"),
    console: { warn() {}, error() {} }, setTimeout, clearTimeout });
  const Plugin = module.exports.default;
  function plugin() {
    const result = new Plugin();
    result.app = { vault: {
      getMarkdownFiles: () => [...files.values()].filter((file): file is File => file instanceof File),
      getAbstractFileByPath: (path: string) => files.get(path) ?? null,
      read: async (file: File) => file.contents,
      modify: async (file: File, contents: string) => { file.contents = contents; },
      create: async (path: string, contents: string) => {
        if (files.has(path)) throw new Error("File already exists");
        const file = new File(path, contents); files.set(path, file); return file;
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
    await put(`${database}/notebook:note`, { title: "Live journal entry", pageIds: [] });
    let organization = { type: "journal", schema: 1, notebookId: "note", date: "2026-11-11", createdAt: 1,
      topics: { product: { name: "Product", present: true, counter: 1, writer: "boox" } } };
    const initial = await put(`${database}_organization/journal:note`, organization);
    const f = fixture(async ({ url, headers }) => {
      const response = await fetch(url, { headers });
      return { status: response.status, json: await response.json() };
    });
    const p = f.plugin();
    Object.assign(p.settings, { url, username: user, password, notesDatabase: database, textDatabase: `${database}_text` });
    await p.sync(true);
    assert.equal(f.snapshot().length, 3);
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
