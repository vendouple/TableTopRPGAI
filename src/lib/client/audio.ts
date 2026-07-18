"use client";

import type { AmbienceMood, EndingKind } from "@/lib/campaign/types";

/**
 * The table's bard: a singleton background-music engine shared by the host
 * screens (lobby → weaving → stage) so the score never hard-cuts between
 * views. Tracks live under public/music/BGM/<context>/ and the engine
 * crossfades whenever the DM's ambience mood asks for a different shelf.
 */

/** Per-ending outro shelves, e.g. "outro-victory" → BGM/outro-victory/<genre>/. */
export type OutroContext = `outro-${EndingKind}`;

export type BgmContext = "lobby" | "weaving" | AmbienceMood | OutroContext;

type MusicLibrary = {
  tracks: string[];
  byContext: Record<string, string[]>;
  sfx: string[];
};

/** Fallback shelves, most-specific first. "any" = loose files in BGM/. */
const CONTEXT_FALLBACKS: Record<string, string[]> = {
  lobby:   ["lobby", "main", "any"],
  weaving: ["weaving", "mystery", "lobby", "main", "any"],
  calm:    ["calm", "main", "wonder", "any"],
  wonder:  ["wonder", "calm", "main", "any"],
  tense:   ["tense", "mystery", "main", "any"],
  adrenaline: ["adrenaline", "battle", "tense", "main", "any"],
  battle:  ["battle", "adrenaline", "tense", "main", "any"],
  boss:    ["boss", "battle", "dread", "tense", "main", "any"],
  mystery: ["mystery", "tense", "main", "any"],
  dread:   ["dread", "somber", "mystery", "main", "any"],
  triumph: ["triumph", "calm", "main", "any"],
  somber:  ["somber", "dread", "calm", "main", "any"],
  // Generic outro (used when the ending kind is unknown).
  outro:   ["outro", "triumph", "somber", "main", "any"],
  // Per-ending outros. Each prefers its own shelf, then the generic outro,
  // then the nearest existing mood — so an unfilled outro-<state>/ folder
  // still lands on tonally-right music you already have (win→triumph,
  // loss→somber, unresolved→mystery/dread) instead of falling silent.
  "outro-victory":     ["outro-victory", "outro", "triumph", "wonder", "main", "any"],
  "outro-defeat":      ["outro-defeat", "outro", "somber", "dread", "main", "any"],
  "outro-bittersweet": ["outro-bittersweet", "outro", "somber", "calm", "triumph", "main", "any"],
  "outro-escape":      ["outro-escape", "outro", "adrenaline", "tense", "triumph", "main", "any"],
  "outro-draw":        ["outro-draw", "outro", "somber", "calm", "main", "any"],
  "outro-cliffhanger": ["outro-cliffhanger", "outro", "mystery", "dread", "tense", "main", "any"]
};

const BASE_VOLUME = 0.32;
const DUCK_VOLUME = 0.08;
const FADE_MS = 2600;
/**
 * Generated tracks do not loop natively, so the bard starts blending the next
 * track this many seconds before the current one runs out. With a shelf of
 * one track this crossfades the song into itself — not sample-perfect, but
 * the score never falls silent.
 */
const LOOP_CROSSFADE_S = 4.5;

type BgmState = {
  blocked: boolean;
  muted: boolean;
  context: BgmContext | null;
  /** Human-readable name of the track currently on the live deck (debug). */
  track: string | null;
  /** Resolved shelf key playing right now, e.g. "lobby-fantasy" (debug). */
  shelf: string | null;
  /** User music volume 0..1 (scales the base level, independent of ducking). */
  volume: number;
};

const MUSIC_VOLUME_KEY = "mythweaver-music-volume";

/** User music volume 0..1, restored from a previous session. */
let userVolume = 1;
if (typeof window !== "undefined") {
  const raw = window.localStorage.getItem(MUSIC_VOLUME_KEY);
  const parsed = raw == null ? NaN : parseFloat(raw);
  if (Number.isFinite(parsed)) userVolume = Math.min(1, Math.max(0, parsed));
}

const state: BgmState = {
  blocked: false,
  muted: false,
  context: null,
  track: null,
  shelf: null,
  volume: userVolume
};
const listeners = new Set<(s: BgmState) => void>();

let library: MusicLibrary | null = null;
let libraryPromise: Promise<MusicLibrary> | null = null;

let deckA: HTMLAudioElement | null = null;
let deckB: HTMLAudioElement | null = null;
let liveDeck: HTMLAudioElement | null = null;
let fadeTimer: ReturnType<typeof setInterval> | null = null;
let ducked = false;
let playlist: string[] = [];
let playlistIndex = 0;
let contextKeyPlaying = "";
/** Optional score flavor (e.g. "fantasy") — prefers `<mood>-<theme>` shelves. */
let theme: string | null = null;
/** True once the live deck has begun its end-of-track crossfade. */
let loopBlendArmed = false;

