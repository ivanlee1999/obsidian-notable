import type { PageEntry } from "./model.ts";

/** What the plugin stamps on every note it owns. Nothing without this is ever touched. */
export const MANAGED_BY = "notable-handwriting";

export interface NoteInput {
  notebookId: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
  pages: PageEntry[];
}

/**
 * A note's full contents, rendered from scratch every time.
 *
 * Regenerating rather than patching is what makes this safe to run repeatedly: the output is a
 * function of the documents alone, so a replayed change feed, a restarted plugin, or a lost
 * checkpoint all produce the same file rather than a doubled one.
 */
export function renderNote(input: NoteInput): string {
  const frontmatter = [
    "---",
    `title: ${yamlString(input.title)}`,
    ...(input.createdAt ? [`created: ${yamlString(input.createdAt)}`] : []),
    ...(input.updatedAt ? [`updated: ${yamlString(input.updatedAt)}`] : []),
    `notable-id: ${yamlString(input.notebookId)}`,
    // The marker that makes this note the plugin's to overwrite, and the id that lets a rename be
    // a rename. Removing either by hand is how a reader takes a note back into their own keeping.
    `managed-by: ${yamlString(MANAGED_BY)}`,
    "---",
  ].join("\n");

  const body = input.pages.map(renderPage).join("\n\n");
  return `${frontmatter}\n\n${body}\n`;
}

function renderPage(page: PageEntry): string {
  const heading = page.title
    ? `## Page ${page.number} — ${page.title}`
    : `## Page ${page.number}`;

  if (page.text === null) {
    return `${heading}\n\n*Not recognized yet.*`;
  }
  if (page.text.trim() === "") {
    return `${heading}\n\n*No handwriting found on this page.*`;
  }

  // Said in a comment rather than in the prose: it is a fact about the sync, not about the note,
  // and a reader skimming their own writing should not have to read past a warning to reach it.
  const staleness = page.stale
    ? "<!-- This page has been written on since it was last recognized. -->\n"
    : "";
  return `${heading}\n\n${staleness}${page.text.trim()}`;
}

/**
 * A YAML scalar that survives whatever the title contains.
 *
 * Always quoted, because the alternative is deciding which of YAML's dozen special leading
 * characters need escaping today — and a title beginning with `-` or containing `: ` silently
 * turns a note's frontmatter into a different shape, or into a parse error Obsidian shows as a
 * broken property.
 */
export function yamlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * A filename that means the same thing as [title] and is legal in a vault.
 *
 * Obsidian forbids `*"\/<>:|?` in names, and `#^[]` carry meaning inside links, so a note called
 * `Q3: plans` would be unlinkable. Leading dots are dropped as well — a vault full of hidden
 * files is its own kind of data loss.
 */
export function sanitizeFilename(title: string): string {
  const cleaned = title
    .replace(/[*"\\/<>:|?#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "Untitled";
}

/**
 * Where a notebook's note belongs, as vault-relative path segments.
 *
 * Two notebooks can legitimately share a name — the apps identify them by id, not title — so a
 * collision takes a suffix from the id rather than letting one note overwrite the other.
 */
export function notePath(
  root: string,
  folderPath: string[],
  title: string,
  notebookId: string,
  collides: boolean,
): string {
  const name = sanitizeFilename(title);
  const suffix = collides ? ` ~${notebookId.slice(0, 8)}` : "";
  const segments = [root, ...folderPath.map(sanitizeFilename), `${name}${suffix}.md`];
  return segments.filter((segment) => segment.length > 0).join("/");
}
