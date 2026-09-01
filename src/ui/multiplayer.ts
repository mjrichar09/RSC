/**
 * The lobby.
 *
 * There is no server, so the handshake is done by the players: the host makes
 * an invite code, sends it however they already talk to each other, and pastes
 * back the reply. It is two copy-pastes per player, once, and then the race is
 * a race. The alternative was a signalling server, a domain and a bill, for a
 * game that is otherwise a folder of static files.
 *
 * The panel owns the connection objects and hands `main.ts` a finished pair —
 * a host or a guest, and the race they agreed on — at the moment the race
 * should start.
 */

import { STAGES } from '../data/stages/index.js';
import { DEFAULT_LIVERY, LIVERIES, liveryById } from '../data/liveries.js';
import { RaceHost } from '../net/host.js';
import { RaceGuest } from '../net/guest.js';
import { acceptInvite, createInvite, type Invite } from '../net/webrtc.js';
import { MAX_PLAYERS, type PlayerInfo, type RaceSetup } from '../net/protocol.js';
import { stageVariants, type StageDef, type StageVariant } from '../sim/stage.js';

type Screen = 'choose' | 'host' | 'join';

export interface LobbyStart {
  host?: RaceHost;
  guest?: RaceGuest;
  /** Fires when the host says the whole grid is built and the lights can run. */
  onGo?: (run: () => void) => void;
  setup: RaceSetup;
  /** How many cars the world needs. */
  cars: number;
  /** Grid slots for the world, so a guest's own car keeps index 0. */
  slots?: number[];
}

export class MultiplayerPanel {
  /** Raised when the race is agreed and the world should be built. */
  onRace: ((start: LobbyStart) => void) | null = null;

  private readonly root: HTMLElement;
  private screen: Screen = 'choose';
  private open = false;

