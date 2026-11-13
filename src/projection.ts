import {
  idOf,
  millis,
  type FolderDoc,
  type NotebookDoc,
  type PageEntry,
  type PageTextDoc,
  type PageContentDoc,
  flowingText,
  isPageContentDoc,
} from "./model.ts";
import { fileId, notePath, renderIndex, renderNote, type ManagedKind } from "./render.ts";
import { mergeOrganization, organizationSnapshot, type OrganizationDoc } from "./organization.ts";

/**
 * The part of the projection that cannot be rebuilt from the library alone.
 *
 * Notebooks and folders are re-read whole on every sync, so they never need saving. Page text
 * does: it arrives through a checkpointed change feed, and once the checkpoint has moved past a
 * document that document is never sent again. Losing this map therefore loses every page's text
 * until the checkpoint is reset — see `Library.restore`.
 */
export interface LibrarySnapshot {
  version: 1;
  texts: PageTextDoc[];
  pageClocks: Record<string, string>;
  organization?: OrganizationDoc[];
  inkPaths?: Record<string, string>;
  inkSource?: string;
  pageContents?: PageContentDoc[];
}

/** One note the vault should hold, fully decided. */
export interface PlannedNote {
  notebookId: string;
  path: string;
  contents: string;
  kind?: ManagedKind;
}

/**
 * Everything the plugin knows, kept in memory and updated document by document.
 *
 * Held rather than re-read because the change feed delivers one document at a time and a note
 * spans many: a page's text arriving means rewriting the note its notebook owns, which needs that
 * notebook, its folder ancestry, and the text of all its other pages. Re-fetching that per change
 * would turn a burst of recognition into hundreds of requests.
 */
export class Library {
  private notebooks = new Map<string, NotebookDoc>();
  private folders = new Map<string, FolderDoc>();
  private texts = new Map<string, PageTextDoc>();
  private organization = new Map<string, OrganizationDoc>();
  private inkPaths = new Map<string, string>();
  private inkSource = "";
  private sideBySide = false;
  /** A page's `updatedAt` from its notebook's perspective, for staleness. Absent until known. */
  private pageClocks = new Map<string, string>();
  private pageContents = new Map<string, PageContentDoc>();

  /**
   * The text half of the projection, for saving between sessions.
   *
   * Only what the feed cannot re-deliver. Notebooks and folders are deliberately left out: they
   * are re-read in full every sync, so persisting them would only create a second, staler copy.
   */
  snapshot(): LibrarySnapshot {
    return {
      version: 1,
      texts: [...this.texts.values()],
      pageClocks: Object.fromEntries(this.pageClocks),
      organization: [...this.organization.values()],
      inkPaths: Object.fromEntries(this.inkPaths),
      inkSource: this.inkSource,
      pageContents: [...this.pageContents.values()],
    };
  }

  /**
   * Restores a saved snapshot. Returns whether anything was actually restored, which is what
   * lets the caller notice a checkpoint that has outlived its projection.
   */
  restore(snapshot: LibrarySnapshot | undefined): boolean {
    if (!snapshot || snapshot.version !== 1) return false;
    this.applyOrganizationSnapshot(snapshot.organization ?? []);
    this.inkPaths = new Map(Object.entries(snapshot.inkPaths ?? {}));
    this.inkSource = snapshot.inkSource ?? "";
    this.applyPageContents(snapshot.pageContents ?? []);
    for (const doc of snapshot.texts ?? []) this.applyText(doc);
    for (const [pageId, clock] of Object.entries(snapshot.pageClocks ?? {})) {
      this.pageClocks.set(pageId, clock);
    }
    return !this.isEmpty;
  }

  /** Whether any page text is known at all. An empty projection can plan nothing. */
  get isEmpty(): boolean {
    return this.texts.size === 0 && this.organization.size === 0 && this.inkPaths.size === 0 &&
      ![...this.pageContents.values()].some(page => {
        const flow = flowingText(page); return flow.text !== null || flow.versions.length > 0;
      });
  }

  setInkSource(source: string): void {
    if (this.inkSource !== source) this.inkPaths.clear();
    this.inkSource = source;
  }

  noteInkPath(pageId: string, path: string): void { this.inkPaths.set(pageId, path); }
  setSideBySide(enabled: boolean): void { this.sideBySide = enabled; }

  applyOrganizationSnapshot(values: unknown[]): void {
    const records = organizationSnapshot(values);
    for (const record of records) {
      const previous = this.organization.get(record.notebookId);
      this.organization.set(record.notebookId, previous ? mergeOrganization(previous, record) : record);
    }
  }

