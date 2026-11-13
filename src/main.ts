import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  normalizePath,
} from "obsidian";
import { CouchClient, CouchReadError } from "./couch.ts";
import {
  isPageTextId,
  idOf,
  type FolderDoc,
  type NotebookDoc,
  type PageTextDoc,
  type PageImageDoc,
} from "./model.ts";
import { Library, type LibrarySnapshot, type PlannedNote } from "./projection.ts";
import { fileId, managedIdentity, reservePath, yamlString } from "./render.ts";
import { organizationSource } from "./organization.ts";

interface Settings {
  url: string;
  username: string;
  password: string;
  notesDatabase: string;
  textDatabase: string;
  imagesDatabase: string;
  sideBySide: boolean;
  folder: string;
  pollMinutes: number;
  /** Where the text feed was last read up to. Resetting it rebuilds every note. */
  checkpoint: string;
}

/** What is stored beside the settings in the plugin's data file. */
interface PersistedProjection {
  projection?: LibrarySnapshot;
  projectionSource?: string;
}

const DEFAULTS: Settings = {
  url: "",
  username: "",
  password: "",
  notesDatabase: "notes",
  textDatabase: "notes_text",
  imagesDatabase: "notes_images",
  sideBySide: false,
  folder: "Handwritten",
  pollMinutes: 5,
  checkpoint: "0",
};

