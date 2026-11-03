// Unsent composer cards (the drafts shelf): what was typed but never sent,
// across every project, surviving reloads. Per browser, in localStorage:
// text always survives, images within the attachment limits, and a full
// quota drops images oldest-first, then oldest auto cards, text last.
// Client-safe: no Node imports; storage is injected so tests use a stub.

export const DRAFT_CARDS_KEY = "pi-web:drafts-v1";
export const MAX_DRAFT_CARDS = 20;

export interface DraftCardImage {
  data: string;
  mimeType: string;
}

export type DraftCardKind = "auto" | "stashed";

export interface DraftCard {
  id: string;
  kind: DraftCardKind;
  /** The composer draftKey an auto card mirrors; absent on stashed cards. */
  key?: string;
  cwd: string;
  projectKey: string;
  value: string;
  images: DraftCardImage[];
  updatedAt: number;
  /** True while some of this card's images were dropped for quota. */
  truncated?: true;
}

export interface DraftCardsState {
  cards: DraftCard[];
}

export interface DraftCardsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface DraftCardInput {
  key?: string;
  cwd: string;
  projectKey: string;
  value: string;
  images: DraftCardImage[];
}

export interface DraftCardsSaveResult {
  droppedImages: number;
}

export function emptyCards(): DraftCardsState {
  return { cards: [] };
}

function browserStorage(): DraftCardsStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

// The sidebar shelf and every composer share one store: composers mirror
// their unsent content into it, the shelf lists it. Memory-backed outside
// a browser (tests, SSR); localStorage-backed in one.
let sharedStore: DraftCardsStore | null = null;

export function getDraftCardsStore(): DraftCardsStore {
  if (!sharedStore) {
    const storage = browserStorage() ?? (() => {
      const data = new Map<string, string>();
      return {
        getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
        setItem: (key: string, value: string) => { data.set(key, value); },
        removeItem: (key: string) => { data.delete(key); },
      };
    })();
    sharedStore = createDraftCardsStore(storage);
  }
  return sharedStore;
}

function isImage(value: unknown): value is DraftCardImage {
  return typeof value === "object" && value !== null
    && typeof (value as DraftCardImage).data === "string"
    && typeof (value as DraftCardImage).mimeType === "string";
}

/** Fresh-composer draft keys (`new:<id>:<cwd>`): only these own shelf cards.
    A chat with history keeps its parked per-session draft instead, so a card
    must never carry another chat's text into a new conversation. */
export function isFreshComposerKey(key: string | undefined): boolean {
  return typeof key === "string" && key.startsWith("new:");
}

function cleanCard(value: unknown): DraftCard | null {
  if (typeof value !== "object" || value === null) return null;
  const card = value as Record<string, unknown>;
  if (typeof card.id !== "string" || card.id === "") return null;
  if (typeof card.cwd !== "string" || typeof card.value !== "string") return null;
  if (!Array.isArray(card.images) || !card.images.every(isImage)) return null;
  if (typeof card.updatedAt !== "number" || !Number.isFinite(card.updatedAt)) return null;
  const clean: DraftCard = {
    id: card.id,
    kind: card.kind === "stashed" ? "stashed" : "auto",
    cwd: card.cwd,
    projectKey: typeof card.projectKey === "string" ? card.projectKey : card.cwd,
    value: card.value,
    images: card.images.map((image) => ({ data: image.data, mimeType: image.mimeType })),
    updatedAt: card.updatedAt,
  };
  if (typeof card.key === "string" && card.key !== "") clean.key = card.key;
  if (card.truncated === true) clean.truncated = true;
  // Cards the mirror wrote for chats with history (before the mirror was
  // fresh-composer-only): opening one starts a new chat, so they read as
  // dropped on load rather than carried anywhere.
  if (clean.kind === "auto" && !isFreshComposerKey(clean.key)) return null;
  return clean;
}

function readCards(storage: DraftCardsStorage): DraftCard[] {
  let raw: string | null = null;
  try {
    raw = storage.getItem(DRAFT_CARDS_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { cards?: unknown }).cards)) return [];
  const cards: DraftCard[] = [];
  for (const entry of (parsed as { cards: unknown[] }).cards) {
    const card = cleanCard(entry);
    if (card) cards.push(card);
  }
  return cards;
}

