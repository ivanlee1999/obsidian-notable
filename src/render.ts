import type { PageEntry } from "./model.ts";

/** What the plugin stamps on every note it owns. Nothing without this is ever touched. */
export const MANAGED_BY = "notable-handwriting";

export interface NoteInput {
  notebookId: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
  pages: PageEntry[];
  /** Put the ink beside its text rather than under it. Needs the CSS snippet to take effect. */
  sideBySide?: boolean;
}

/**
 * The cssclass that the side-by-side snippet keys off.
 *
 * Presentation is left to CSS rather than baked into the markdown — a two-column table would put
 * the same pages on screen, at the cost of `<br>` in place of every line break and an escape in
 * front of every pipe. The text in these notes is the point of the whole exercise, and it stays
 * plain: without the snippet installed the note simply reads as it did before, stacked.
 */
export const SIDE_BY_SIDE_CLASS = "notable-side-by-side";

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
    ...(input.sideBySide ? ["cssclasses:", `  - ${SIDE_BY_SIDE_CLASS}`] : []),
    // The marker that makes this note the plugin's to overwrite, and the id that lets a rename be
    // a rename. Removing either by hand is how a reader takes a note back into their own keeping.
    `managed-by: ${yamlString(MANAGED_BY)}`,
    "---",
  ].join("\n");

  const body = input.pages.map((page) => renderPage(page, input.sideBySide ?? false)).join("\n\n");
  return `${frontmatter}\n\n${body}\n`;
}

/** How much of a first line is worth carrying into a heading before it stops being a label. */
const LABEL_LIMIT = 60;

/**
 * A short label for a page's heading, so that the outline pane says something.
 *
 * Without one, a seven-page notebook outlines as "Page 1" through "Page 7" — a list of numbers
 * the reader already had. The page's own title wins when it has one; otherwise the first line of
 * what was read is the closest thing to a subject the page has, and it is the line most likely to
 * be a heading in the writing itself.
 *
 * The line is left in the body as well as the heading. Cutting it would mean a note that is not
 * everything the page said, to save one repeated line.
 */
export function pageLabel(page: PageEntry): string | null {
  const title = page.title?.trim();
  if (title) return title;
  if (page.text === null) return null;

  const first = page.text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return first === undefined ? null : labelFrom(first);
}

function labelFrom(line: string): string | null {
  const cleaned = line
    // A leading bullet or number tells a reader nothing the page number beside it did not.
    .replace(/^(?:[-*+•]|\d+[.)]|[①-⑳])\s*/, "")
    // Headings render wikilinks, so a transcription containing [[...]] would put a link in the
    // outline pointing at whatever happened to be written.
    .replace(/[[\]]/g, "")
    // A leading # would nest the heading a level deeper than it belongs.
    .replace(/^#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return null;
  return cleaned.length > LABEL_LIMIT
    ? `${cleaned.slice(0, LABEL_LIMIT).trimEnd()}…`
    : cleaned;
}

function renderPage(page: PageEntry, sideBySide: boolean): string {
  const label = pageLabel(page);
  const heading = label ? `## Page ${page.number} — ${label}` : `## Page ${page.number}`;
  const embed = page.inkPath ? `![[${page.inkPath}]]` : "";

  // Stacked, the ink goes after the text, so a note reads top to bottom as writing with the
  // page there to check it against. Side by side it has to come first: the snippet floats it,
  // and a float only has text to sit beside if that text follows it in the document.
  const above = sideBySide && embed ? `${embed}\n\n` : "";
  const below = !sideBySide && embed ? `\n\n${embed}` : "";

  const say = (line: string) => `${heading}\n\n${above}${line}${below}`;

  if (page.text === null) return say("*Not recognized yet.*");
  if (page.text.trim() === "") return say("*No handwriting found on this page.*");

  // Said in a comment rather than in the prose: it is a fact about the sync, not about the note,
  // and a reader skimming their own writing should not have to read past a warning to reach it.
  const staleness = page.stale
    ? "<!-- This page has been written on since it was last recognized. -->\n"
    : "";
  return say(`${staleness}${page.text.trim()}`);
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
