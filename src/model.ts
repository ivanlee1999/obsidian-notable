/**
 * The documents this plugin reads, and nothing else.
 *
 * Two databases are involved. `notes` is the apps' synced library, governed by their sync
 * protocol — this plugin reads notebooks/folders and projected page blocks, never page stroke
 * geometry or source attachments. `notes_text`
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
  /** Exact library page revision validated by the recognition worker. */
  sourceRev?: string;
  sourceFingerprint?: string;
  pipelineVersion?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface PageImageDoc {
  _id: string;
  _deleted?: boolean;
  pageId?: string;
  _attachments?: Record<string, { digest?: string; length?: number }>;
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

/** Projected from the library database: no stroke geometry or binary assets. */
export interface PageContentDoc {
  _id: string;
  _rev?: string;
  _deleted?: boolean;
  notebookId?: string;
  title?: string | null;
  updatedAt?: string;
  blocks?: {
    id: string;
    kind?: string;
    orderKey?: string;
    text?: string | null;
    x?: number | null;
    y?: number | null;
  }[];
  deletedBlocks?: { id: string }[];
}

export function isPageContentDoc(value: unknown): value is PageContentDoc {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const page = value as PageContentDoc;
  return typeof page._id === "string" && page._id.startsWith("page:") &&
    (page._rev === undefined || (typeof page._rev === "string" && page._rev.length > 0)) &&
    (page._deleted === true || typeof page.notebookId === "string") &&
    (page.title == null || typeof page.title === "string") &&
    (page.updatedAt == null || typeof page.updatedAt === "string") &&
    (page.blocks === undefined || (Array.isArray(page.blocks) && page.blocks.every(block =>
      block && typeof block.id === "string" && block.id.length > 0 &&
      (block.kind == null || typeof block.kind === "string") &&
      (block.orderKey == null || typeof block.orderKey === "string") &&
      (block.text == null || typeof block.text === "string")))) &&
    (page.deletedBlocks === undefined || (Array.isArray(page.deletedBlocks) &&
      page.deletedBlocks.every(block => block && typeof block.id === "string")));
}

/** Bytewise order matches the two writers, including non-ASCII fractional keys. */
function byteOrder(a: string, b: string): number {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

export function flowingText(page: PageContentDoc): { text: string | null; versions: string[] } {
  const removed = new Set((page.deletedBlocks ?? []).map(block => block.id));
  const live = (page.blocks ?? []).filter(block => !removed.has(block.id));
  const blocks = live.filter(block => (block.kind ?? "md") === "md" && typeof block.text === "string" &&
    (block.x == null || block.y == null)).sort((a, b) =>
      byteOrder(a.orderKey ?? "", b.orderKey ?? "") || byteOrder(a.id, b.id));
  const current = new Set(live.filter(block => (block.kind ?? "md") === "md" && typeof block.text === "string")
    .map(block => block.text!));
  return { text: blocks.length ? blocks.map(block => block.text).join("\n\n") : null,
    versions: [...new Set(live.filter(block => block.kind === "text-version" &&
      typeof block.text === "string" && !current.has(block.text))
      .sort((a, b) => byteOrder(a.id, b.id)).map(block => block.text!))] };
}

/** A page's text as the renderer wants it: already matched to its position in the notebook. */
export interface PageEntry {
  pageId: string;
  /** 1-based, as the notebook orders it. */
  number: number;
  title: string | null;
  text: string | null;
  stale: boolean;
  inkPath?: string | null;
  /** Canonical typed Markdown, separate from derived handwriting recognition. */
  flowText?: string | null;
  previousText?: string[];
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
