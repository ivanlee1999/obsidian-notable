import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
} from "obsidian";
import { CouchClient } from "./couch.ts";
import {
  isFolderId,
  isNotebookId,
  isPageTextId,
  type FolderDoc,
  type NotebookDoc,
  type PageTextDoc,
} from "./model.ts";
import { Library, type PlannedNote } from "./projection.ts";
import { MANAGED_BY } from "./render.ts";

interface Settings {
  url: string;
  username: string;
  password: string;
  notesDatabase: string;
  textDatabase: string;
  folder: string;
  pollMinutes: number;
  /** Where the text feed was last read up to. Resetting it rebuilds every note. */
  checkpoint: string;
}

const DEFAULTS: Settings = {
  url: "",
  username: "",
  password: "",
  notesDatabase: "notes",
  textDatabase: "notes_text",
  folder: "Handwritten",
  pollMinutes: 5,
  checkpoint: "0",
};

export default class NotableHandwritingPlugin extends Plugin {
  settings: Settings = { ...DEFAULTS };
  private library = new Library();
  private syncing = false;

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
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Forgets the checkpoint and reads everything again. The repair for a vault that drifted. */
  async rebuild(): Promise<void> {
    this.settings.checkpoint = "0";
    this.library = new Library();
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
      const client = new CouchClient(this.settings);

      // The library is re-read whole each sync rather than followed as a feed. It is small — one
      // document per notebook and folder — and reading it fresh means a note lands in the right
      // place after a move even if the move itself was never seen.
      const notebooks = await client.allWithPrefix<NotebookDoc>(
        this.settings.notesDatabase,
        "notebook:",
      );
      const folders = await client.allWithPrefix<FolderDoc>(
        this.settings.notesDatabase,
        "folder:",
      );
      for (const folder of folders) if (isFolderId(folder._id)) this.library.applyFolder(folder);
      for (const notebook of notebooks) {
        if (isNotebookId(notebook._id)) this.library.applyNotebook(notebook);
      }

      let changed = 0;
      let since = this.settings.checkpoint;
      // Drained in pages: a first sync against an established library is thousands of documents,
      // and asking for them in one response is how a plugin gets killed for memory.
      for (;;) {
        const changes = await client.changes<PageTextDoc>(this.settings.textDatabase, since);
        for (const row of changes.rows) {
          if (!isPageTextId(row.id)) continue;
          this.library.applyText(row.doc ?? { _id: row.id, _deleted: true });
          changed += 1;
        }
        since = changes.lastSeq;
        if (changes.rows.length === 0) break;
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
      if (announce) new Notice(`Notable: ${message}`);
    } finally {
      this.syncing = false;
    }
  }

  /** Brings the vault in line with the plan, and returns how many notes actually changed. */
  private async writeVault(): Promise<number> {
    const root = normalizePath(this.settings.folder);
    const planned = this.library.plan(root);

    let written = 0;
    const plannedPaths = new Set<string>();

    for (const note of planned) {
      const path = normalizePath(note.path);
      plannedPaths.add(path);
      if (await this.writeNote(path, note)) written += 1;
    }

    await this.removeStrandedNotes(root, plannedPaths);
    return written;
  }

  /**
   * Writes one note, moving it first if the notebook has been renamed or moved.
   *
   * A note is found by its id rather than by where it was last seen, so a rename on the tablet
   * becomes a rename in the vault — links to it survive, which they would not if the old note
   * were deleted and a new one created beside it.
   */
  private async writeNote(path: string, note: PlannedNote): Promise<boolean> {
    const existing = this.findManagedNote(note.notebookId);

    if (existing && existing.path !== path) {
      await this.ensureFolder(path);
      await this.app.fileManager.renameFile(existing, path);
    }

    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      const current = await this.app.vault.read(file);
      if (current === note.contents) return false;
      if (!this.isManaged(current)) {
        // Someone took this note into their own keeping, or a file happens to share the name.
        // Either way it is not the plugin's to overwrite.
        console.warn(`Notable: leaving unmanaged file alone: ${path}`);
        return false;
      }
      await this.app.vault.modify(file, note.contents);
      return true;
    }

    await this.ensureFolder(path);
    await this.app.vault.create(path, note.contents);
    return true;
  }

  /**
   * Deletes notes this plugin wrote that the plan no longer contains — a notebook trashed,
   * emptied, or gone. Only ever files carrying the marker, and only inside the plugin's folder.
   */
  private async removeStrandedNotes(root: string, planned: Set<string>): Promise<void> {
    for (const file of this.managedNotes(root)) {
      if (planned.has(file.path)) continue;
      // Into the system trash rather than deleted outright: this is the one destructive thing the
      // plugin does, and the ink it came from living on another device is no comfort if the
      // reader had added to the note here.
      await this.app.vault.trash(file, true);
    }
  }

  /** Every note in the plugin's folder that carries its marker. */
  private managedNotes(root: string): TFile[] {
    const prefix = `${root}/`;
    return this.app.vault
      .getMarkdownFiles()
      .filter((file) => file.path === root || file.path.startsWith(prefix))
      .filter((file) => {
        const cache = this.app.metadataCache.getFileCache(file);
        return cache?.frontmatter?.["managed-by"] === MANAGED_BY;
      });
  }

  private findManagedNote(notebookId: string): TFile | null {
    for (const file of this.app.vault.getMarkdownFiles()) {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (
        frontmatter?.["managed-by"] === MANAGED_BY &&
        frontmatter?.["notable-id"] === notebookId
      ) {
        return file;
      }
    }
    return null;
  }

  /**
   * Whether a file's own text says the plugin owns it.
   *
   * Read from the raw contents rather than the metadata cache: a file created moments ago may not
   * be in the cache yet, and treating "not cached" as "not managed" would leave the plugin unable
   * to update the note it just wrote.
   */
  private isManaged(contents: string): boolean {
    const end = contents.indexOf("\n---", 4);
    if (!contents.startsWith("---") || end <= 0) return false;
    // Quoted or not: the plugin writes it quoted, but a note that has been through another tool's
    // frontmatter handling may come back bare, and that is not a reason to abandon it.
    return new RegExp(`^managed-by:\\s*["']?${MANAGED_BY}["']?\\s*$`, "m").test(
      contents.slice(0, end),
    );
  }

  private async ensureFolder(path: string): Promise<void> {
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (!parent || this.app.vault.getAbstractFileByPath(parent)) return;
    try {
      await this.app.vault.createFolder(parent);
    } catch {
      // Already there — two notes in the same new folder race for it, and losing is fine.
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
      .setDesc("Checks that both databases are reachable with these credentials.")
      .addButton((button) =>
        button.setButtonText("Test").onClick(async () => {
          const client = new CouchClient(this.plugin.settings);
          try {
            await client.ping(this.plugin.settings.notesDatabase);
            await client.ping(this.plugin.settings.textDatabase);
            new Notice("Notable: both databases are reachable.");
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
