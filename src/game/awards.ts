/**
 * What a run was worth, beyond the money.
 *
 * The economy already says what a race paid. This says what it *meant*: a first
 * gold, a personal best by four tenths, the moment the last stage on the list
 * turns from grey to bronze. Those are the moments a player replays a stage
 * for, and until now the game acknowledged them with a line of small text in a
 * ledger.
 *
 * Pure comparison of two profiles, so the whole thing is testable without a
 * renderer, a sound card or a race: hand it the records before and the records
 * after and it says what changed and how much of a moment it was.
 */

import type { Medal } from './race.js';
import type { StageRecord } from './save.js';

/** Medal tiers, worst to best. `finish` is completing without beating bronze. */
const ORDER: Medal[] = ['finish', 'bronze', 'silver', 'gold', 'author'];

const rank = (medal: Medal | null): number => (medal === null ? -1 : ORDER.indexOf(medal));

export type AwardKind = 'medal' | 'record' | 'sweep' | 'first' | 'board';

export interface Award {
  kind: AwardKind;
  /** The headline, shouted. */
  title: string;
  /** One line under it. */
  detail: string;
  /**
   * How big a moment, 0..3. Drives how long it holds, how hard it lands and
   * which fanfare plays — a first bronze and a clean sweep of golds should not
   * arrive the same way.
   */
  weight: number;
  /** Medal tier this belongs to, for colour. */
  medal: Medal | null;
}

export interface AwardInput {
  /** Every stage-and-variant key the game offers. */
  keys: string[];
  /** Records before the run, keyed the same way. */
  before: Record<string, StageRecord>;
  /** Records after it. */
  after: Record<string, StageRecord>;
  /** The key that was just raced. */
  key: string;
  /** Name of the stage and its conditions, for the text. */
  name: string;
}

const MEDAL_WORD: Record<Medal, string> = {
  author: 'AUTHOR TIME',
  gold: 'GOLD',
  silver: 'SILVER',
  bronze: 'BRONZE',
  finish: 'FINISHED',
};

/** How many of the field are at `medal` or better. */
function counted(keys: string[], records: Record<string, StageRecord>, medal: Medal): number {
  const bar = rank(medal);
  return keys.filter((key) => rank(records[key]?.medal ?? null) >= bar).length;
}

const seconds = (value: number): string => `${value.toFixed(2)}s`;

/**
 * Everything worth celebrating about one run, biggest last.
 *
 * Ordered so the celebration builds: the personal best lands, then the medal,
 * then whatever the medal completed. A sweep announced before the medal that
 * completed it reads backwards.
 */
export function awardsFor(input: AwardInput): Award[] {
  const { keys, before, after, key, name } = input;
  const was = before[key] ?? null;
  const now = after[key] ?? null;
  if (!now) return [];

  const awards: Award[] = [];

  // The first time anybody finishes anything.
  const finishedBefore = keys.filter((k) => before[k]).length;
  if (finishedBefore === 0) {
    awards.push({
      kind: 'first',
      title: 'FIRST FINISH',
      detail: `${name} in ${seconds(now.time)}`,
      weight: 1,
      medal: now.medal,
    });
  }

  // A personal best. Only when there was something to beat: the first time
  // round every time is a record and saying so cheapens the word.
  if (was && now.time < was.time) {
    awards.push({
      kind: 'record',
      title: 'NEW RECORD',
      detail: `${seconds(now.time)} — ${seconds(was.time - now.time)} faster`,
      weight: was.time - now.time > 1 ? 2 : 1,
      medal: now.medal,
    });
  }

  // A better medal than this stage had before.
  if (rank(now.medal) > rank(was?.medal ?? null)) {
    awards.push({
      kind: 'medal',
      title: MEDAL_WORD[now.medal],
      detail: name,
      weight: rank(now.medal) >= rank('gold') ? 2 : 1,
      medal: now.medal,
    });
  }

  // And what that medal completed. Checked from the top down so a run that
  // completes the golds is not also announced as completing the bronzes.
  for (const medal of ['author', 'gold', 'silver', 'bronze', 'finish'] as const) {
    const had = counted(keys, before, medal);
    const has = counted(keys, after, medal);
    if (has <= had || has < keys.length) continue;
    awards.push({
      kind: 'sweep',
      title:
        medal === 'finish'
          ? 'EVERY STAGE FINISHED'
          : medal === 'author'
            ? 'AUTHOR TIMES — ALL OF THEM'
            : `ALL ${MEDAL_WORD[medal]}`,
      detail: `${keys.length} stages, every one of them`,
      weight: 3,
      medal: medal === 'finish' ? null : medal,
    });
    break;
  }

  return awards;
}

