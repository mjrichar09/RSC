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
import { RaceHost } from '../net/host.js';
import { RaceGuest } from '../net/guest.js';
import { acceptInvite, createInvite, type Invite } from '../net/webrtc.js';
import { MAX_PLAYERS, type PlayerInfo, type RaceSetup } from '../net/protocol.js';
import { stageVariants, type StageDef, type StageVariant } from '../sim/stage.js';

type Screen = 'choose' | 'host' | 'join';

export interface LobbyStart {
  host?: RaceHost;
  guest?: RaceGuest;
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
    this.screen = 'choose';
    this.render();
  }

  private get stage(): StageDef {
    return STAGES[this.stageIndex] ?? STAGES[0]!;
  }

  private get variants(): StageVariant[] {
    return stageVariants(this.stage);
  }

  private say(text: string): void {
    this.status = text;
    this.render();
  }

  // ---- Hosting ------------------------------------------------------------

  private startHosting(): void {
    this.host = new RaceHost({
      name: this.name,
      onLobby: (players) => {
        this.players = players;
        this.render();
      },
    });
    this.players = this.host.players;
    this.screen = 'host';
    this.status = '';
    this.render();
  }

  private async makeInvite(): Promise<void> {
    if (!this.host || this.busy) return;
    this.busy = true;
    this.say('Making an invite — gathering network candidates…');
    try {
      this.invite = await createInvite();
      this.say('Send the invite code, then paste their reply below.');
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
    try {
      await this.invite.accept(reply.trim());
      this.say('Reply accepted — waiting for the connection to open…');
    } catch (error) {
      this.say(`That reply was not readable: ${String(error)}`);
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
    this.setOpen(false);
    this.onRace?.({ host, setup, cars: host.playerCount });
  }

  // ---- Joining ------------------------------------------------------------

  private async join(code: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.say('Reading the invite…');
    try {
      const { reply, link, connected } = await acceptInvite(code.trim());
      // The reply goes on screen first: the host needs it before the channel
      // this guest is waiting for can exist.
      this.reply = reply;
      this.say('Send your reply code back to the host.');
      this.guest = new RaceGuest(await link, {
        name: this.name,
        onLobby: (players) => {
          this.players = players;
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
          });
        },
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
          <h3>Grid</h3>
          ${this.playerList()}
          <button class="wide" data-act="ready">I'm ready</button>
        </div>
      </div>`;
  }

  private playerList(): string {
    if (this.players.length === 0) return '<p class="lobby-hint">Nobody here yet.</p>';
    return `<ul class="lobby-players">${this.players
      .map(
        (player) =>
          `<li><b>P${player.car + 1}</b> ${player.name}${player.host ? ' (host)' : ''}<span>${
            player.ready ? 'ready' : 'waiting'
          }</span></li>`,
      )
      .join('')}</ul>`;
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
      this.render();
    });
    pick('variant')?.addEventListener('change', (event) => {
      this.variantIndex = Number((event.target as HTMLSelectElement).value);
    });
  }
}