  replaceLibrary(notebooks: NotebookDoc[], folders: FolderDoc[]): void {
    if (notebooks.some(doc => !doc || typeof doc._id !== "string" || !doc._id.startsWith("notebook:")) ||
      folders.some(doc => !doc || typeof doc._id !== "string" || !doc._id.startsWith("folder:"))) {
      throw new Error("Invalid notebook snapshot; existing notes were preserved.");
    }
    this.notebooks = new Map(notebooks.filter(doc => !doc._deleted).map(doc => [idOf(doc._id), doc]));
    this.folders = new Map(folders.filter(doc => !doc._deleted).map(doc => [idOf(doc._id), doc]));
  }

  applyNotebook(doc: NotebookDoc): void {
    const id = idOf(doc._id);
    if (doc._deleted) this.notebooks.delete(id);
    else this.notebooks.set(id, doc);
  }

  applyFolder(doc: FolderDoc): void {
    const id = idOf(doc._id);
    if (doc._deleted) this.folders.delete(id);
    else this.folders.set(id, doc);
  }

  applyText(doc: PageTextDoc): void {
    const id = idOf(doc._id);
    if (doc._deleted) this.texts.delete(id);
    else this.texts.set(id, doc);
  }

  applyPageContents(docs: PageContentDoc[]): void {
    for (const doc of docs) {
      if (!isPageContentDoc(doc)) throw new Error("Invalid cached page content; existing notes were preserved.");
      const id = idOf(doc._id);
      if (doc._deleted) this.pageContents.delete(id);
      else {
        if (this.notebooks.size > 0 && !this.notebooks.get(doc.notebookId!)?.pageIds?.includes(id)) {
          throw new Error("A page does not belong to its notebook; existing notes were preserved.");
        }
        this.pageContents.set(id, doc);
      }
    }
  }

  /**
   * Records when a page was last edited, which is what makes its text stale.
   *
   * Optional on purpose: page documents are large, and the plugin does not read them. When the
   * clock is unknown, text is shown without a staleness note rather than guessed at.
   */
  notePageClock(pageId: string, updatedAt: string): void {
    this.pageClocks.set(pageId, updatedAt);
  }

  /** Notebooks that should have a note: not trashed, and with no trashed folder above them. */
  liveNotebooks(): NotebookDoc[] {
    return [...this.notebooks.values()].filter((notebook) => !this.isHidden(notebook));
  }

  isTrashed(notebookId: string): boolean {
    const notebook = this.notebooks.get(notebookId);
    return Boolean(notebook && this.isHidden(notebook));
  }

  /** Every page id any live notebook still lists — what text is allowed to exist for. */
  livePageIds(): Set<string> {
    const ids = new Set<string>();
    for (const notebook of this.liveNotebooks()) {
      for (const pageId of notebook.pageIds ?? []) ids.add(pageId);
    }
    return ids;
  }

  /** Text documents for pages no live notebook lists. The plugin prunes these. */
  orphanedTextIds(): string[] {
    const live = this.livePageIds();
    return [...this.texts.keys()].filter((pageId) => !live.has(pageId));
  }

  /**
   * Whether this notebook should be kept out of the vault — either it is in the Trash, or a
   * folder above it is.
   *
   * The subtree case has to be walked rather than read off the notebook: trashing a folder does
   * not restamp its descendants, so a notebook inside a trashed folder still looks perfectly live
   * on its own. The walk is depth-limited because a corrupt parent chain can be a cycle, and a
   * plugin that hangs on one is worse than one that shows a stray note.
   */
  private isHidden(notebook: NotebookDoc): boolean {
    if (notebook.deletedAt) return true;

    let parentId = notebook.parentFolderId ?? null;
    for (let depth = 0; parentId && depth < 64; depth += 1) {
      const folder = this.folders.get(parentId);
      // A missing parent may not have arrived yet. Keep orphaned ink available like Notable.
      if (!folder) return false;
      if (folder.deletedAt) return true;
      parentId = folder.parentFolderId ?? null;
    }
    return false;
  }

  /** A notebook's folder titles, outermost first. */
  private folderPath(notebook: NotebookDoc): string[] {
    const path: string[] = [];
    const seen = new Set<string>();
    let parentId = notebook.parentFolderId ?? null;
    for (let depth = 0; parentId && depth < 64; depth += 1) {
      if (seen.has(parentId)) break;
      seen.add(parentId);
      const folder = this.folders.get(parentId);
      if (!folder) break;
      path.unshift(folder.title ?? "Untitled folder");
      parentId = folder.parentFolderId ?? null;
    }
    return path;
  }

