import {
  idOf,
  millis,
  type FolderDoc,
  type NotebookDoc,
  type PageEntry,
  type PageTextDoc,
} from "./model.ts";
import { notePath, renderNote } from "./render.ts";

/** One note the vault should hold, fully decided. */
export interface PlannedNote {
  notebookId: string;
  path: string;
  contents: string;
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
  /** A page's `updatedAt` from its notebook's perspective, for staleness. Absent until known. */
  private pageClocks = new Map<string, string>();

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
      // A parent that is not here at all has been deleted outright: its contents go with it.
      if (!folder) return true;
      if (folder.deletedAt) return true;
      parentId = folder.parentFolderId ?? null;
    }
    return false;
  }

  /** A notebook's folder titles, outermost first. */
  private folderPath(notebook: NotebookDoc): string[] {
    const path: string[] = [];
    let parentId = notebook.parentFolderId ?? null;
    for (let depth = 0; parentId && depth < 64; depth += 1) {
      const folder = this.folders.get(parentId);
      if (!folder) break;
      path.unshift(folder.title ?? "Untitled folder");
      parentId = folder.parentFolderId ?? null;
    }
    return path;
  }

  /**
   * Vault paths of rendered ink, by page id. Set by the plugin after it has written the files,
   * so that a note only ever embeds an image that is actually on disk — a wikilink to a missing
   * file renders as broken text in the middle of someone's notes.
   */
  private inkPaths = new Map<string, string>();

  setInkPaths(paths: Map<string, string>): void {
    this.inkPaths = paths;
  }

  private pages(notebook: NotebookDoc): PageEntry[] {
    return (notebook.pageIds ?? []).map((pageId, index) => {
      const text = this.texts.get(pageId);
      const pageClock = millis(this.pageClocks.get(pageId));
      const recognizedClock = millis(text?.recognizedClock);
      return {
        pageId,
        number: index + 1,
        title: text?.pageTitle ?? null,
        text: text ? (text.text ?? "") : null,
        // Only claimed when both clocks are actually known. Guessing here would put a warning on
        // every page of a vault whose page clocks the plugin has never been told.
        stale:
          pageClock !== null && recognizedClock !== null && pageClock > recognizedClock,
        inkPath: this.inkPaths.get(pageId) ?? null,
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
  plan(root: string): PlannedNote[] {
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
      if (!pages.some((page) => page.text !== null)) continue;

      const notebookId = idOf(notebook._id);
      const folderPath = this.folderPath(notebook);
      const title = notebook.title?.trim() || "Untitled";
      const key = `${folderPath.join("/")}/${notebook.title ?? ""}`;

      planned.push({
        notebookId,
        path: notePath(root, folderPath, title, notebookId, (titleCounts.get(key) ?? 0) > 1),
        contents: renderNote({
          notebookId,
          title,
          createdAt: notebook.createdAt,
          updatedAt: notebook.updatedAt,
          pages,
        }),
      });
    }
    return planned;
  }
}