/* -- WebAudio tap: lets visual scenes (the Weaving loom) pulse with the score. */
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
const deckSources = new WeakMap<HTMLAudioElement, MediaElementAudioSourceNode>();

/**
 * Lazily wire both decks through a shared AnalyserNode. Returns null until
 * the decks exist (i.e. before any music has been requested). Safe to call
 * every frame — the graph is built once.
 */
export function bgmGetAnalyser(): AnalyserNode | null {
  if (typeof window === "undefined") return null;
  ensureDecks();
  try {
    if (!audioCtx) {
      const Ctor = window.AudioContext || (window as any).webkitAudioContext;
      if (!Ctor) return null;
      audioCtx = new Ctor();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      // Light smoothing only: beat/riff onset detection needs transients to
      // survive the tap. Consumers that want a lazy swell (musicLevel drives)
      // re-smooth on their own clock anyway.
      analyser.smoothingTimeConstant = 0.55;
      analyser.connect(audioCtx.destination);
    }
    for (const deck of [deckA, deckB]) {
      if (!deck || deckSources.has(deck)) continue;
      const source = audioCtx.createMediaElementSource(deck);
      source.connect(analyser!);
      deckSources.set(deck, source);
    }
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => undefined);
    return analyser;
  } catch {
    return analyser;
  }
}

function notify() {
  for (const listener of listeners) listener({ ...state });
}

export function subscribeBgm(listener: (s: BgmState) => void): () => void {
  listeners.add(listener);
  listener({ ...state });
  return () => listeners.delete(listener);
}

async function loadLibrary(): Promise<MusicLibrary> {
  if (library) return library;
  if (!libraryPromise) {
    libraryPromise = fetch("/api/music")
      .then((res) => res.json())
      .then((data) => {
        library = {
          tracks: Array.isArray(data.tracks) ? data.tracks : [],
          byContext: data.byContext && typeof data.byContext === "object" ? data.byContext : {},
          sfx: Array.isArray(data.sfx) ? data.sfx : []
        };
        return library;
      })
      .catch(() => {
        library = { tracks: [], byContext: {}, sfx: [] };
        return library;
      });
  }
  return libraryPromise;
}

/** Exposed so the SFX engine can reuse the same manifest fetch. */
export async function loadSfxManifest(): Promise<string[]> {
  const lib = await loadLibrary();
  return lib.sfx;
}

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Resolve which shelf of tracks a context should play from. At each fallback
 * mood we try the themed variant first (`calm-fantasy` — the subfolder
 * BGM/calm/fantasy/), then the neutral mood root (`calm`). If the themed
 * shelf is empty we fall through to the root rather than borrowing another
 * genre's music, so a half-stocked theme never bleeds (a modern campaign
 * won't suddenly play lutes because only the fantasy shelf has tracks).
 */
function resolveShelf(lib: MusicLibrary, context: BgmContext): { key: string; tracks: string[] } {
  const chain = CONTEXT_FALLBACKS[context] || ["main", "any"];
  for (const key of chain) {
    if (theme) {
      const themed = lib.byContext[`${key}-${theme}`];
      if (themed && themed.length) return { key: `${key}-${theme}`, tracks: themed };
    }
    const tracks = lib.byContext[key];
    if (tracks && tracks.length) return { key, tracks };
  }
  return { key: "all", tracks: lib.tracks };
}

/**
 * Bias shelf resolution toward a flavor of the current mood (e.g. "fantasy"
 * for D&D campaigns). Pass null to play from the plain mood shelves.
 */
export function bgmSetTheme(next: string | null) {
  const normalized = next ? next.toLowerCase().trim() : null;
  if (normalized === theme) return;
  theme = normalized;
  if (state.context) bgmSetContext(state.context);
}

function targetVolume() {
  if (state.muted) return 0;
  return (ducked ? DUCK_VOLUME : BASE_VOLUME) * userVolume;
}

/** Pretty name for a track URL — the filename, decoded, sans extension. */
function trackLabel(url: string): string {
  const base = url.split("/").pop() || url;
  try {
    return decodeURIComponent(base).replace(/\.[a-z0-9]+$/i, "");
  } catch {
    return base.replace(/\.[a-z0-9]+$/i, "");
  }
}

/** Set the user music volume (0..1). Persists and applies live. */
export function bgmSetVolume(next: number) {
  userVolume = Math.min(1, Math.max(0, next));
  state.volume = userVolume;
  if (typeof window !== "undefined") {
    window.localStorage.setItem(MUSIC_VOLUME_KEY, String(userVolume));
  }
  if (liveDeck && !fadeTimer) liveDeck.volume = targetVolume();
  notify();
}

export function bgmGetVolume() {
  return userVolume;
}