  private host: RaceHost | null = null;
  private guest: RaceGuest | null = null;
  private invite: Invite | null = null;
  private reply = '';
  private status = '';
  private busy = false;
  private stageIndex = 0;
  private variantIndex = 0;
  private players: PlayerInfo[] = [];
  /** What the other players see over this car. */
  private name = 'Driver';
  /**
   * Paint and number.
   *
   * A multiplayer car is a fresh one — nobody brings their career's wreck to
   * somebody else's race — so this is the only thing that makes it yours, and
   * the only way to tell four cars apart in a cloud of gravel.
   */
  private livery = DEFAULT_LIVERY.id;
  private number = 1;
  /** What the host has picked, as a guest sees it. */
  private pick: { stageId: string; variantId: string } | null = null;
  /** Who has crossed the line in the current race, in the order they did. */
  private readonly finished = new Map<number, number>();
  /** What to do when the grid is released. Set by whoever starts the race. */
  private go: (() => void) | null = null;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'lobby';
    parent.appendChild(this.root);
    this.render();
  }

  get isOpen(): boolean {
    return this.open;
  }

  setOpen(open: boolean): void {
    this.open = open;
    this.root.classList.toggle('is-open', open);
    // The HUD carries the flag so the touch controls can hide under a panel —
    // a throttle button behind the lobby is only ever pressed by accident.
    this.root.parentElement?.classList.toggle('in-lobby', open);
    if (open) this.render();
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  /** Tear the whole thing down — leaving a lobby, or starting a solo race. */
  reset(): void {
    this.invite?.cancel();
    this.host?.shutdown();
    this.guest?.leave();
    this.host = null;
    this.guest = null;
    this.invite = null;
    this.reply = '';
    this.status = '';
    this.players = [];
    this.pick = null;
    this.finished.clear();
    this.screen = 'choose';
    this.render();
  }

  private get stage(): StageDef {
    return STAGES[this.stageIndex] ?? STAGES[0]!;
  }

  /** The stage a guest is being asked to race, by name. */
  private get pickedName(): string {
    if (!this.pick) return 'whatever the host picks';
    const def = STAGES.find((stage) => stage.id === this.pick!.stageId);
    if (!def) return 'whatever the host picks';
    const variant = stageVariants(def).find((v) => v.id === this.pick!.variantId);
    return `${def.name}${variant ? ` · ${variant.name}` : ''}`;
  }

  private get variants(): StageVariant[] {
    return stageVariants(this.stage);
  }

  /**
   * Tell the room what is about to be raced.
   *
   * The host picks after everybody has joined, because the point of a lobby is
   * racing your friends rather than racing a stage. A guest that cannot see
   * the choice is agreeing to something nobody has told it, so the pick goes
   * out with the player list every time it changes.
   */
  private announcePick(): void {
    const variant = this.variants[this.variantIndex] ?? this.variants[0]!;
    this.pick = { stageId: this.stage.id, variantId: variant.id };
    this.host?.setStage(this.stage.id, variant.id);
  }

  /** Paint and number, live: everyone sees a repaint straight away. */
  private repaint(): void {
    if (this.host) {
      this.host.repaint(this.livery, this.number);
      this.players = this.host.players;
    }
    this.guest?.repaint(this.livery, this.number);
    this.render();
  }

  private say(text: string): void {
    this.status = text;
    this.render();
  }

  // ---- Hosting ------------------------------------------------------------

  private startHosting(): void {
    this.host = new RaceHost({
      name: this.name,
      livery: this.livery,
      number: this.number,
      onLobby: (players) => {
        this.players = players;
        this.render();
      },
      onResult: (player, time, retired) => this.noteResult(player, time, retired),
      onGo: () => this.go?.(),
    });
    this.players = this.host.players;
    this.screen = 'host';
    this.status = '';
    this.announcePick();
    this.render();
  }

  private async makeInvite(): Promise<void> {
    if (!this.host || this.busy) return;
    this.busy = true;
    this.say('Making an invite — gathering network candidates…');
    try {
      this.invite = await createInvite();
      // What this end found to connect on. An invite with no reachable
      // addresses will never connect, and saying so here is the difference
      // between a diagnosis and a lobby that sits there.
      this.say(`Send the invite code, then paste their reply below. (found ${this.invite.addresses})`);
      this.invite.onPhase = (phase, detail) => {
        if (phase === 'checking') this.say('Reply accepted — trying to reach them…');
        else if (phase === 'failed') {
          this.say(
            `Could not connect: ${detail}. Getting through needs a relay to bounce the ` +
              'traffic off, and the game has no server. If you have one, add ' +
              '?turn=turn:host:3478|user|password to the address.',
          );
          this.invite = null;
          this.render();
        }
      };
      void this.invite.connected
        .then(() => {
          if (this.invite) this.host!.accept(this.invite.link);
          this.say('Connected. Invite another player, or start the race.');
          this.invite = null;
        })
        .catch((error: Error) => this.say(error.message));
    } catch (error) {
      this.say(`Could not create an invite: ${String(error)}`);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async takeReply(reply: string): Promise<void> {
    if (!this.invite) return;
    const invite = this.invite;
    try {
      await invite.accept(reply.trim());
      this.say('Reply accepted — waiting for the connection to open…');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.say(`That reply did not work: ${message}`);
      // A dead invite cannot be retried, and leaving it on screen invites the
      // player to paste into it again and get the same error forever.
      if (invite.spent) {
        this.invite = null;
        this.render();
      }
    }
  }

  private startRace(): void {
    const host = this.host;
    if (!host) return;
    const def = this.stage;
    const variant = this.variants[this.variantIndex] ?? this.variants[0]!;
    const setup: RaceSetup = {
      stageId: def.id,
      variantId: variant.id,
      conditions: variant.conditions,
      // One seed for everybody, so the deer steps out in front of all four of
      // them in the same place.
      seed: Math.floor(Date.now() % 100000),
      players: host.players.map((player) => ({ ...player })),
    };
    this.finished.clear();
    this.setOpen(false);
    this.onRace?.({
      host,
      setup,
      cars: host.playerCount,
      onGo: (run) => {
        this.go = run;
      },
    });
  }

  /**
   * Somebody finished.
   *
   * The host is the only one who hears from everybody, so it is the only one
   * that can decide a race. First across the line takes it — a retirement is
   * not a time — and the tally belongs to the lobby rather than to a profile:
   * it is the reason to run another one with the same people, and it means
   * nothing outside the room.
   */
  private noteResult(player: number, time: number | null, retired: boolean): void {
    if (!this.host || retired || time === null) return;
    if (this.finished.has(player)) return;
    this.finished.set(player, time);
    if (this.finished.size === 1) this.host.creditWin(player);
    this.players = this.host.players;
  }

  /**
   * Back to the lobby, to pick again.
   *
   * Called when a multiplayer race is over. The whole shape of a session is
   * race, look at the tally, pick a different stage, race again — going back
   * to the garage instead would end the evening after one stage.
   */
  returnToLobby(): void {
    this.finished.clear();
    this.host?.reopen();
    if (this.host) this.players = this.host.players;
    this.setOpen(true);
    this.say(this.host ? 'Pick another stage and go again.' : 'Waiting for the host to pick again.');
  }

  /**
   * Open a hosted lobby with a full grid, for the screenshot harness.
   *
   * The lobby is otherwise only reachable with two browsers and a handshake,
   * which means nobody ever looks at it — and a panel nobody looks at is a
   * panel that quietly stops fitting on the screen.
   */
  demo(): void {
    this.startHosting();
    this.players = [
      ...this.host!.players,
      { id: 1, name: 'Kaisa', host: false, car: 1, ready: true, livery: 'martini', number: 14, wins: 2 },
      { id: 2, name: 'Rune', host: false, car: 2, ready: false, livery: 'forest-green', number: 8, wins: 1 },
      { id: 3, name: 'Ottó', host: false, car: 3, ready: true, livery: 'ember', number: 33, wins: 0 },
    ];
    this.render();
  }

  /** Whether there is a lobby to go back to at all. */
  get inLobby(): boolean {
    return this.host !== null || this.guest !== null;
  }

  // ---- Joining ------------------------------------------------------------

  private async join(code: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.say('Reading the invite…');
    try {
      const { reply, addresses, link, connected } = await acceptInvite(code.trim(), (phase, detail) => {
        if (phase === 'checking') this.say('Reaching the host…');
        else if (phase === 'failed') {
          this.say(
            `Could not connect: ${detail}. Getting through needs a relay to bounce the ` +
              'traffic off, and the game has no server. If you have one, add ' +
              '?turn=turn:host:3478|user|password to the address.',
          );
        }
      });
      // The reply goes on screen first, and `say` renders: the host needs it
      // before the channel this guest is waiting for can exist, so anything
      // that waits for the channel before painting the reply deadlocks the
      // handshake with each side waiting for the other.
      this.reply = reply;
      this.say(`Send your reply code back to the host. (found ${addresses})`);
      this.guest = new RaceGuest(await link, {
        name: this.name,
        livery: this.livery,
        number: this.number,
        onLobby: (players, pick) => {
          this.players = players;
          this.pick = pick;
          this.render();
        },
        onStart: (setup) => {
          const guest = this.guest!;
          this.setOpen(false);
          this.onRace?.({
            guest,
            setup,
            cars: Math.max(setup.players.length, guest.car + 1),
            slots: guest.slots,
            onGo: (run) => {
              this.go = run;
            },
          });
        },
        onGo: () => this.go?.(),
        onClose: () => this.say('The host disconnected.'),
      });
      void connected
        .then(() => this.say('Connected. Waiting for the host to start.'))
        .catch((error: Error) => this.say(error.message));
    } catch (error) {
      this.say(`That invite code was not readable: ${String(error)}`);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  // ---- Rendering ----------------------------------------------------------

  private render(): void {
    if (!this.open) {
      this.root.innerHTML = '';
      return;
    }
    this.root.innerHTML = `
      <div class="lobby-inner">
        <div class="lobby-head">
          <div>
            <div class="lobby-title">MULTIPLAYER</div>
            <div class="lobby-sub">Up to ${MAX_PLAYERS} cars, contact and all</div>
          </div>
          <button data-act="close">Close</button>
        </div>
        ${this.body()}
        ${this.status ? `<div class="lobby-status">${this.status}</div>` : ''}
      </div>`;
    this.bind();
  }

  private body(): string {
    if (this.screen === 'choose') {
      return `
        <p class="lobby-hint">
          There is no server: you and the other players exchange two codes — over
          chat, or read out over a call — and then talk to each other directly.
          Whoever hosts runs the race, so pick the best connection.
        </p>
        <label class="lobby-field">Your name
          <input data-act="name" maxlength="16" value="${this.name}">
        </label>
        <div class="lobby-actions">
          <button data-act="host">Host a race</button>
          <button data-act="join">Join a race</button>
        </div>`;
    }
    if (this.screen === 'host') return this.hostBody();
    return this.joinBody();
  }

  private hostBody(): string {
    const stages = STAGES.map(
      (stage, i) =>
        `<option value="${i}"${i === this.stageIndex ? ' selected' : ''}>${stage.name}</option>`,
    ).join('');
    const variants = this.variants
      .map(
        (variant, i) =>
          `<option value="${i}"${i === this.variantIndex ? ' selected' : ''}>${variant.name}</option>`,
      )
      .join('');

    return `
      <div class="lobby-cols">
        <div>
          <h3>The race</h3>
          <label class="lobby-field">Stage <select data-act="stage">${stages}</select></label>
          <label class="lobby-field">Conditions <select data-act="variant">${variants}</select></label>
          <h3>Your car</h3>
          ${this.liveryPicker()}
          <h3>Grid</h3>
          ${this.playerList()}
          <button class="wide" data-act="start" ${this.host && this.host.playerCount > 1 ? '' : 'disabled'}>
            Start the race
          </button>
        </div>
        <div>
          <h3>Invite a player</h3>
          ${
            this.invite
              ? `<p class="lobby-hint">1 — send them this code.</p>
                 <textarea readonly data-act="code">${this.invite.code}</textarea>
                 <button data-act="copy">Copy invite code</button>
                 <p class="lobby-hint">2 — paste the reply they send back.</p>
                 <textarea data-act="reply" placeholder="their reply code"></textarea>
                 <button data-act="accept">Connect them</button>`
              : `<p class="lobby-hint">
                   One invite per player. Make one, send it, paste the reply, repeat.
                 </p>
                 <button data-act="invite" ${this.host?.full ? 'disabled' : ''}>Make an invite code</button>`
          }
        </div>
      </div>`;
  }

  private joinBody(): string {
    if (!this.reply) {
      return `
        <h3>Paste the invite</h3>
        <textarea data-act="invite-in" placeholder="the code the host sent you"></textarea>
        <button data-act="use-invite">Continue</button>`;
    }
    return `
      <div class="lobby-cols">
        <div>
          <h3>Send this back</h3>
          <textarea readonly data-act="code">${this.reply}</textarea>
          <button data-act="copy">Copy reply code</button>
        </div>
        <div>
          <h3>Your car</h3>
          ${this.liveryPicker()}
          <h3>Racing</h3>
          <p class="lobby-hint">${this.pickedName}</p>
          <h3>Grid</h3>
          ${this.playerList()}
          <button class="wide" data-act="ready">I'm ready</button>
        </div>
      </div>`;
  }

  private playerList(): string {
    if (this.players.length === 0) return '<p class="lobby-hint">Nobody here yet.</p>';
    return `<ul class="lobby-players">${this.players
      .map((player) => {
        const paint = liveryById(player.livery);
        const swatch =
          `<i class="lobby-swatch" style="background:#${paint.body.toString(16).padStart(6, '0')}"></i>`;
        // Wins first, because after the first race it is the only number in
        // the room anybody cares about.
        const tally = player.wins > 0 ? `${player.wins} win${player.wins > 1 ? 's' : ''}` : '';
        return `<li>${swatch}<b>#${player.number}</b> ${player.name}${
          player.host ? ' (host)' : ''
        }<span>${tally || (player.ready ? 'ready' : 'waiting')}</span></li>`;
      })
      .join('')}</ul>`;
  }

  /** Paint and number, offered wherever a player is waiting to race. */
  private liveryPicker(): string {
    const options = LIVERIES.map(
      (paint) =>
        `<option value="${paint.id}"${paint.id === this.livery ? ' selected' : ''}>${paint.name}</option>`,
    ).join('');
    return `
      <label class="lobby-field">Paint <select data-act="livery">${options}</select></label>
      <label class="lobby-field">Number
        <input data-act="number" type="number" min="1" max="99" value="${this.number}">
      </label>`;
  }

  private bind(): void {
    const pick = (act: string) => this.root.querySelector<HTMLElement>(`[data-act="${act}"]`);
    const on = (act: string, handler: () => void) =>
      pick(act)?.addEventListener('click', handler);

    on('close', () => this.setOpen(false));
    on('host', () => this.startHosting());
    on('join', () => {
      this.screen = 'join';
      this.render();
    });
    on('invite', () => void this.makeInvite());
    on('accept', () => {
      const box = pick('reply') as HTMLTextAreaElement | null;
      if (box?.value) void this.takeReply(box.value);
    });
    on('use-invite', () => {
      const box = pick('invite-in') as HTMLTextAreaElement | null;
      if (box?.value) void this.join(box.value);
    });
    on('copy', () => {
      const box = pick('code') as HTMLTextAreaElement | null;
      if (!box) return;
      box.select();
      void navigator.clipboard?.writeText(box.value).then(() => this.say('Copied.'));
    });
    on('ready', () => this.guest?.ready(true));
    on('start', () => this.startRace());

    pick('name')?.addEventListener('input', (event) => {
      this.name = (event.target as HTMLInputElement).value.slice(0, 16) || 'Driver';
    });
    pick('stage')?.addEventListener('change', (event) => {
      this.stageIndex = Number((event.target as HTMLSelectElement).value);
      this.variantIndex = 0;
      this.announcePick();
      this.render();
    });
    pick('variant')?.addEventListener('change', (event) => {
      this.variantIndex = Number((event.target as HTMLSelectElement).value);
      this.announcePick();
    });
    pick('livery')?.addEventListener('change', (event) => {
      this.livery = (event.target as HTMLSelectElement).value;
      this.repaint();
    });
    pick('number')?.addEventListener('change', (event) => {
      const value = Number((event.target as HTMLInputElement).value);
      this.number = Math.min(Math.max(Math.round(value) || 1, 1), 99);
      this.repaint();
    });
  }
}
