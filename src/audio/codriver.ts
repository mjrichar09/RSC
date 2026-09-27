/**
 * The co-driver's voice.
 *
 * Reads `game/pacenotes.ts` aloud through the browser's own speech synthesis:
 * no recordings to ship, every language the device has, and nothing to load.
 * Where the browser has no speech at all it simply stays quiet — the notes are
 * still on the HUD, which is where they always were.
 *
 * Calls are made in order and never twice. One that has fallen behind — a
 * queue of notes for corners the car has already driven through — is worse
 * than silence, so anything still waiting when the next becomes due is
 * dropped rather than read late.
 */

import { dueCall, type PaceCall } from '../game/pacenotes.js';

export class CoDriver {
  /** Off means silent, and costs nothing. Remembered with the profile. */
  enabled = true;
  /** 0..1, following the master volume and the mute. */
  volume = 1;

  private calls: readonly PaceCall[] = [];
  private next = 0;
  private voice: SpeechSynthesisVoice | null = null;
  private readonly speech: SpeechSynthesis | null =
    typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;

  constructor() {
    // Voices load asynchronously in Chrome, so ask again when they arrive.
    const pick = () => {
      const voices = this.speech?.getVoices() ?? [];
      // A British English voice if there is one — it is the rally accent —
      // then any English, then whatever the device speaks.
      this.voice =
        voices.find((v) => v.lang === 'en-GB') ??
        voices.find((v) => v.lang.startsWith('en')) ??
        voices[0] ??
        null;
    };
    pick();
    this.speech?.addEventListener?.('voiceschanged', pick);
  }

  /** A new stage, or the same one restarted: the notes from the top. */
  load(calls: readonly PaceCall[]): void {
    this.calls = calls;
    this.next = 0;
    this.silence();
  }

  /**
   * Called every frame of a running race. `furthest` is how far along the
   * stage the car has got and `speed` is in m/s.
   */
  update(furthest: number, speed: number): void {
    // Skip anything already behind the car: a restart from further on, or a
    // rescue that put the car past a corner.
    while (this.calls[this.next] && this.calls[this.next]!.at < furthest - 5) this.next++;
    const due = dueCall(this.calls, this.next, furthest, speed);
    if (due === null) return;
    this.next = due + 1;
    if (!this.enabled || this.volume <= 0) return;
    this.say(this.calls[due]!.text);
  }

  private say(text: string): void {
    const speech = this.speech;
    if (!speech) return;
    // Drop a stale call rather than stack this one behind it.
    if (speech.pending) speech.cancel();
    const line = new SpeechSynthesisUtterance(text);
    if (this.voice) line.voice = this.voice;
    line.rate = 1.3;
    line.pitch = 0.95;
    line.volume = this.volume;
    speech.speak(line);
  }

  /** Stop mid-sentence: a menu, a replay, the finish, a crash. */
  silence(): void {
    if (this.speech?.speaking || this.speech?.pending) this.speech.cancel();
  }
}