function ensureDecks() {
  if (deckA && deckB) return;
  deckA = new Audio();
  deckB = new Audio();
  for (const deck of [deckA, deckB]) {
    deck.volume = 0;
    deck.preload = "auto";
    // Blend into the next track shortly before this one runs dry so the
    // score loops without a hard gap. Very short stingers fall through to
    // the plain "ended" advance below.
    deck.addEventListener("timeupdate", () => {
      if (deck !== liveDeck || loopBlendArmed || deck.paused) return;
      const remaining = deck.duration - deck.currentTime;
      if (!Number.isFinite(remaining)) return;
      if (remaining <= LOOP_CROSSFADE_S && deck.duration > LOOP_CROSSFADE_S * 2) {
        loopBlendArmed = true;
        advanceTrack();
      }
    });
    deck.addEventListener("ended", () => {
      if (deck === liveDeck) advanceTrack();
    });
  }
}

function otherDeck(deck: HTMLAudioElement): HTMLAudioElement {
  return deck === deckA ? deckB! : deckA!;
}

function beginFade(incoming: HTMLAudioElement | null, outgoing: HTMLAudioElement | null) {
  if (fadeTimer) clearInterval(fadeTimer);
  const started = performance.now();
  const outStart = outgoing ? outgoing.volume : 0;
  fadeTimer = setInterval(() => {
    const progress = Math.min((performance.now() - started) / FADE_MS, 1);
    if (incoming) incoming.volume = Math.min(targetVolume(), targetVolume() * progress);
    if (outgoing && outgoing !== incoming) {
      outgoing.volume = Math.max(0, outStart * (1 - progress));
      if (progress >= 1) {
        outgoing.pause();
        outgoing.removeAttribute("src");
        outgoing.load();
      }
    }
    if (progress >= 1 && fadeTimer) {
      clearInterval(fadeTimer);
      fadeTimer = null;
    }
  }, 80);
}

function playUrl(url: string) {
  ensureDecks();
  const incoming = liveDeck ? otherDeck(liveDeck) : deckA!;
  const outgoing = liveDeck;
  loopBlendArmed = false;
  incoming.src = url;
  incoming.volume = 0;
  liveDeck = incoming;
  state.track = trackLabel(url);
  notify();
  const attempt = incoming.play();
  if (attempt) {
    attempt
      .then(() => {
        if (state.blocked) {
          state.blocked = false;
          notify();
        }
        beginFade(incoming, outgoing);
      })
      .catch(() => {
        state.blocked = true;
        notify();
      });
  }
}

function advanceTrack() {
  if (!playlist.length) return;
  playlistIndex = (playlistIndex + 1) % playlist.length;
  playUrl(playlist[playlistIndex]);
}

/**
 * Point the bard at a context. If the resolved shelf differs from what is
 * already playing, crossfade to a track from the new shelf; otherwise keep
 * the current song going.
 */
export function bgmSetContext(context: BgmContext) {
  state.context = context;
  notify();
  loadLibrary().then((lib) => {
    // A later call may have changed the desired context while we loaded.
    if (state.context !== context) return;
    const { key, tracks } = resolveShelf(lib, context);
    if (!tracks.length) return;
    state.shelf = key;
    notify();
    if (key === contextKeyPlaying && liveDeck && !liveDeck.paused) return;
    contextKeyPlaying = key;
    playlist = shuffled(tracks);
    playlistIndex = 0;
    playUrl(playlist[0]);
  });
}

/** Duck under a cinematic (dice theater) and swell back after. */
export function bgmDuck(on: boolean) {
  ducked = on;
  if (liveDeck && !fadeTimer) liveDeck.volume = targetVolume();
}

export function bgmSetMuted(muted: boolean) {
  state.muted = muted;
  notify();
  if (liveDeck && !fadeTimer) liveDeck.volume = targetVolume();
  if (muted && fadeTimer) {
    clearInterval(fadeTimer);
    fadeTimer = null;
    if (liveDeck) liveDeck.volume = 0;
  }
}

export function bgmIsMuted() {
  return state.muted;
}

/** Retry playback after a user gesture (autoplay was blocked). */
export function bgmResume() {
  if (!liveDeck || !liveDeck.src) {
    if (state.context) bgmSetContext(state.context);
    return;
  }
  liveDeck
    .play()
    .then(() => {
      state.blocked = false;
      notify();
      if (liveDeck) liveDeck.volume = targetVolume();
    })
    .catch(() => undefined);
}

/** Full stop — called when the host experience unmounts. */
export function bgmStop() {
  if (fadeTimer) {
    clearInterval(fadeTimer);
    fadeTimer = null;
  }
  for (const deck of [deckA, deckB]) {
    if (!deck) continue;
    deck.pause();
    deck.removeAttribute("src");
    deck.load();
  }
  liveDeck = null;
  contextKeyPlaying = "";
  playlist = [];
  state.context = null;
  state.track = null;
  state.shelf = null;
  notify();
}
