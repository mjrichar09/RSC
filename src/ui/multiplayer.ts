/**
 * The lobby.
 *
 * Two ways in, and the second one only exists because the first is friction
 * every single time.
 *
 * **A room code.** The host opens a room and reads out six characters; the
 * guest types them in. A broker holds the handshake for a few seconds (see
 * `net/room.ts` and `server/`) and then forgets it. Nothing about a race goes
 * through it.
 *
 * **Invite codes, by hand.** The host makes an invite, sends it however they
 * already talk to each other, and pastes back the reply. Two copy-pastes per
 * player. This is what the game did before there was a broker, and it is kept
 * — not as a legacy path, but as the floor: it needs no infrastructure, works
 * on a LAN with no internet, and still works on the day the broker stops being
 * paid for. When there is no broker configured the lobby simply *is* this.
 *
 * The panel owns the connection objects and hands `main.ts` a finished pair —
 * a host or a guest, and the race they agreed on — at the moment the race
 * should start.
 */

import { STAGES } from '../data/stages/index.js';
import { DEFAULT_LIVERY, LIVERIES, liveryById } from '../data/liveries.js';
import { RaceHost } from '../net/host.js';
import { RaceGuest } from '../net/guest.js';
import { acceptInvite, createInvite, type Invite, type RtcLink } from '../net/webrtc.js';
import { formatRoomCode, makeRoomCode, normaliseRoomCode, type Room } from '../net/room.js';
import { brokerFor } from '../net/roomHttp.js';
import { joinRoom, serveRoom, type ServedRoom } from '../net/signalling.js';
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
  /**
   * The room broker, or null when none is configured.
   *
   * Read once, at construction: whether the game has a broker is a property of
   * how it was deployed, not something that changes while somebody is looking
   * at a lobby. Null is a supported state, not a failure — the panel falls back
   * to invite codes and says nothing about it.
   */
  private readonly broker: Room | null = brokerFor(new URLSearchParams(location.search));
  /** The code this host is holding open, and the loop serving it. */
  private roomCode: string | null = null;
  private served: ServedRoom | null = null;
  /** What the guest typed, kept so a bad code stays on screen to be corrected. */
  private roomEntry = '';
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
    // Before the host goes: the broker should stop handing out offers for a
    // lobby that no longer exists, so a stale code fails fast instead of
    // connecting somebody to nothing.
    this.served?.close();
    this.served = null;
    this.roomCode = null;
    this.roomEntry = '';
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

  /**
   * The invite, as something you can send in one action.
   *
   * A 96-character code is short enough to read out and still a thing the
   * other player has to copy, open the game, find the join box and paste into.
   * A link is a tap: it opens the game with the code already applied, and the
   * first thing they see is their own reply. Same code, one fewer step each
   * way, and the bare code is still on screen for anyone whose chat app eats
   * links.
   */
  private inviteLink(code: string): string {
    const url = new URL(location.href);
    url.hash = '';
    url.searchParams.set('join', code);
    return url.toString();
  }

  /**
   * Hand a string to the player as directly as the platform allows.
   *
   * `navigator.share` opens the OS share sheet, which on a phone is the whole
   * job done — pick the conversation and it is sent. Everywhere else it is the
   * clipboard, which is what it always was.
   */
  private async handOver(text: string, title: string): Promise<void> {
    const share = navigator.share?.bind(navigator);
    if (share) {
      try {
        await share({ text, title });
        this.say('Sent.');
        return;
      } catch {
        // Cancelled, or refused. Fall through to the clipboard.
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      this.say('Copied.');
    } catch {
      this.say('Select the box and copy it by hand — the browser would not.');
    }
  }

  /**
   * Take the reply straight from the clipboard.
   *
   * The host had to focus a textarea, long-press, paste, and then press a
   * second button. On a phone that is four deliberate actions to finish a
   * handshake. Reading the clipboard is one, and the textarea stays for the
   * browsers that refuse to be read.
   */
  private async pasteReply(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        this.say('Nothing in the clipboard yet — copy their reply first.');
        return;
      }
      await this.takeReply(text);
    } catch {
      this.say('This browser will not let the game read the clipboard. Paste it into the box.');
    }
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
    this.openRoom();
    this.render();
  }

  /**
   * Hold a room open for the whole life of the lobby.
   *
   * Started with the lobby rather than on a button, because a code that only
   * exists after somebody asks for it is a step, and removing the steps is the
   * entire point. The loop publishes an offer, waits for a reply, and connects
   * whoever answers; it republishes immediately, so there is always something
   * for the next player to take.
   */
  private openRoom(): void {
    if (!this.broker || this.served) return;
    const code = makeRoomCode().replace('-', '');
    this.roomCode = code;
    this.served = serveRoom({
      room: this.broker,
      code,
      // The host holds a slot of its own, so the room only ever offers the rest.
      slots: MAX_PLAYERS - 1,
      onLink: (link) => this.host?.accept(link),
      onStatus: (message) => this.say(message),
    });
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

  /**
   * Open straight onto somebody's invite.
   *
   * The link the host sends carries the code, so the guest's whole side of the
   * handshake is: tap the link, tap send. Nothing is copied, nothing is
   * pasted, and there is no screen to find first.
   */
  joinFromLink(code: string): void {
    this.screen = 'join';
    this.setOpen(true);
    void this.join(code);
  }

  /** Open straight onto a room code, from a `?room=` link. */
  joinRoomFromLink(code: string): void {
    this.screen = 'join';
    this.roomEntry = code;
    this.setOpen(true);
    void this.joinByRoom(code);
  }

  /** Whether there is a lobby to go back to at all. */
  get inLobby(): boolean {
    return this.host !== null || this.guest !== null;
  }

  // ---- Joining ------------------------------------------------------------

  /**
   * Join by room code.
   *
   * The code is normalised before anything is sent, so "k7f m29" and "K7F-M29"
   * are the same room and a code that could not be one is rejected here rather
   * than after a pointless round trip.
   */
  private async joinByRoom(typed: string): Promise<void> {
    if (this.busy) return;
    const code = normaliseRoomCode(typed);
    if (!code) {
      // And the other way round: an invite code pasted into the room box. They
      // are not close in length, so this is never a guess.
      if (typed.trim().length > 20) return this.join(typed);
      this.say('That is not a room code — six characters, like K7F-M29.');
      return;
    }
    if (!this.broker) {
      this.say('This copy of the game has no room service. Use an invite code instead.');
      return;
    }
    this.busy = true;
    try {
      const link = await joinRoom({
        room: this.broker,
        code,
        onStatus: (message) => this.say(message),
      });
      this.attachGuest(link);
    } catch (error) {
      this.say(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy = false;
      this.render();
    }
  }


  private async join(code: string): Promise<void> {
    if (this.busy) return;
    // A room code in the invite box is not a mistake worth an error message.
    //
    // The two are told apart trivially — one is six characters and the other is
    // ninety-six — and a player who has been handed "RMX-2XU" and types it into
    // whichever box is in front of them has done nothing wrong. Reported as
    // "that invite code was not readable: invalid characters", which is true,
    // useless, and says nothing about the box six lines above.
    const asRoom = normaliseRoomCode(code);
    if (asRoom) {
      if (this.broker) return this.joinByRoom(asRoom);
      this.say(
        `${formatRoomCode(asRoom)} is a room code, and this copy of the game has no room ` +
          'service to look it up in. Ask the host for an invite code instead.',
      );
      return;
    }
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
      this.attachGuest(await link);
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

  /**
   * Become a guest on a link that is already open.
   *
   * Shared by both routes in, because everything after the handshake is
   * identical — a link is a link however the two ends found each other, which
   * is the property that made adding a room code a small change rather than a
   * second lobby.
   */
  private attachGuest(link: RtcLink): void {
    this.guest = new RaceGuest(link, {
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
    this.say('Connected. Waiting for the host to start.');
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
          ${this.roomPanel()}
          <h3>Invite a player</h3>
          ${
            this.invite
              ? `<p class="lobby-hint">1 — send them this link. It opens the game ready to join.</p>
                 <button class="wide primary" data-act="send-invite">Send invite link</button>
                 <details class="lobby-raw">
                   <summary>or copy it by hand</summary>
                   <textarea readonly data-act="code">${this.inviteLink(this.invite.code)}</textarea>
                 </details>
                 <p class="lobby-hint">2 — when they send their reply back, take it.</p>
                 <button class="wide primary" data-act="paste">Paste their reply</button>
                 <details class="lobby-raw">
                   <summary>or paste it in here</summary>
                   <textarea data-act="reply" placeholder="their reply code"></textarea>
                   <button data-act="accept">Connect them</button>
                 </details>`
              : `<p class="lobby-hint">
                   One invite per player. Send the link, take the reply, repeat.
                 </p>
                 <button class="wide primary" data-act="invite" ${this.host?.full ? 'disabled' : ''}>Make an invite</button>`
          }
        </div>
      </div>`;
  }

  /**
   * The room code, when there is a broker to hold one.
   *
   * Shown as the first thing on the hosting screen and as large as the panel
   * allows, because it is going to be read out loud across a room or typed off
   * a phone screen. The invite-code path stays underneath it: it is what works
   * when there is no broker, and it is the only thing that works on a LAN with
   * no internet.
   */
  private roomPanel(): string {
    if (!this.broker || !this.roomCode) return '';
    return `
      <h3>Room code</h3>
      <p class="lobby-code">${formatRoomCode(this.roomCode)}</p>
      <p class="lobby-hint">Read it out, or send the link. They type it in and they are on the grid.</p>
      <button class="wide primary" data-act="send-room">Send a join link</button>`;
  }

  /** A link that opens the game with the room already entered. */
  private roomLink(code: string): string {
    const url = new URL(location.href);
    url.hash = '';
    url.searchParams.delete('join');
    url.searchParams.set('room', formatRoomCode(code));
    return url.toString();
  }

  private joinBody(): string {
    if (!this.guest && !this.reply) {
      // With a broker, the room code is the way in and the invite code is the
      // fallback, folded away. Without one there is only the fallback, and it
      // is not presented as a fallback — it is simply how the game works.
      const paste = `
        <h3>${this.broker ? 'Or paste an invite code' : 'Paste the invite'}</h3>
        <textarea data-act="invite-in" placeholder="the code the host sent you"></textarea>
        <button data-act="use-invite">Continue</button>`;
      if (!this.broker) return paste;
      return `
        <h3>Room code</h3>
        <p class="lobby-hint">Six characters, from whoever is hosting.</p>
        <input class="lobby-room" data-act="room-in" placeholder="K7F-M29"
               autocapitalize="characters" autocomplete="off" spellcheck="false"
               maxlength="8" value="${this.roomEntry}">
        <button class="wide primary" data-act="use-room" ${this.busy ? 'disabled' : ''}>Join</button>
        <details class="lobby-raw"><summary>No room code?</summary>${paste}</details>`;
    }
    if (!this.reply) {
      // Joined by room code: there is no reply for the player to send back,
      // which is the whole point of having done it that way.
      return `
        <div class="lobby-cols">
          <div>
            <h3>Your car</h3>
            ${this.liveryPicker()}
          </div>
          <div>
            <h3>Racing</h3>
            <p class="lobby-hint">${this.pickedName}</p>
            <h3>Grid</h3>
            ${this.playerList()}
            <button class="wide" data-act="ready">I'm ready</button>
          </div>
        </div>`;
    }
    return `
      <div class="lobby-cols">
        <div>
          <h3>Send this back</h3>
          <p class="lobby-hint">One tap, then wait — the host does the rest.</p>
          <button class="wide primary" data-act="send-reply">Send my reply</button>
          <details class="lobby-raw">
            <summary>or copy it by hand</summary>
            <textarea readonly data-act="code">${this.reply}</textarea>
          </details>
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
    on('use-room', () => {
      const box = pick('room-in') as HTMLInputElement | null;
      // Kept on the panel so a mistyped code survives the re-render and can be
      // corrected, rather than clearing itself and making the player start again.
      this.roomEntry = box?.value ?? '';
      if (this.roomEntry) void this.joinByRoom(this.roomEntry);
    });
    on('send-room', () => {
      if (this.roomCode) void this.handOver(this.roomLink(this.roomCode), 'Race me on RSC');
    });
    on('send-invite', () => {
      if (this.invite) void this.handOver(this.inviteLink(this.invite.code), 'Race me on RSC');
    });
    on('send-reply', () => {
      if (this.reply) void this.handOver(this.reply, 'My RSC reply code');
    });
    on('paste', () => void this.pasteReply());
    const roomBox = pick('room-in') as HTMLInputElement | null;
    if (roomBox) {
      // A single short field: pressing Enter is what everyone will do, and
      // making them find the button instead is the kind of friction this
      // whole feature exists to remove.
      roomBox.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        this.roomEntry = roomBox.value;
        if (this.roomEntry) void this.joinByRoom(this.roomEntry);
      });
    }
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
