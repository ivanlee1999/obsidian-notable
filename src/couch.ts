import { requestUrl } from "obsidian";

export interface CouchConfig {
  url: string;
  username: string;
  password: string;
}

export interface ChangeRow<T> {
  id: string;
  seq: string;
  deleted?: boolean;
  doc?: T;
}

export interface Changes<T> {
  lastSeq: string;
  rows: ChangeRow<T>[];
}

/**
 * The slice of CouchDB's HTTP API this plugin needs — reads only.
 *
 * Obsidian's `requestUrl` rather than `fetch`: the plugin runs inside a renderer with an origin,
 * and a CouchDB on a homeserver has no reason to be sending CORS headers to it. `requestUrl`
 * goes through the host process and is not subject to that, which is what makes pointing the
 * plugin at a plain LAN CouchDB work at all.
 */
export class CouchClient {
  constructor(private readonly config: CouchConfig) {}

  private get base(): string {
    return this.config.url.replace(/\/+$/, "");
  }

  private get headers(): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.config.username) {
      // btoa is fine for credentials that are ASCII, which CouchDB usernames are; a password with
      // non-ASCII in it would need the UTF-8 dance, and CouchDB rejects those at creation.
      headers.Authorization = `Basic ${btoa(`${this.config.username}:${this.config.password}`)}`;
    }
    return headers;
  }

  /** Reachable, and the named database exists. Used by the settings screen's check button. */
  async ping(database: string): Promise<void> {
    const response = await requestUrl({
      url: `${this.base}/${encodeURIComponent(database)}`,
      headers: this.headers,
      throw: false,
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error("The server refused those credentials.");
    }
    if (response.status === 404) {
      throw new Error(`No database called "${database}" on that server.`);
    }
    if (response.status >= 400) {
      throw new Error(`The server answered ${response.status}.`);
    }
  }

  /**
   * Changes since [since], with the documents themselves.
   *
   * Deliberately not a longpoll. A plugin only runs while Obsidian is open, so it is polled on an
   * interval instead — a held-open connection would be one more thing to tear down on unload, and
   * would buy latency nobody is watching for.
   */
  async changes<T>(database: string, since: string, limit = 500): Promise<Changes<T>> {
    const url =
      `${this.base}/${encodeURIComponent(database)}/_changes` +
      `?include_docs=true&since=${encodeURIComponent(since)}&limit=${limit}`;

    const response = await requestUrl({ url, headers: this.headers, throw: false });
    if (response.status >= 400) {
      throw new Error(`Reading changes from "${database}" failed with ${response.status}.`);
    }

    const body = response.json as {
      last_seq?: string;
      results?: { id: string; seq: string; deleted?: boolean; doc?: T }[];
    };
    return {
      lastSeq: String(body.last_seq ?? since),
      rows: (body.results ?? []).map((row) => ({
        id: row.id,
        seq: String(row.seq),
        deleted: row.deleted,
        doc: row.doc,
      })),
    };
  }

  /**
   * Every document whose id starts with [prefix].
   *
   * Used for the library's notebooks and folders, which are read whole at startup rather than
   * followed: the plugin needs all of them to place any note, and there are few enough that one
   * request beats replaying a feed it does not otherwise care about.
   *
   * `￰` is the conventional CouchDB end key — a code point above anything an id contains.
   */
  async allWithPrefix<T>(database: string, prefix: string): Promise<T[]> {
    const url =
      `${this.base}/${encodeURIComponent(database)}/_all_docs` +
      `?include_docs=true&startkey=${encodeURIComponent(`"${prefix}"`)}` +
      `&endkey=${encodeURIComponent(`"${prefix}￰"`)}`;

    const response = await requestUrl({ url, headers: this.headers, throw: false });
    if (response.status >= 400) {
      throw new Error(`Reading "${prefix}" documents failed with ${response.status}.`);
    }

    const body = response.json as { rows?: { doc?: T }[] };
    return (body.rows ?? []).map((row) => row.doc).filter((doc): doc is T => Boolean(doc));
  }
}
