export interface TopicState {
  name: string;
  present: boolean;
  counter: number;
  writer: string;
}

export interface OrganizationDoc {
  _id: string;
  type: "journal";
  schema: 1;
  notebookId: string;
  date: string | null;
  createdAt: number;
  topics: Record<string, TopicState>;
}

const whitespace = /^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g;
const asciiLower = (value: string): string => value.replace(/[A-Z]/g, letter => letter.toLowerCase());
const whitespaceName = (value: string): string => value.replace(whitespace, "").replace(/[ \t\r\n\f\v]+/g, " ");
export function topicKey(name: string): string {
  let value = name.replace(whitespace, "");
  if (value.startsWith("#")) value = value.slice(1).replace(whitespace, "");
  return asciiLower(whitespaceName(value));
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate the complete snapshot before replacing any known metadata or writing the vault. */
export function organizationSnapshot(values: unknown[]): OrganizationDoc[] {
  const seen = new Set<string>();
  return values.map((value) => {
    if (!object(value) || value._deleted || value.type !== "journal" || value.schema !== 1 ||
      typeof value.notebookId !== "string" || !value.notebookId ||
      value._id !== `journal:${value.notebookId}` || seen.has(value.notebookId) ||
      !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0 ||
      !object(value.topics)) throw new Error("Invalid journal organization record; existing notes were preserved.");
    if (value.date !== null) {
      if (typeof value.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.date) ||
        !Number.isFinite(Date.parse(`${value.date}T00:00:00Z`)) ||
        new Date(`${value.date}T00:00:00Z`).toISOString().slice(0, 10) !== value.date) {
        throw new Error("Invalid journal capture date; existing notes were preserved.");
      }
    }
    for (const [key, state] of Object.entries(value.topics)) {
      if (!object(state) || typeof state.name !== "string" || !key || !state.name ||
        whitespaceName(state.name) !== state.name || asciiLower(state.name) !== key ||
        typeof state.present !== "boolean" || !Number.isSafeInteger(state.counter) ||
        (state.counter as number) < 0 || typeof state.writer !== "string" || !state.writer) {
        throw new Error("Invalid journal topic; existing notes were preserved.");
      }
    }
    seen.add(value.notebookId);
    return value as unknown as OrganizationDoc;
  });
}

export function organizationSource(url: string, notes: string, text: string): string {
  return JSON.stringify([url.replace(/\/+$/, ""), notes, text]);
}

const utf8Compare = (a: string, b: string): number => {
  const left = new TextEncoder().encode(a), right = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
};

/** Omission is not removal: keep every known register, including removal tombstones. */
export function mergeOrganization(a: OrganizationDoc, b: OrganizationDoc): OrganizationDoc {
  if (a.notebookId !== b.notebookId) throw new Error("Cannot merge different journal notes.");
  const capture = a.date === null ? b.date === null ? (a.createdAt <= b.createdAt ? a : b) : b
    : b.date === null ? a
    : a.createdAt < b.createdAt || (a.createdAt === b.createdAt && utf8Compare(a.date, b.date) <= 0) ? a : b;
  const topics: Record<string, TopicState> = Object.create(null);
  for (const key of new Set([...Object.keys(a.topics), ...Object.keys(b.topics)])) {
    const x = a.topics[key], y = b.topics[key];
    if (!x || !y) topics[key] = x ?? y;
    else {
      const order = x.counter - y.counter || utf8Compare(x.writer, y.writer) ||
        Number(!x.present) - Number(!y.present) || utf8Compare(x.name, y.name);
      topics[key] = order >= 0 ? x : y;
    }
  }
  return { _id: a._id, type: "journal", schema: 1, notebookId: a.notebookId,
    date: capture.date, createdAt: capture.createdAt, topics };
}