/**
 * What an arcade or multiplayer run was worth.
 *
 * A different question from the career one above, and a much smaller set of
 * answers: there are no medals here, no money and no sweep — just your own
 * best, and everyone else's.
 *
 * Three tiers, because they are three genuinely different things and running
 * them together would be the same mistake as one fanfare for every medal:
 *
 * - **A personal best** is the one almost every session contains. It has to be
 *   acknowledged and it must not shout, or the shouting stops meaning
 *   anything — and it fires whether or not the time went near the board, which
 *   is the point of keeping personal times at all.
 * - **The top ten** is a real event that most players will see a handful of
 *   times.
 * - **The top of it** should be excessive. It is the rarest thing the game has
 *   to say and the only one worth interrupting somebody for.
 *
 * A run can earn the personal best *and* a place; they queue biggest-last, so
 * it plays as a build rather than as two shouts over each other.
 */
export function boardAwards(input: {
  /** Stage and conditions, for the text. */
  name: string;
  /** The time just set. */
  time: number;
  /** The personal best it beat, null for a first, undefined if it beat none. */
  beat?: number | null;
  /** Where it placed on the global board, 0-based. Null if it did not. */
  rank?: number | null;
  /** Who was on top before this run, for the line under a new record. */
  dethroned?: string | null;
}): Award[] {
  const awards: Award[] = [];
  const { name, time, beat, rank, dethroned } = input;

  if (beat !== undefined) {
    awards.push({
      kind: 'record',
      title: beat === null ? 'FIRST TIME SET' : 'PERSONAL BEST',
      detail:
        beat === null
          ? `${name} — ${seconds(time)} to beat`
          : `${name} — ${seconds(beat - time)} faster than you have ever gone`,
      weight: 0,
      medal: null,
    });
  }

  if (rank === 0) {
    awards.push({
      kind: 'board',
      title: 'FASTEST IN THE WORLD',
      detail: dethroned
        ? `${name} — you have taken it from ${dethroned}`
        : `${name} — nobody has gone quicker`,
      weight: 3,
      medal: 'author',
    });
  } else if (typeof rank === 'number' && rank > 0) {
    awards.push({
      kind: 'board',
      // Ordinal rather than "top ten": third is not second, and a board you
      // are climbing is only worth climbing if it says where you are.
      title: `${ordinal(rank + 1)} IN THE WORLD`,
      detail: `${name} — ${seconds(time)}, onto the board`,
      weight: rank < 3 ? 2 : 1,
      medal: rank < 3 ? 'gold' : 'silver',
    });
  }

  return awards;
}

const ordinal = (n: number): string => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}TH`;
  return `${n}${(['TH', 'ST', 'ND', 'RD'][n % 10] ?? 'TH')}`;
};

/**
 * Progress toward the next sweep, for the garage.
 *
 * A milestone nobody can see coming is a milestone nobody is chasing, and this
 * is what turns "eleven golds" into "two more".
 */
export function sweepProgress(
  keys: string[],
  records: Record<string, StageRecord>,
): { medal: Medal; have: number; of: number }[] {
  return (['finish', 'bronze', 'silver', 'gold', 'author'] as const).map((medal) => ({
    medal,
    have: counted(keys, records, medal),
    of: keys.length,
  }));
}