function newCardId(): string {
  return `d${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffff).toString(36)}`;
}

function byNewest(a: DraftCard, b: DraftCard): number {
  return b.updatedAt - a.updatedAt;
}

export interface DraftCardsStore {
  load(): DraftCardsState;
  upsertAuto(input: DraftCardInput & { key: string }, now: number): DraftCardsSaveResult;
  stash(input: Omit<DraftCardInput, "key">, now: number): DraftCard;
  remove(id: string): void;
  subscribe(listener: () => void): () => void;
  /** A window `storage` event landed: re-read and notify when it names our key. */
  onStorageEvent(key: string | null): void;
}

export function createDraftCardsStore(storage: DraftCardsStorage): DraftCardsStore {
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  // Writes with quota guard: images go oldest-card-first, then oldest auto
  // cards, stashed last. Returns what the write cost.
  const persist = (cards: DraftCard[]): { saved: boolean; droppedImages: number } => {
    let droppedImages = 0;
    const attempt = (list: DraftCard[]): boolean => {
      try {
        storage.setItem(DRAFT_CARDS_KEY, JSON.stringify({ cards: list }));
        return true;
      } catch {
        return false;
      }
    };
    if (attempt(cards)) return { saved: true, droppedImages };
    const work = cards.map((card) => ({ ...card, images: [...card.images] }));
    // Oldest cards shed their images first; every shed card is marked.
    for (const card of [...work].sort((a, b) => a.updatedAt - b.updatedAt)) {
      while (card.images.length > 0) {
        card.images.shift();
        droppedImages++;
        card.truncated = true;
        if (attempt(work)) return { saved: true, droppedImages };
      }
    }
    // Then oldest auto cards go whole, stashed only when no auto is left.
    const autoFirst = [...work].sort((a, b) => {
      if ((a.kind === "stashed") !== (b.kind === "stashed")) return a.kind === "stashed" ? 1 : -1;
      return a.updatedAt - b.updatedAt;
    });
    while (autoFirst.length > 0) {
      autoFirst.shift();
      if (attempt(autoFirst)) {
        cards.length = 0;
        cards.push(...autoFirst);
        return { saved: true, droppedImages };
      }
    }
    return { saved: false, droppedImages };
  };

  const cap = (cards: DraftCard[]): DraftCard[] => {
    if (cards.length <= MAX_DRAFT_CARDS) return cards;
    const stashed = cards.filter((card) => card.kind === "stashed");
    const auto = cards.filter((card) => card.kind !== "stashed").sort(byNewest);
    // Oldest auto go first; stashed only when auto alone still overflows.
    const kept = [...stashed, ...auto].slice(0, MAX_DRAFT_CARDS);
    return kept.sort(byNewest);
  };

  return {
    load(): DraftCardsState {
      return { cards: readCards(storage).sort(byNewest) };
    },
    upsertAuto(input, now): DraftCardsSaveResult {
      const cards = readCards(storage).filter((card) => card.id !== input.key && card.key !== input.key);
      if (input.value.trim() === "" && input.images.length === 0) {
        persist(cap(cards));
        notify();
        return { droppedImages: 0 };
      }
      cards.push({
        id: input.key,
        kind: "auto",
        key: input.key,
        cwd: input.cwd,
        projectKey: input.projectKey,
        value: input.value,
        images: input.images.map((image) => ({ ...image })),
        updatedAt: now,
      });
      const result = persist(cap(cards.sort(byNewest)));
      notify();
      return { droppedImages: result.droppedImages };
    },
    stash(input, now): DraftCard {
      const card: DraftCard = {
        id: newCardId(),
        kind: "stashed",
        cwd: input.cwd,
        projectKey: input.projectKey,
        value: input.value,
        images: input.images.map((image) => ({ ...image })),
        updatedAt: now,
      };
      const cards = [...readCards(storage), card];
      persist(cap(cards.sort(byNewest)));
      notify();
      return { ...card, images: card.images.map((image) => ({ ...image })) };
    },
    remove(id) {
      const cards = readCards(storage).filter((card) => card.id !== id);
      persist(cards);
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    onStorageEvent(key) {
      if (key !== null && key !== DRAFT_CARDS_KEY) return;
      notify();
    },
  };
}