  private pages(notebook: NotebookDoc): PageEntry[] {
    return (notebook.pageIds ?? []).map((pageId, index) => {
      const text = this.texts.get(pageId);
      const content = this.pageContents.get(pageId);
      const owned = content?.notebookId === idOf(notebook._id) ? content : undefined;
      const flow = owned ? flowingText(owned) : { text: null, versions: [] };
      const pageClock = millis(owned?.updatedAt ?? this.pageClocks.get(pageId));
      const recognizedClock = millis(text?.recognizedClock);
      return {
        pageId,
        number: index + 1,
        title: owned?.title ?? text?.pageTitle ?? null,
        text: text ? (text.text ?? "") : null,
        inkPath: this.inkPaths.get(pageId) ?? null,
        flowText: flow.text,
        previousText: flow.versions,
        // Only claimed when both clocks are actually known. Guessing here would put a warning on
        // every page of a vault whose page clocks the plugin has never been told.
        stale:
          pageClock !== null && recognizedClock !== null && pageClock > recognizedClock,
      };
    });
  }

  /**
   * Every note the vault should hold right now.
   *
   * Notebooks with no recognized text at all are skipped: a vault full of notes reading "Not
   * recognized yet" from end to end is noise, and it appears the moment the plugin is pointed at
   * a library whose pages have never been read.
   */
  plan(root: string, resolvePath: (path: string, identity: string) => string = path => path): PlannedNote[] {
    const notebooks = this.liveNotebooks();

    // Which titles more than one notebook wants, so only genuine collisions take an id suffix.
    const titleCounts = new Map<string, number>();
    for (const notebook of notebooks) {
      const key = `${this.folderPath(notebook).join("/")}/${notebook.title ?? ""}`;
      titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
    }

    const planned: PlannedNote[] = [];
    for (const notebook of notebooks) {
      const pages = this.pages(notebook);
      const notebookId = idOf(notebook._id);
      const organization = this.organization.get(notebookId);
      if (!organization && !pages.some((page) => page.text !== null || page.inkPath ||
        page.flowText !== null || page.previousText?.length)) continue;
      const folderPath = this.folderPath(notebook);
      const title = notebook.title?.trim() || "Untitled";
      const key = `${folderPath.join("/")}/${notebook.title ?? ""}`;

      planned.push({
        notebookId,
        path: resolvePath(organization
          ? `${root}/Entries/${fileId(notebookId)}.md`
          : notePath(root, folderPath, title, notebookId, (titleCounts.get(key) ?? 0) > 1),
          JSON.stringify(["notebook", notebookId])),
        contents: renderNote({
          notebookId,
          title,
          createdAt: notebook.createdAt,
          updatedAt: notebook.updatedAt,
          pages,
          sideBySide: this.sideBySide,
          ...(organization ? { journalDate: organization.date,
            topics: Object.keys(organization.topics).sort().filter(key => organization.topics[key].present)
              .map(key => organization.topics[key].name) } : {}),
        }),
      });
    }
    const days = new Map<string, PlannedNote[]>();
    const topics = new Map<string, { name: string; notes: PlannedNote[] }>();
    for (const note of planned) {
      const organization = this.organization.get(note.notebookId);
      if (!organization) continue;
      if (organization.date) days.set(organization.date, [...(days.get(organization.date) ?? []), note]);
      for (const [key, state] of Object.entries(organization.topics)) {
        if (!state.present) continue;
        const topic = topics.get(key) ?? { name: state.name, notes: [] };
        topic.notes.push(note);
        topics.set(key, topic);
      }
    }
    const link = (note: PlannedNote, indexPath: string): string => {
      const title = this.notebooks.get(note.notebookId)?.title || "Untitled";
      const from = indexPath.split("/").slice(0, -1), to = note.path.split("/");
      while (from.length && to.length && from[0] === to[0]) { from.shift(); to.shift(); }
      const relative = [...from.map(() => ".."), ...to].map(encodeURIComponent).join("/");
      const label = title.replace(/[\r\n]/g, " ").replace(/[\\\[\]<>`*_]/g, "\\$&");
      return `- [${label}](<${relative}>)`;
    };
    const chronological = (notes: PlannedNote[], direction = 1): PlannedNote[] => [...notes].sort((a, b) =>
      direction * (this.organization.get(a.notebookId)!.createdAt - this.organization.get(b.notebookId)!.createdAt) ||
      (a.notebookId < b.notebookId ? -1 : a.notebookId > b.notebookId ? 1 : 0));
    for (const [date, notes] of [...days].sort(([a], [b]) => a.localeCompare(b))) {
      const path = resolvePath(`${root}/Journal/${date}.md`, JSON.stringify(["day", date]));
      planned.push({ notebookId: date, kind: "day",
        path, contents: renderIndex("day", date, date, chronological(notes).map(note => link(note, path))) });
    }
    for (const [key, topic] of [...topics].sort(([a], [b]) => a.localeCompare(b))) {
      const path = resolvePath(`${root}/Topics/${fileId(key)}.md`, JSON.stringify(["topic", key]));
      planned.push({ notebookId: key, kind: "topic",
        path, contents: renderIndex("topic", key, topic.name, chronological(topic.notes, -1).map(note => link(note, path))) });
    }
    return planned;
  }
}
