/**
 * Persistence.
 *
 * IndexedDB, because ghosts are binary blobs of a few hundred kilobytes each
 * and localStorage would mean base64-ing them into a 5 MB string budget.
 *
 * The schema is versioned with explicit migrations from the start: P5 adds
 * money and upgrades to the same profile record, and a save format that cannot
 * evolve strands every player's progress the first time it changes.
 */

import type { UpgradeLevels } from './garage.js';
import type { Medal } from './race.js';
import type { ComponentId } from '../sim/damage.js';
import type { Ghost } from '../sim/replay.js';

const DB_NAME = 'rsc';
const DB_VERSION = 2;
const PROFILE_KEY = 'profile';

/** Enough to enter the second stage and still afford a mistake. */
export const STARTING_MONEY = 1500;

export interface StageRecord {
  time: number;
  medal: Medal;
  setAt: number;
}

export interface Profile {
  version: number;
  /** Best time per stage id. */
  records: Record<string, StageRecord>;
  money: number;
  upgrades: UpgradeLevels;
  /**
   * Component health carried between races.
   *
   * This is what makes declining a repair a real decision: damage is the car's
   * state, not the run's, so it follows you to the start line of the next one.
   */
  carHealth: Partial<Record<ComponentId, number>>;
  /** Lifetime totals, for the garage summary. */
  totals: { earned: number; spentOnRepairs: number; spentOnUpgrades: number; retirements: number };
}

export const emptyProfile = (): Profile => ({
  version: DB_VERSION,
  records: {},
  money: STARTING_MONEY,
  upgrades: {},
  carHealth: {},
  totals: { earned: 0, spentOnRepairs: 0, spentOnUpgrades: 0, retirements: 0 },
});

/**
 * Applies migrations to bring an older profile up to the current version.
 * Each step is deliberately small and additive.
 */
function migrate(profile: Profile): Profile {
  const out = { ...emptyProfile(), ...profile };

  // v1 -> v2: carried damage and lifetime totals were added, and money went
  // from a placeholder zero to a real starting balance.
  if ((profile.version ?? 1) < 2) {
    out.carHealth = {};
    out.totals = emptyProfile().totals;
    if (!profile.money) out.money = STARTING_MONEY;
  }

  out.version = DB_VERSION;
  return out;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('profile')) db.createObjectStore('profile');
      if (!db.objectStoreNames.contains('ghosts')) db.createObjectStore('ghosts');
    };
    request.onsuccess = () => resolve(request.result);
    // A blocked or unavailable database is not worth failing the game over —
    // it just means this session does not persist.
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function get<T>(db: IDBDatabase, store: string, key: string): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      const request = db.transaction(store, 'readonly').objectStore(store).get(key);
      request.onsuccess = () => resolve((request.result as T) ?? null);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function put(db: IDBDatabase, store: string, key: string, value: unknown): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const request = db.transaction(store, 'readwrite').objectStore(store).put(value, key);
      request.onsuccess = () => resolve(true);
      request.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/**
 * Save/load facade.
 *
 * Every method resolves rather than rejects: persistence failing (private
 * browsing, a blocked database, no IndexedDB at all) should cost the player
 * their history, never their session. In that case this degrades to an
 * in-memory store that behaves identically until the tab closes.
 */
export class SaveStore {
  private db: IDBDatabase | null = null;
  private profile: Profile = emptyProfile();
  private readonly memoryGhosts = new Map<string, Ghost>();
  private ready = false;

  async open(): Promise<void> {
    if (this.ready) return;
    this.db = await openDb();
    if (this.db) {
      const stored = await get<Profile>(this.db, 'profile', PROFILE_KEY);
      if (stored) this.profile = migrate(stored);
    }
    this.ready = true;
  }

  get persistent(): boolean {
    return this.db !== null;
  }

  getProfile(): Profile {
    return this.profile;
  }

  /** Persist the profile as it currently stands. */
  async save(): Promise<void> {
    if (this.db) await put(this.db, 'profile', PROFILE_KEY, this.profile);
  }

  /** Mutate the profile and persist it. */
  async update(change: (profile: Profile) => void): Promise<void> {
    change(this.profile);
    await this.save();
  }

  recordFor(stageId: string): StageRecord | null {
    return this.profile.records[stageId] ?? null;
  }

  /**
   * Store a finished run if it beats the stored best.
   * Returns true when it was a new record.
   */
  async submitRun(stageId: string, time: number, medal: Medal, ghost: Ghost): Promise<boolean> {
    const previous = this.profile.records[stageId];
    if (previous && previous.time <= time) return false;

    this.profile.records[stageId] = { time, medal, setAt: Date.now() };
    this.memoryGhosts.set(stageId, ghost);

    if (this.db) {
      await put(this.db, 'profile', PROFILE_KEY, this.profile);
      await put(this.db, 'ghosts', stageId, ghost);
    }
    return true;
  }

  async loadGhost(stageId: string): Promise<Ghost | null> {
    const cached = this.memoryGhosts.get(stageId);
    if (cached) return cached;
    if (!this.db) return null;

    const stored = await get<Ghost>(this.db, 'ghosts', stageId);
    if (stored) this.memoryGhosts.set(stageId, stored);
    return stored;
  }

  /** Wipe everything. Used by the reset control and by tests. */
  async clear(): Promise<void> {
    this.profile = emptyProfile();
    this.memoryGhosts.clear();
    if (!this.db) return;
    for (const store of ['profile', 'ghosts']) {
      await new Promise<void>((resolve) => {
        try {
          const request = this.db!.transaction(store, 'readwrite').objectStore(store).clear();
          request.onsuccess = () => resolve();
          request.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    }
  }
}