export default class NotableHandwritingPlugin extends Plugin {
  settings: Settings = { ...DEFAULTS };
  private library = new Library();
  private syncing = false;
  private projectionSource = "";
  private lastFailure: string | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new NotableSettingTab(this.app, this));

    this.addCommand({
      id: "sync-handwriting",
      name: "Sync handwriting now",
      callback: () => void this.sync(true),
    });

    this.addCommand({
      id: "rebuild-handwriting",
      name: "Rebuild all handwriting notes",
      callback: () => void this.rebuild(),
    });

    // Not in onload's critical path: a server that is slow or away would hold up Obsidian's
    // startup for everything else the user actually asked for.
    this.app.workspace.onLayoutReady(() => {
      void this.sync(false);
      this.registerInterval(
        window.setInterval(
          () => void this.sync(false),
          Math.max(1, this.settings.pollMinutes) * 60_000,
        ),
      );
    });
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as (Partial<Settings> & PersistedProjection) | null;
    this.settings = Object.assign({}, DEFAULTS, data ?? {});

    // The checkpoint and the projection are one fact in two halves. The feed only ever sends
    // what is *newer* than the checkpoint, so a checkpoint that has outlived its projection
    // describes a library the plugin cannot see — and an unseeable library plans no notes, which
    // used to mean every note the plugin manages was trashed on the next sync.
    const source = organizationSource(this.settings.url, this.settings.notesDatabase, this.settings.textDatabase);
    this.projectionSource = source;
    let restored = false;
    if (data?.projectionSource === source) {
      try { restored = this.library.restore(data?.projection); }
      catch (error) { console.warn("Notable: invalid cached metadata; re-reading without changing vault files.", error); }
    }
    if (!restored && this.settings.checkpoint !== "0") {
      console.warn(
        "Notable: no saved page text for a checkpoint that has moved — re-reading from the start.",
      );
      this.settings.checkpoint = "0";
    }
  }

  async saveSettings(): Promise<void> {
    // The projection rides with the settings so the two can never be written apart. It holds
    // only page text, which is already in the vault — nothing here is a second source of truth.
    await this.saveData({ ...this.settings, projection: this.library.snapshot(), projectionSource: this.projectionSource });
  }

  /** Forgets the checkpoint and reads everything again. The repair for a vault that drifted. */
  async rebuild(): Promise<void> {
    this.settings.checkpoint = "0";
    // Keep the known metadata/text until the replacement read succeeds.
    await this.saveSettings();
    await this.sync(true);
  }

  /**
   * Pulls what has changed and writes it into the vault.
   *
   * @param announce whether to report the outcome. False for the timer, which would otherwise
   * put a notice on screen every few minutes to say that nothing happened.
   */
  async sync(announce: boolean): Promise<void> {
    if (this.syncing) return;
    if (!this.settings.url) {
      if (announce) new Notice("Notable: set a CouchDB server in the plugin settings first.");
      return;
    }

    this.syncing = true;
    try {
      const settings = { ...this.settings };
      const source = organizationSource(settings.url, settings.notesDatabase, settings.textDatabase);
      const next = new Library();
      const sameSource = this.projectionSource === source;
      if (sameSource) next.restore(this.library.snapshot());
      const client = new CouchClient(settings);
      let organization: unknown[];
      try { organization = await client.allWithPrefix<unknown>(`${settings.notesDatabase}_organization`, "journal:"); }
      catch (error) {
        throw new Error(`Cannot read ${settings.notesDatabase}_organization. Check its provisioning and access. ` +
          (error instanceof Error ? error.message : String(error)));
      }
      next.applyOrganizationSnapshot(organization);

      // The library is re-read whole each sync rather than followed as a feed. It is small — one
      // document per notebook and folder — and reading it fresh means a note lands in the right
      // place after a move even if the move itself was never seen.
      const notebooks = await client.allWithPrefix<NotebookDoc>(
        settings.notesDatabase,
        "notebook:",
      );
      const folders = await client.allWithPrefix<FolderDoc>(
        settings.notesDatabase,
        "folder:",
      );
      next.replaceLibrary(notebooks, folders);

      let changed = 0;
      let since = sameSource ? this.settings.checkpoint : "0";
      // Drained in pages: a first sync against an established library is thousands of documents,
      // and asking for them in one response is how a plugin gets killed for memory.
      for (;;) {
        let changes;
        try { changes = await client.changes<PageTextDoc>(settings.textDatabase, since); }
        catch (error) {
          if (error instanceof CouchReadError && error.status === 404) break;
          throw error;
        }
        for (const row of changes.rows) {
          if (!isPageTextId(row.id)) continue;
          next.applyText(row.doc ?? { _id: row.id, _deleted: true });
          changed += 1;
        }
        since = changes.lastSeq;
        if (changes.rows.length === 0) break;
      }

      await this.syncInk(client, settings, next);
      next.setSideBySide(settings.sideBySide);

      if (source !== organizationSource(this.settings.url, this.settings.notesDatabase, this.settings.textDatabase) ||
        settings.folder !== this.settings.folder || settings.imagesDatabase !== this.settings.imagesDatabase ||
        settings.sideBySide !== this.settings.sideBySide) return;
      this.library = next;
      this.projectionSource = source;
      this.lastFailure = null;

      // A sync that knows no page text at all cannot have a correct plan, and the only thing an
    // empty plan does is delete. Backstop for the case loadSettings cannot repair — a text
    // database genuinely emptied, a first run against a server scribe has not reached yet.
    if (this.library.isEmpty) {
      this.settings.checkpoint = since;
      await this.saveSettings();
      if (announce) new Notice("Notable: no recognized text on the server yet.");
      return;
    }

    const written = await this.writeVault();

      // The checkpoint moves only after the vault write, so a failure part-way through is retried
      // rather than skipped. Rewrites are whole-file and identical, so replaying costs nothing.
      this.settings.checkpoint = since;
      await this.saveSettings();

      if (announce) {
        new Notice(
          written === 0 && changed === 0
            ? "Notable: nothing new."
            : `Notable: ${written} note${written === 1 ? "" : "s"} updated.`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Notable handwriting sync failed", error);
      // Show a background failure once; keep manual retries explicit without repeated timer notices.
      if (announce || this.lastFailure !== message) new Notice(`Notable: ${message}`);
      this.lastFailure = message;
    } finally {
      this.syncing = false;
    }
  }

  private async syncInk(client: CouchClient, settings: Settings, library: Library): Promise<void> {
    const root = normalizePath(settings.folder);
    if (!root || root === "." || root.startsWith("/") || root.split("/").includes("..")) throw new Error("Choose a dedicated notes folder.");
    library.setInkSource(JSON.stringify([settings.url.replace(/\/+$/, ""), settings.imagesDatabase, root]));
    if (!settings.imagesDatabase) return;
    // Read the complete image manifest before replacing notes. An outage must not remove embeds.
    const images = await client.allWithPrefix<PageImageDoc>(settings.imagesDatabase, "pageimage:");
    for (const image of images) {
      const pageId = image.pageId ?? idOf(image._id);
      const attachment = image._attachments?.["page.png"];
      if (!/^[A-Za-z0-9._-]+$/.test(pageId) || image._id !== `pageimage:${pageId}` || image._deleted ||
        !attachment || typeof attachment.digest !== "string" || !attachment.digest ||
        (attachment.length !== undefined && (!Number.isSafeInteger(attachment.length) || attachment.length < 0))) {
        throw new Error("Invalid page image metadata; existing notes were preserved.");
      }
      // Keep the installed plugin's cache names so an upgrade reuses downloaded handwriting.
      const digest = attachment.digest.replace(/[^a-zA-Z0-9]/g, "").slice(-8) || "0";
      const path = `${root}/_ink/${pageId}-${digest}.png`;
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing && !(existing instanceof TFile)) throw new Error(`A folder occupies the image path ${path}.`);
      if (!existing) {
        const bytes = await client.attachment(settings.imagesDatabase, image._id, "page.png");
        if (attachment.length !== undefined && bytes.byteLength !== attachment.length) throw new Error("Incomplete handwriting image; existing notes were preserved.");
        await this.ensureFolder(path);
        await this.app.vault.createBinary(path, bytes);
      }
      library.noteInkPath(pageId, path);
    }
    // Old images remain available to existing links, including images absent from this snapshot.
  }

  /** Brings the vault in line with the plan, and returns how many notes actually changed. */
  private async writeVault(): Promise<number> {
    const root = normalizePath(this.settings.folder);
    if (!root || root === "." || root.startsWith("/") || root.split("/").includes("..")) throw new Error("Choose a dedicated notes folder.");
    const source = fileId(this.projectionSource);
    const owned = new Map<string, string | null>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (file.path.startsWith(`${root}/`)) owned.set(file.path, managedIdentity(await this.app.vault.read(file), source));
    }
    const occupied = new Map(owned);
    const planned = this.library.plan(root, (path, identity) => reservePath(normalizePath(path), identity, occupied));
    for (const note of planned) note.contents = note.contents.replace(/^---\n/, `---\nnotable-source: ${yamlString(source)}\n`);

    let written = 0;
    const plannedPaths = new Set<string>();

    for (const note of planned) {
      const path = normalizePath(note.path);
      plannedPaths.add(path);
      if (await this.writeNote(path, note, owned, source)) written += 1;
    }

    const identities = new Set(planned.map(note => JSON.stringify([note.kind ?? "notebook", note.notebookId])));
    for (const [path, identity] of owned) {
      if (!identity || plannedPaths.has(path)) continue;
      const [kind, id] = JSON.parse(identity) as string[];
      // Absence is not a deletion: keep note files when ink has not arrived or a library was reset.
      if (kind === "notebook" && !identities.has(identity) && !this.library.isTrashed(id)) continue;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile && managedIdentity(await this.app.vault.read(file), source) === identity) {
        await this.app.vault.trash(file, true);
      }
    }
    return written;
  }

  /**
   * Writes one note, moving it first if the notebook has been renamed or moved.
   *
   * A note is found by its id rather than by where it was last seen, so a rename on the tablet
   * becomes a rename in the vault — links to it survive, which they would not if the old note
   * were deleted and a new one created beside it.
   */
  private async writeNote(path: string, note: PlannedNote, owned: Map<string, string | null>, source: string): Promise<boolean> {
    const identity = JSON.stringify([note.kind ?? "notebook", note.notebookId]);
    const existingPath = [...owned].find(([, owner]) => owner === identity)?.[0];
    const existing = existingPath ? this.app.vault.getAbstractFileByPath(existingPath) : null;

    if (existing instanceof TFile && existing.path !== path) {
      if (managedIdentity(await this.app.vault.read(existing), source) !== identity || this.app.vault.getAbstractFileByPath(path)) {
        throw new Error("A note changed during sync; retrying will preserve both files.");
      }
      await this.ensureFolder(path);
      await this.app.fileManager.renameFile(existing, path);
    }

    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      const current = await this.app.vault.read(file);
      if (current === note.contents) return false;
      if (managedIdentity(current, source) !== identity) throw new Error("A file changed during sync; existing content was preserved.");
      await this.app.vault.modify(file, note.contents);
      return true;
    }

    await this.ensureFolder(path);
    await this.app.vault.create(path, note.contents);
    return true;
  }

  private async ensureFolder(path: string): Promise<void> {
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (!parent) return;
    const existing = this.app.vault.getAbstractFileByPath(parent);
    if (existing instanceof TFolder) return;
    if (existing) throw new Error(`A file occupies the notes folder ${parent}.`);
    try {
      await this.app.vault.createFolder(parent);
    } catch (error) {
      if (!(this.app.vault.getAbstractFileByPath(parent) instanceof TFolder)) throw error;
    }
  }
}

class NotableSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: NotableHandwritingPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("Your CouchDB, the same one the tablets sync with.")
      .addText((text) =>
        text
          .setPlaceholder("https://couch.example.com")
          .setValue(this.plugin.settings.url)
          .onChange(async (value) => {
            this.plugin.settings.url = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName("Username").addText((text) =>
      text.setValue(this.plugin.settings.username).onChange(async (value) => {
        this.plugin.settings.username = value.trim();
        await this.plugin.saveSettings();
      }),
    );

    new Setting(containerEl)
      .setName("Password")
      .setDesc("Stored in this vault's plugin data, unencrypted — as vault plugins must.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(this.plugin.settings.password).onChange(async (value) => {
          this.plugin.settings.password = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Notes database")
      .setDesc("Read-only, and only for notebook names and their order.")
      .addText((text) =>
        text.setValue(this.plugin.settings.notesDatabase).onChange(async (value) => {
          this.plugin.settings.notesDatabase = value.trim() || "notes";
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Text database")
      .setDesc("Where the tablets publish recognized handwriting.")
      .addText((text) =>
        text.setValue(this.plugin.settings.textDatabase).onChange(async (value) => {
          this.plugin.settings.textDatabase = value.trim() || "notes_text";
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Images database")
      .setDesc("Rendered handwriting pages. Leave empty to sync only recognized text.")
      .addText((text) => text.setValue(this.plugin.settings.imagesDatabase).onChange(async (value) => {
        this.plugin.settings.imagesDatabase = value.trim();
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Handwriting beside the text")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.sideBySide).onChange(async (value) => {
        this.plugin.settings.sideBySide = value;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Folder")
      .setDesc("Where notes are written. The plugin only ever touches files it wrote here.")
      .addText((text) =>
        text.setValue(this.plugin.settings.folder).onChange(async (value) => {
          this.plugin.settings.folder = value.trim() || "Handwritten";
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Check every")
      .setDesc("Minutes between checks, while Obsidian is open.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.pollMinutes))
          .onChange(async (value) => {
            const minutes = Number.parseInt(value, 10);
            this.plugin.settings.pollMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 5;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Connection")
      .setDesc("Checks the library, recognized text, journal organization, and configured images databases.")
      .addButton((button) =>
        button.setButtonText("Test").onClick(async () => {
          const client = new CouchClient(this.plugin.settings);
          try {
            await client.ping(this.plugin.settings.notesDatabase);
            await client.ping(this.plugin.settings.textDatabase);
            await client.ping(`${this.plugin.settings.notesDatabase}_organization`);
            if (this.plugin.settings.imagesDatabase) await client.ping(this.plugin.settings.imagesDatabase);
            new Notice("Notable: all databases are reachable.");
          } catch (error) {
            new Notice(`Notable: ${error instanceof Error ? error.message : String(error)}`);
          }
        }),
      );

    new Setting(containerEl)
      .setName("Rebuild")
      .setDesc("Reads everything again and rewrites every note. Safe: notes are regenerated whole.")
      .addButton((button) =>
        button.setButtonText("Rebuild now").onClick(async () => {
          await this.plugin.rebuild();
        }),
      );
  }
}
