import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  clearDraft,
  getDraft,
  persistComposerDrafts,
  restoreComposerDrafts,
  setDraft,
} = await jiti.import("./draft-store.ts");

/** localStorage-like stub, optionally with a byte budget to simulate quota. */
function stubStorage(budget = Infinity) {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => {
      if ([...data.values(), value].join("").length > budget) {
        const error = new Error("quota exceeded");
        error.name = "QuotaExceededError";
        throw error;
      }
      data.set(key, value);
    },
    removeItem: (key) => { data.delete(key); },
  };
}

test("composer drafts survive a reload through the persisted snapshot", () => {
  const storage = stubStorage();
  setDraft("session-abc", { value: "half-typed reply", images: [] });
  setDraft("parked-new:/work/alpha", { value: "fresh idea", images: [] });
  persistComposerDrafts(storage);
  clearDraft("session-abc");
  clearDraft("parked-new:/work/alpha");
  assert.equal(getDraft("session-abc"), null);
  restoreComposerDrafts(storage);
  assert.deepEqual(getDraft("session-abc"), { value: "half-typed reply", images: [] });
  assert.deepEqual(getDraft("parked-new:/work/alpha"), { value: "fresh idea", images: [] });
  clearDraft("session-abc");
  clearDraft("parked-new:/work/alpha");
  persistComposerDrafts(storage);
});

test("a quota failure keeps text and drops images; malformed snapshots read as empty", () => {
  const storage = stubStorage(140);
  setDraft("big", { value: "keep this text", images: [{ data: "x".repeat(200), mimeType: "image/png" }] });
  persistComposerDrafts(storage);
  clearDraft("big");
  restoreComposerDrafts(storage);
  assert.deepEqual(getDraft("big"), { value: "keep this text", images: [] });
  clearDraft("big");
  const broken = stubStorage();
  broken.setItem("pi-web:composer-drafts-v1", "{not json");
  restoreComposerDrafts(broken);
  assert.equal(getDraft("big"), null);
  persistComposerDrafts(stubStorage());
});
