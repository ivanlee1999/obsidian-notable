import type { PageEntry } from "./model.ts";

/** What the plugin stamps on every note it owns. Nothing without this is ever touched. */
export const MANAGED_BY = "notable-handwriting";
export const SIDE_BY_SIDE_CLASS = "notable-side-by-side";
export type ManagedKind = "notebook" | "day" | "topic";

export interface NoteInput {
  notebookId: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
  pages: PageEntry[];
  journalDate?: string | null;
  topics?: string[];
  sideBySide?: boolean;
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
    ...(input.journalDate ? [`journal-date: ${yamlString(input.journalDate)}`] : []),
    ...(input.topics ? [`topics: [${input.topics.map(yamlString).join(", ")}]`] : []),
    `notable-id: ${yamlString(input.notebookId)}`,
    ...(input.sideBySide ? ["cssclasses:", `  - ${SIDE_BY_SIDE_CLASS}`] : []),
    // The marker that makes this note the plugin's to overwrite, and the id that lets a rename be
    // a rename. Removing either by hand is how a reader takes a note back into their own keeping.
    `managed-by: ${yamlString(MANAGED_BY)}`,
    "---",
  ].join("\n");

  const body = input.pages.map(page => renderPage(page, input.sideBySide ?? false)).join("\n\n");
  return `${frontmatter}\n\n${body}\n`;
}

export function pageHeadingTitle(page: PageEntry): string | null {
  if (page.title?.trim()) return page.title.trim().replace(/[\r\n]+/g, " ");
  const firstLine = (page.flowText ?? page.text)?.split(/\r?\n/).find(line => line.trim());
  if (!firstLine) return null;
  const cleaned = firstLine.trim().replace(/^(?:[-*+•]|\d+[.)]|[①-⑳])\s*/, "")
    .replace(/[\[\]]/g, "").trim().replace(/^#+\s*/, "").replace(/\s+/g, " ").trim();
  const characters = Array.from(cleaned);
  return characters.length > 60 ? `${characters.slice(0, 60).join("").trimEnd()}…` : cleaned || null;
}

function renderPage(page: PageEntry, sideBySide: boolean): string {
  const title = pageHeadingTitle(page);
  const heading = title
    ? `## Page ${page.number} — ${title}`
    : `## Page ${page.number}`;
  const image = page.inkPath ? `![[${page.inkPath}]]` : "";
  const content = (text: string) => `${heading}\n\n${sideBySide && image ? `${image}\n\n` : ""}${text}${!sideBySide && image ? `\n\n${image}` : ""}`;
  const staleness = page.stale
    ? "<!-- This page has been written on since it was last recognized. -->\n*Updating handwriting transcription…*\n\n"
    : "";

  if (page.flowText != null || page.previousText?.length) {
    const parts = page.flowText != null ? [page.flowText] : [];
    if (page.text?.trim()) parts.push(`### Handwriting\n\n${staleness}${page.text.trim()}`);
    else if (staleness) parts.push(staleness.trim());
    if (page.previousText?.length) {
      const sources = page.previousText.map(source => {
        const longestFence = (source.match(/`+/g) ?? []).reduce((length, run) => Math.max(length, run.length), 2);
        const fence = "`".repeat(longestFence + 1);
        return `${fence}markdown\n${source}${source.endsWith("\n") ? "" : "\n"}${fence}`;
      });
      parts.push(`<details>\n<summary>Previous text versions</summary>\n\n${sources.join("\n\n")}\n\n</details>`);
    }
    return content(parts.join("\n\n"));
  }

  if (page.text === null) {
    return content("*Not recognized yet.*");
  }
  if (page.text.trim() === "") {
    return content(staleness.trim() || "*No handwriting found on this page.*");
  }

  return content(`${staleness}${page.text.trim()}`);
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
  return JSON.stringify(value).replace(/[\u0085\u2028\u2029]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Short filenames on desktop and mobile; full identities still guard every collision/write. */
export function fileId(value: string): string {
  let a = 2166136261, b = 3339675911;
  for (const byte of new TextEncoder().encode(value)) {
    a = Math.imul(a ^ byte, 16777619);
    b = Math.imul(b ^ byte, 2246822519);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

export function renderIndex(kind: "day" | "topic", id: string, title: string, lines: string[]): string {
  return ["---", `title: ${yamlString(title)}`, `notable-id: ${yamlString(id)}`,
    `managed-kind: ${yamlString(kind)}`, `managed-by: ${yamlString(MANAGED_BY)}`, "---", "", ...lines, ""].join("\n");
}

/** Read identity from the file itself, including freshly written files not yet in Obsidian's cache. */
export function managedIdentity(contents: string, source?: string): string | null {
  contents = contents.replace(/\r\n/g, "\n");
  if (!contents.startsWith("---\n")) return null;
  const end = contents.indexOf("\n---", 4);
  if (end < 0) return null;
  const fields = new Map<string, string>();
  for (const line of contents.slice(4, end).split("\n")) {
    const match = /^([a-z-]+):\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (value.startsWith('"')) {
      try { value = JSON.parse(value) as string; } catch { return null; }
    } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replace(/''/g, "'");
    if (fields.has(match[1])) return null;
    fields.set(match[1], value);
  }
  if (fields.get("managed-by") !== MANAGED_BY || !fields.get("notable-id")) return null;
  if (source && fields.has("notable-source") && fields.get("notable-source") !== source) return null;
  const kind = fields.get("managed-kind") ?? "notebook";
  if (!["notebook", "day", "topic"].includes(kind)) return null;
  return JSON.stringify([kind, fields.get("notable-id")]);
}

/** Reserve paths before generating index links, so manual files and sanitized-name collisions survive. */
export function reservePath(path: string, identity: string, occupied: Map<string, string | null>): string {
  let candidate = path;
  const suffix = fileId(identity);
  let attempt = 0;
  while (occupied.has(candidate) && occupied.get(candidate) !== identity) {
    candidate = `${path.slice(0, -3)} ~${suffix}${attempt ? `-${attempt}` : ""}.md`;
    attempt++;
  }
  occupied.set(candidate, identity);
  return candidate;
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
