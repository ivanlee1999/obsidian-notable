/**
 * The documents this plugin reads, and nothing else.
 *
 * Two databases are involved. `notes` is the apps' synced library, governed by their sync
 * protocol — this plugin only ever reads it, and only the notebook and folder documents, never a
 * page (whose body is stroke data measured in megabytes) and never an attachment. `notes_text`
 * holds recognized handwriting, one document per page. See docs/recognized-text.md in the bopa
 * repo, which is the shared contract.
 *
 * Every field is optional in practice: these documents are written by two other implementations,
 * and a plugin that throws on an unexpected shape would stop syncing the whole vault over one
 * malformed record.
 */

export interface PageTextDoc {
  _id: string;
  _rev?: string;
  _deleted?: boolean;
  pageId?: string;
  notebookId?: string | null;
  pageTitle?: string | null;
  text?: string;
  engine?: string;
  language?: string | null;
  /** The page's `updatedAt` when the recognition ran. Text is stale once the page moves past it. */
  recognizedClock?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface NotebookDoc {
  _id: string;
  _deleted?: boolean;
  title?: string;
  pageIds?: string[];
  parentFolderId?: string | null;
  /** Set while the notebook is in the Trash. */
  deletedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface FolderDoc {
  _id: string;
  _deleted?: boolean;
  title?: string;
  parentFolderId?: string | null;
  deletedAt?: string | null;
}

/** A page's text as the renderer wants it: already matched to its position in the notebook. */
export interface PageEntry {
  pageId: string;
  /** 1-based, as the notebook orders it. */
  number: number;
  title: string | null;
  text: string | null;
  stale: boolean;
}

export const idOf = (prefixed: string): string => prefixed.slice(prefixed.indexOf(":") + 1);

export const pageTextId = (pageId: string): string => `pagetext:${pageId}`;

/** Whether a document id belongs to a type this plugin reads. */
export const isNotebookId = (id: string): boolean => id.startsWith("notebook:");
export const isFolderId = (id: string): boolean => id.startsWith("folder:");
export const isPageTextId = (id: string): boolean => id.startsWith("pagetext:");

/**
 * Milliseconds for an ISO stamp, or null when it cannot be read.
 *
 * Null rather than 0 or NaN: callers compare freshness with it, and a stamp nobody can parse must
 * not silently become "the beginning of time", which would mark every page stale forever.
 */
export function millis(stamp: string | undefined | null): number | null {
  if (!stamp) return null;
  const parsed = Date.parse(stamp);
  return Number.isNaN(parsed) ? null : parsed;
}
