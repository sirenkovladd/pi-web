import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  DRAFT_CARDS_KEY,
  MAX_DRAFT_CARDS,
  createDraftCardsStore,
  emptyCards,
} = await jiti.import("./drafts-store.ts");

/** localStorage-like stub, optionally with a byte budget to simulate quota. */
function stubStorage(budget = Infinity) {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => {
      const next = new Map(data);
      next.set(key, value);
      let bytes = 0;
      for (const item of next.values()) bytes += item.length;
      if (bytes > budget) {
        const error = new Error("quota exceeded");
        error.name = "QuotaExceededError";
        throw error;
      }
      data.set(key, value);
    },
    removeItem: (key) => { data.delete(key); },
  };
}

test("an empty store reads as empty, malformed JSON reads as empty", () => {
  const store = createDraftCardsStore(stubStorage());
  assert.deepEqual(store.load(), emptyCards());
  const broken = stubStorage();
  broken.setItem(DRAFT_CARDS_KEY, "{not json");
  assert.deepEqual(createDraftCardsStore(broken).load(), emptyCards());
  const shaped = stubStorage();
  shaped.setItem(DRAFT_CARDS_KEY, JSON.stringify({ cards: [{ id: 7, value: 9 }] }));
  assert.deepEqual(createDraftCardsStore(shaped).load(), emptyCards());
});

test("auto cards upsert per composer key and vanish when emptied", () => {
  const store = createDraftCardsStore(stubStorage());
  store.upsertAuto({ key: "new:abc:/work/alpha", cwd: "/work/alpha", projectKey: "/work/alpha", value: "hello", images: [] }, 1000);
  store.upsertAuto({ key: "new:abc:/work/alpha", cwd: "/work/alpha", projectKey: "/work/alpha", value: "hello world", images: [] }, 2000);
  let cards = store.load().cards;
  assert.equal(cards.length, 1);
  assert.equal(cards[0].value, "hello world");
  assert.equal(cards[0].updatedAt, 2000);
  store.upsertAuto({ key: "new:abc:/work/alpha", cwd: "/work/alpha", projectKey: "/work/alpha", value: "  ", images: [] }, 3000);
  assert.deepEqual(store.load().cards, [], "empty text and no images removes the card");
});

test("an explicit stash never merges: it is a card of its own", () => {
  const store = createDraftCardsStore(stubStorage());
  store.upsertAuto({ key: "new:abc:/work/alpha", cwd: "/work/alpha", projectKey: "/work/alpha", value: "auto", images: [] }, 1000);
  const stashed = store.stash({ cwd: "/work/alpha", projectKey: "/work/alpha", value: "auto", images: [] }, 2000);
  const both = store.load().cards;
  assert.equal(both.length, 2);
  assert.equal(stashed.kind, "stashed");
  assert.ok(both.some((item) => item.kind === "auto" && item.id !== stashed.id));
});

test("the cap evicts oldest auto first; stashed cards go last", () => {
  const store = createDraftCardsStore(stubStorage());
  for (let index = 0; index < MAX_DRAFT_CARDS; index++) {
    store.upsertAuto({ key: `new:auto${index}:/w`, cwd: "/w", projectKey: "/w", value: `v${index}`, images: [] }, index);
  }
  assert.equal(store.load().cards.length, MAX_DRAFT_CARDS);
  store.stash({ cwd: "/w", projectKey: "/w", value: "keep me", images: [] }, MAX_DRAFT_CARDS + 1);
  const cards = store.load().cards;
  assert.equal(cards.length, MAX_DRAFT_CARDS);
  assert.ok(!cards.some((item) => item.value === "v0"), "oldest auto went");
  assert.ok(cards.some((item) => item.value === "keep me"), "the stash survived");
});

test("quota failure drops images before text, and marks the card", () => {
  const big = "x".repeat(20000);
  const store = createDraftCardsStore(stubStorage(6000));
  const result = store.upsertAuto({
    key: "new:img:/w", cwd: "/w", projectKey: "/w", value: "see this",
    images: [{ data: big, mimeType: "image/png" }],
  }, 1000);
  assert.equal(result.droppedImages, 1);
  const cards = store.load().cards;
  assert.equal(cards.length, 1);
  assert.equal(cards[0].value, "see this", "text survives");
  assert.deepEqual(cards[0].images, []);
  assert.equal(cards[0].truncated, true);
});

test("remove drops one card and leaves the rest", () => {
  const store = createDraftCardsStore(stubStorage());
  const first = store.stash({ cwd: "/w", projectKey: "/w", value: "one", images: [] }, 1);
  store.stash({ cwd: "/w", projectKey: "/w", value: "two", images: [] }, 2);
  store.remove(first.id);
  assert.deepEqual(store.load().cards.map((item) => item.value), ["two"]);
});

test("subscribers hear every change, across store instances on storage events", () => {
  const storage = stubStorage();
  const first = createDraftCardsStore(storage);
  const second = createDraftCardsStore(storage);
  const heard = [];
  const stop = second.subscribe(() => heard.push(second.load().cards.length));
  first.upsertAuto({ key: "new:s:/w", cwd: "/w", projectKey: "/w", value: "hi", images: [] }, 1);
  second.onStorageEvent(DRAFT_CARDS_KEY);
  assert.deepEqual(heard, [1]);
  stop();
  first.upsertAuto({ key: "new:s:/w", cwd: "/w", projectKey: "/w", value: "hi!", images: [] }, 2);
  second.onStorageEvent(DRAFT_CARDS_KEY);
  assert.deepEqual(heard, [1], "unsubscribed hears nothing");
});

test("loading purges auto cards from chats with history; only fresh composers keep cards", () => {
  const storage = stubStorage();
  const writer = createDraftCardsStore(storage);
  writer.upsertAuto({ key: "new:abc:/work/alpha", cwd: "/work/alpha", projectKey: "/work/alpha", value: "fresh", images: [] }, 1000);
  writer.upsertAuto({ key: "01a1a32c", cwd: "/work/alpha", projectKey: "/work/alpha", value: "typed in a chat with history", images: [] }, 2000);
  writer.stash({ cwd: "/work/alpha", projectKey: "/work/alpha", value: "kept", images: [] }, 3000);
  const cards = createDraftCardsStore(storage).load().cards;
  assert.deepEqual(cards.map((card) => card.value).sort(), ["fresh", "kept"]);
});
