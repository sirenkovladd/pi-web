import {
  MAX_ATTACHED_IMAGES,
  isBase64ImageWithinLimits,
} from "./image-attachments";

export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
}

const drafts = new Map<string, ChatDraft>();

/** Where a fresh composer's draft waits once the page leaves it; the next fresh composer in that cwd takes it back. */
export function parkedNewSessionDraftKey(cwd: string): string {
  return `parked-new:${cwd}`;
}

function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
  };
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return !draft.value && draft.images.length === 0;
}

export function getDraft(key: string): ChatDraft | null {
  const draft = drafts.get(key);
  return draft ? cloneDraft(draft) : null;
}

export function setDraft(key: string, draft: ChatDraft): void {
  if (isEmptyDraft(draft)) {
    drafts.delete(key);
  } else {
    drafts.set(key, cloneDraft(draft));
  }
  schedulePersist();
}

export function clearDraft(key: string): void {
  drafts.delete(key);
  schedulePersist();
}

export function mergeRestoredSubmissionText(submitted: string, current: string): string {
  if (!submitted.trim()) return current;
  if (!current.trim()) return submitted;
  return `${submitted}\n\n${current}`;
}

export function mergeRestoredSubmissionDraft(
  submittedText: string,
  submittedImages: ChatDraftImage[] | undefined,
  currentText: string,
  currentImages: ChatDraftImage[],
): ChatDraft {
  const images = [...(submittedImages ?? []), ...currentImages]
    .filter(isBase64ImageWithinLimits)
    .slice(0, MAX_ATTACHED_IMAGES)
    .map(({ data, mimeType }) => ({ data, mimeType }));

  return {
    value: mergeRestoredSubmissionText(submittedText, currentText),
    images,
  };
}

export function restoreDraftSubmission(
  key: string,
  text: string,
  images?: ChatDraftImage[],
): ChatDraft {
  const current = getDraft(key) ?? { value: "", images: [] };
  const restored = mergeRestoredSubmissionDraft(
    text,
    images,
    current.value,
    current.images,
  );
  setDraft(key, restored);
  return restored;
}

/** A keystroke writes the live map; the snapshot follows 300ms later, so
    typing never pays a full-map stringify per key. Explicit-storage calls
    (tests, mostly) stay synchronous. */
let pendingPersist: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(): void {
  const storage = browserStorage();
  if (!storage) return;
  if (pendingPersist !== null) return;
  const commit = () => {
    pendingPersist = null;
    persistComposerDrafts(storage);
  };
  try {
    pendingPersist = setTimeout(commit, 300);
  } catch {
    commit();
  }
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("pagehide", commit, { once: true });
  }
}
/** localStorage snapshot of the in-memory drafts, so typed text survives a
    reload. Text first: on quota failure the snapshot is retried without
    images, then with only the newest half, then dropped silently. */
export const COMPOSER_DRAFTS_KEY = "pi-web:composer-drafts-v1";
export const MAX_PERSISTED_DRAFTS = 50;

type DraftSnapshotStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): DraftSnapshotStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function isSnapshotImage(value: unknown): value is ChatDraftImage {
  return typeof value === "object" && value !== null
    && typeof (value as ChatDraftImage).data === "string"
    && typeof (value as ChatDraftImage).mimeType === "string";
}

function cleanSnapshotDraft(value: unknown): ChatDraft | null {
  if (typeof value !== "object" || value === null) return null;
  const draft = value as Record<string, unknown>;
  if (typeof draft.value !== "string") return null;
  const images = Array.isArray(draft.images) ? draft.images.filter(isSnapshotImage) : [];
  const clean: ChatDraft = { value: draft.value, images: images.map(({ data, mimeType }) => ({ data, mimeType })) };
  return isEmptyDraft(clean) ? null : clean;
}

export function persistComposerDrafts(storage: DraftSnapshotStorage | null = browserStorage()): void {
  if (!storage) return;
  const entries = [...drafts.entries()].slice(-MAX_PERSISTED_DRAFTS);
  const full: Record<string, ChatDraft> = {};
  for (const [key, draft] of entries) full[key] = cloneDraft(draft);
  try {
    storage.setItem(COMPOSER_DRAFTS_KEY, JSON.stringify(full));
    return;
  } catch {
    // Fall through to the text-only snapshot below.
  }
  const textOnly: Record<string, ChatDraft> = {};
  for (const [key, draft] of entries) {
    if (draft.value) textOnly[key] = { value: draft.value, images: [] };
  }
  try {
    storage.setItem(COMPOSER_DRAFTS_KEY, JSON.stringify(textOnly));
    return;
  } catch {
    // Fall through to the newest-half snapshot below.
  }
  const half = Object.entries(textOnly).slice(-Math.ceil(MAX_PERSISTED_DRAFTS / 2));
  try {
    storage.setItem(COMPOSER_DRAFTS_KEY, JSON.stringify(Object.fromEntries(half)));
  } catch {
    // A hostile or full store: the live map keeps working, reload just loses it.
  }
}

export function restoreComposerDrafts(storage: DraftSnapshotStorage | null = browserStorage()): void {
  if (!storage) return;
  let raw: string | null = null;
  try {
    raw = storage.getItem(COMPOSER_DRAFTS_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null) return;
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof key !== "string" || key === "" || drafts.has(key)) continue;
    const clean = cleanSnapshotDraft(value);
    if (clean) drafts.set(key, clean);
  }
}

// A reload restores the live map before any composer reads it; server-side
// there is no localStorage, so this is a no-op there.
restoreComposerDrafts();

export function rekeyDraft(
  previousKey: string,
  nextKey: string,
  currentDraft?: ChatDraft,
): ChatDraft | null {
  if (previousKey === nextKey) return currentDraft ? cloneDraft(currentDraft) : getDraft(nextKey);

  const storedPrevious = getDraft(previousKey);
  const previous = currentDraft && !isEmptyDraft(currentDraft)
    ? cloneDraft(currentDraft)
    : (storedPrevious ?? (currentDraft ? cloneDraft(currentDraft) : null));
  const next = getDraft(nextKey);
  clearDraft(previousKey);
  if (!previous) return next;

  const merged = next
    ? mergeRestoredSubmissionDraft(next.value, next.images, previous.value, previous.images)
    : previous;
  setDraft(nextKey, merged);
  return cloneDraft(merged);
}
