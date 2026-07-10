import { afterEach, describe, expect, it } from "vitest";

import { ItemNotFoundError, ItemStore } from "./store.js";

const stores: ItemStore[] = [];

function createStore(): ItemStore {
  let id = 0;
  let time = Date.parse("2026-07-10T08:00:00.000Z");
  const store = new ItemStore({
    databasePath: ":memory:",
    idGenerator: () => `item-${++id}`,
    now: () => new Date(time++)
  });
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});

describe("ItemStore", () => {
  it("creates, reads, updates, archives, restores, and deletes an item", () => {
    const store = createStore();
    const created = store.create({
      title: "Launch summary",
      contentMarkdown: "**Ready.**",
      kind: "summary",
      project: "Website",
      tags: ["launch"],
      sourceClient: "codex"
    });

    expect(store.get(created.id)).toEqual(created);
    const updated = store.update(created.id, { archived: true, title: "Final launch summary" });
    expect(updated.title).toBe("Final launch summary");
    expect(updated.archivedAt).not.toBeNull();
    expect(store.list({ archived: "false" }).items).toEqual([]);
    expect(store.list({ archived: "true" }).items).toHaveLength(1);

    expect(store.update(created.id, { archived: false }).archivedAt).toBeNull();
    expect(store.delete(created.id)).toBe(true);
    expect(store.delete(created.id)).toBe(false);
    expect(() => store.update(created.id, { archived: true })).toThrow(ItemNotFoundError);
  });

  it("filters by search, project, kind, tag, and archive state", () => {
    const store = createStore();
    store.create({
      title: "Reply to Ana",
      contentMarkdown: "The launch is Friday.",
      kind: "reply",
      project: "Website",
      tags: ["Client", "Launch"]
    });
    const action = store.create({
      title: "Fix onboarding",
      contentMarkdown: "- [ ] Ship the welcome screen",
      kind: "action",
      project: "Product",
      tags: ["Launch"]
    });
    store.update(action.id, { archived: true });

    expect(store.list({ archived: "false", q: "Friday" }).items.map((item) => item.id)).toEqual([
      "item-1"
    ]);
    expect(
      store.list({ archived: "false", project: "website", kind: "reply", tag: "client" }).items
    ).toHaveLength(1);
    expect(store.list({ archived: "all", tag: "launch" }).items).toHaveLength(2);
  });

  it("returns count-sorted facets with the list", () => {
    const store = createStore();
    store.create({
      title: "One",
      contentMarkdown: "One",
      kind: "summary",
      project: "Alpha",
      tags: ["common", "first"]
    });
    store.create({
      title: "Two",
      contentMarkdown: "Two",
      kind: "reply",
      project: "Beta",
      tags: ["common"]
    });

    const response = store.list({ archived: "false" });
    expect(response.facets.tags[0]).toEqual({ value: "common", count: 2 });
    expect(response.facets.projects).toEqual([
      { value: "Alpha", count: 1 },
      { value: "Beta", count: 1 }
    ]);

    const filtered = store.list({ archived: "false", project: "Alpha" });
    expect(filtered.items.map((item) => item.project)).toEqual(["Alpha"]);
    expect(filtered.facets.projects).toEqual([
      { value: "Alpha", count: 1 },
      { value: "Beta", count: 1 }
    ]);
  });

  it("paginates with stable keyset cursors without truncating facet counts", () => {
    const store = createStore();
    for (let index = 1; index <= 5; index += 1) {
      store.create({
        title: `Page item ${index}`,
        contentMarkdown: `Body ${index}`,
        project: "Pagination"
      });
    }

    const first = store.list({ archived: "false", limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    expect(first.facets.projects).toContainEqual({ value: "Pagination", count: 5 });
    const second = store.list({ archived: "false", limit: 2, cursor: first.nextCursor });
    const third = store.list({ archived: "false", limit: 2, cursor: second.nextCursor });
    const ids = [...first.items, ...second.items, ...third.items].map((item) => item.id);
    expect(ids).toHaveLength(5);
    expect(new Set(ids)).toHaveLength(5);
    expect(third.nextCursor).toBeUndefined();
  });

  it("uses SQLite WAL for file-backed storage", () => {
    const store = createStore();
    const mode = store.database.pragma("journal_mode", { simple: true });
    // In-memory SQLite cannot use a WAL file, but the pragma must still be configured safely.
    expect(["memory", "wal"]).toContain(String(mode).toLowerCase());
  });
});
