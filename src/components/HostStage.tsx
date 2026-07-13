"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AmbienceMood,
  Campaign,
  CampaignEnding,
  DiceOutcome,
  DisplayEvent,
  EndingKind,
  EndingStat,
  Player,
  StageEffectKind,
  StoryCharacter
} from "@/lib/campaign/types";
import { api, accentColor } from "@/lib/client/api";
import { bgmDuck, bgmIsMuted, subscribeBgm } from "@/lib/client/audio";
import { playSfx, type SfxName } from "@/lib/client/sfx";
import { parseInline, plainText, renderInline, renderTokens } from "@/lib/client/markup";
import { ACCENT_THEMES, applyAccent, currentAccent, initAccent } from "@/lib/client/theme";
import StageAtmosphere, { AtmosphereHandle } from "@/components/three/StageAtmosphere";
import DiceTheater, { DiceRollData } from "@/components/three/DiceTheater";
import CosmosCanvas from "@/components/three/CosmosCanvas";
import WeavingLoom from "@/components/three/WeavingLoom";
import OutroTheater from "@/components/three/OutroTheater";
import { themeVisual, ThemeKey } from "@/components/three/themeVisuals";

const MOOD_GRADES: Record<string, string> = {
  calm: "linear-gradient(180deg, rgba(30,24,10,0.12), rgba(5,7,13,0.55))",
  tense: "linear-gradient(180deg, rgba(10,20,28,0.3), rgba(4,6,10,0.68))",
  adrenaline: "linear-gradient(180deg, rgba(40,36,8,0.22), rgba(6,10,8,0.56))",
  battle: "linear-gradient(180deg, rgba(48,10,4,0.3), rgba(10,3,2,0.62))",
  boss: "linear-gradient(180deg, rgba(34,6,26,0.42), rgba(6,2,8,0.74))",
  mystery: "linear-gradient(180deg, rgba(22,12,48,0.32), rgba(6,4,16,0.66))",
  dread: "linear-gradient(180deg, rgba(6,8,12,0.5), rgba(2,3,5,0.8))",
  triumph: "linear-gradient(180deg, rgba(48,34,6,0.18), rgba(8,6,2,0.5))",
  wonder: "linear-gradient(180deg, rgba(6,34,38,0.26), rgba(3,8,12,0.58))",
  somber: "linear-gradient(180deg, rgba(14,18,28,0.4), rgba(4,6,10,0.72))",
  outro: "linear-gradient(180deg, rgba(48,36,12,0.28), rgba(8,6,4,0.7))"
};

const DEBUG_THEMES: ThemeKey[] = ["none", "fantasy", "scifi", "horror", "noir", "modern", "western", "postapoc"];
const DEBUG_MOODS: AmbienceMood[] = ["calm", "tense", "adrenaline", "battle", "boss", "mystery", "dread", "triumph", "wonder", "somber", "outro"];
const DEBUG_EFFECTS: StageEffectKind[] = ["shake", "flash", "embers", "fog", "rain", "snow", "darkness", "heartbeat"];
const DEBUG_OUTCOMES: DiceOutcome[] = [
  "critical-success",
  "strong-success",
  "success",
  "partial-success",
  "failure",
  "hard-failure",
  "critical-failure"
];
const DEBUG_ENDINGS: EndingKind[] = ["victory", "defeat", "bittersweet", "escape", "draw", "cliffhanger"];
const DEBUG_SFX: SfxName[] = ["tap", "confirm", "send", "join", "beat", "flash", "rumble", "darkness", "heartbeat"];
const DEBUG_BEATS = ["narration", "dialogue", "playerAction", "system"] as const;
type DebugScene = "cosmos" | "loom";

/** Sample endings so every finale can be inspected without playing a saga to its close. */
const DEBUG_ENDING_SAMPLES: Record<EndingKind, Pick<CampaignEnding, "title" | "summary" | "highlights" | "stats">> = {
  victory: {
    title: "The Weaver's Crown",
    summary: "Against every prophecy, the party stood at the world's hinge and pushed. The dark tide broke, and dawn kept its appointment.",
    highlights: ["The final roll was a natural 20", "The Adversary knelt at last", "The realm remembers its saviors"],
    stats: [
      { label: "Battles Won", value: "12" },
      { label: "Natural 20s", value: "4" },
      { label: "Allies Made", value: "7" },
      { label: "Gold Squandered", value: "All of it" }
    ]
  },
  defeat: {
    title: "The Long Dark",
    summary: "The party gave everything, and it was not enough. The last torch guttered out in the deep, and the world above learned to whisper their names.",
    highlights: ["They fought to the final breath", "The Adversary's laughter still echoes", "Their story became a warning"],
    stats: [
      { label: "Last Stand", value: "4 rounds" },
      { label: "Wounds Taken", value: "Countless" },
      { label: "Regrets", value: "One" }
    ]
  },
  bittersweet: {
    title: "The Price of Dawn",
    summary: "The city was saved, but not everyone walked out of the fire to see it. Victory tastes of ash and morning rain.",
    highlights: ["The ritual was broken — at a cost", "A hero stayed behind", "The survivors carry the flame"],
    stats: [
      { label: "Lives Saved", value: "3,000" },
      { label: "Lives Given", value: "1" },
      { label: "Promises Kept", value: "Most" }
    ]
  },
  escape: {
    title: "Ashes at Our Heels",
    summary: "There was no winning that night — only the door, the dark, and the running. The party lives, and the thing in the deep knows their scent.",
    highlights: ["The bridge fell seconds behind them", "They left the gold, kept their lives", "Something followed them out"],
    stats: [
      { label: "Distance Fled", value: "40 leagues" },
      { label: "Look-Backs", value: "Too many" },
      { label: "Survivors", value: "All" }
    ]
  },
  draw: {
    title: "The Unbroken Scale",
    summary: "Neither banner fell. When the smoke cleared, both armies stood staring across a field that belonged to no one — and both chose to walk away.",
    highlights: ["The duel ended blade-to-blade", "A truce neither side wanted", "The ledger closed at zero"],
    stats: [
      { label: "Ground Gained", value: "None" },
      { label: "Ground Lost", value: "None" },
      { label: "Pride Swallowed", value: "Both sides" }
    ]
  },
  cliffhanger: {
    title: "The Door Was Already Open",
    summary: "The vault stood empty. The seal was broken from the inside. And from somewhere far below, slow and patient, came the sound of applause.",
    highlights: ["The true villain has no name yet", "One party member knows more than they said", "The map burns at the edges"],
    stats: [
      { label: "Questions Answered", value: "3" },
      { label: "Questions Raised", value: "9" },
      { label: "To Be Continued", value: "Yes" }
    ]
  }
};

type Beat = DisplayEvent;

/**
 * How long a fully-revealed beat stays on screen. Paced by *words* at a
 * comfortable couch reading speed (~170 wpm ≈ 350ms/word) rather than a
 * tight character cap, so long paragraphs no longer vanish mid-read.
 */
function beatHold(plain: string) {
  const words = plain.split(/\s+/).filter(Boolean).length;
  return Math.max(3200, Math.min(2400 + words * 350, 32000));
}

/*
 * The couch TV performs one bite-sized subtitle at a time. When the DM hands
 * us an over-long paragraph, we fan it out into several sequential beats (on
 * sentence, then word, boundaries) so it reads as a run of subtitles instead
 * of forcing an unusable scrollbar onto the television. Emphasis spans are
 * never cut mid-span — we only break where * and ` runs are balanced.
 */
const BEAT_SPLIT_TARGET = 240; // aim for chunks around this many chars
const BEAT_SPLIT_MAX = 340; // never let a single TV beat exceed this

function marksBalanced(text: string) {
  return (text.match(/\*/g) || []).length % 2 === 0 && (text.match(/`/g) || []).length % 2 === 0;
}

function hardWrapByWords(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let buf = "";
  for (const word of words) {
    const candidate = buf ? `${buf} ${word}` : word;
    if (candidate.length > BEAT_SPLIT_MAX && buf && marksBalanced(buf)) {
      out.push(buf);
      buf = word;
    } else {
      buf = candidate;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function splitLongContent(content: string): string[] {
  const text = content.trim();
  if (text.length <= BEAT_SPLIT_MAX) return [text];
  // Sentence-ish pieces, keeping terminal punctuation; hard-wrap any monster
  // sentence that is itself longer than the max.
  const pieces = text
    .split(/(?<=[.!?…])\s+(?=["'*(\[]?[A-Z0-9])/)
    .flatMap((piece) => (piece.length > BEAT_SPLIT_MAX ? hardWrapByWords(piece) : [piece]));
  const chunks: string[] = [];
  let buf = "";
  for (const piece of pieces) {
    const candidate = buf ? `${buf} ${piece}` : piece;
    if (candidate.length >= BEAT_SPLIT_TARGET && marksBalanced(candidate)) {
      chunks.push(candidate);
      buf = "";
    } else {
      buf = candidate;
    }
  }
  if (buf.trim()) {
    if (chunks.length && !marksBalanced(buf)) {
      chunks[chunks.length - 1] = `${chunks[chunks.length - 1]} ${buf}`;
    } else {
      chunks.push(buf);
    }
  }
  return chunks.length ? chunks : [text];
}

/**
 * Expand one display event into the beats the chronicle will actually play:
 * long narration/dialogue/action beats fan out into several subtitle-sized
 * beats (each with a stable derived id); everything else passes through.
 */
function expandBeat(event: Beat): Beat[] {
  const splittable = event.type === "narration" || event.type === "dialogue" || event.type === "playerAction";
  const content = event.content || "";
  if (!splittable || content.length <= BEAT_SPLIT_MAX) return [event];
  const parts = splitLongContent(content);
  if (parts.length <= 1) return [event];
  return parts.map((part, index) => ({ ...event, id: `${event.id}#${index}`, content: part }));
}

/**
 * The living stage: painted scene, mood atmosphere, letterboxed chronicle
 * that performs story beats one at a time, hero rails, dice cinematics, and
 * a hidden director's drawer for the human host.
 */
export default function HostStage({
  campaign,
  onExit,
  theme,
  debugMode = false
}: {
  campaign: Campaign;
  onExit: () => void;
  theme?: ThemeKey | string | null;
  debugMode?: boolean;
}) {
  const [debugOpen, setDebugOpen] = useState(debugMode);
  const [debugTheme, setDebugTheme] = useState<ThemeKey | null>(null);
  const [debugMood, setDebugMood] = useState<AmbienceMood | null>(null);
  const [debugOutro, setDebugOutro] = useState<EndingKind | null>(null);
  const [debugScene, setDebugScene] = useState<DebugScene | null>(null);
  const [debugSigil, setDebugSigil] = useState(false);
  const [loomProgress, setLoomProgress] = useState(0.15);
  const visual = themeVisual(debugTheme || theme);

  // The debug loom preview weaves itself over and over so the whole
  // progress animation can be inspected, not just one frozen frame.
  useEffect(() => {
    if (debugScene !== "loom") return;
    setLoomProgress(0.05);
    const timer = setInterval(() => setLoomProgress((progress) => (progress >= 1 ? 0.05 : progress + 0.012)), 120);
    return () => clearInterval(timer);
  }, [debugScene]);
  /* ------------------------------------------------------------------ */
  /* Backdrop crossfade                                                  */
  /* ------------------------------------------------------------------ */
  const [layers, setLayers] = useState<Array<{ url: string; key: number }>>(() =>
    campaign.currentImageUrl ? [{ url: campaign.currentImageUrl, key: 0 }] : []
  );
  useEffect(() => {
    const url = campaign.currentImageUrl;
    if (!url) return;
    setLayers((prev) => {
      if (prev.length && prev[prev.length - 1].url === url) return prev;
      const next = [...prev, { url, key: (prev[prev.length - 1]?.key ?? 0) + 1 }];
      return next.slice(-2);
    });
  }, [campaign.currentImageUrl]);

  /* ------------------------------------------------------------------ */
  /* Chronicle playback                                                  */
  /* ------------------------------------------------------------------ */
  const seenRef = useRef<Set<string> | null>(null);
  const queueRef = useRef<Beat[]>([]);
  const [currentBeat, setCurrentBeat] = useState<Beat | null>(null);
  const [shownChars, setShownChars] = useState(0);
  const [holdMs, setHoldMs] = useState(0);
  const [activeDice, setActiveDice] = useState<DiceRollData | null>(null);
  const [tomeOpen, setTomeOpen] = useState(false);
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pump, setPump] = useState(0);

  // Parse the beat's inline markdown once; the typewriter walks visible
  // characters only, so *marks* never flash on screen mid-reveal.
  const beatTokens = useMemo(() => parseInline(currentBeat?.content || ""), [currentBeat]);
  const beatPlain = useMemo(() => plainText(beatTokens), [beatTokens]);

  // Ingest new display events into the playback queue (never replay history).
  useEffect(() => {
    if (!seenRef.current) {
      seenRef.current = new Set(campaign.displayEvents.map((event) => event.id));
      const recap = [...campaign.displayEvents].reverse().find(
        (event) => event.type === "narration" || event.type === "dialogue"
      );
      if (recap) {
        setCurrentBeat(recap);
        setShownChars(plainText(parseInline(recap.content || "")).length);
      }
      return;
    }
    const seen = seenRef.current;
    let added = false;
    for (const event of campaign.displayEvents) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      for (const beat of expandBeat(event)) queueRef.current.push(beat);
      added = true;
    }
    if (added) setPump((n) => n + 1);
  }, [campaign.displayEvents]);

  const playersById = useMemo(() => {
    const map = new Map<string, Player>();
    for (const player of campaign.players) map.set(player.id, player);
    return map;
  }, [campaign.players]);

  const advance = useCallback(() => {
    if (advanceTimer.current) {
      clearTimeout(advanceTimer.current);
      advanceTimer.current = null;
    }
    setCurrentBeat(null);
    setHoldMs(0);
    setPump((n) => n + 1);
  }, []);

  // Take the next beat when idle.
  useEffect(() => {
    if (currentBeat || activeDice) return;
    const next = queueRef.current.shift();
    if (!next) return;
    if (next.type === "dice" && next.dice) {
      const roller = next.playerId ? playersById.get(next.playerId) : undefined;
      setActiveDice({
        id: next.id,
        notation: next.dice.notation,
        reason: next.dice.reason || next.content || "Fate decides",
        rolls: next.dice.rolls,
        modifier: next.dice.modifier,
        total: next.dice.total,
        d20Mode: next.dice.d20Mode,
        dc: next.dice.dc,
        outcome: next.dice.outcome,
        speaker: next.speaker !== "Dice" ? next.speaker : undefined,
        isNpc: next.dice.isNpc,
        color: roller ? accentColor(roller.color) : (next.dice.isNpc ? "#c48a8a" : undefined)
      });
      return;
    }
    setCurrentBeat(next);
    setShownChars(0);
    setHoldMs(0);
    playSfx("beat");
  }, [pump, currentBeat, activeDice, playersById]);

  // Typewriter + auto-advance (paced over visible characters only).
  useEffect(() => {
    if (!currentBeat) return;
    if (shownChars >= beatPlain.length) {
      const hold = beatHold(beatPlain);
      setHoldMs(hold);
      advanceTimer.current = setTimeout(advance, hold);
      return () => {
        if (advanceTimer.current) clearTimeout(advanceTimer.current);
      };
    }
    const step = beatPlain.length > 420 ? 4 : 2;
    const timer = setTimeout(() => setShownChars((n) => Math.min(n + step, beatPlain.length)), 24);
    return () => clearTimeout(timer);
  }, [currentBeat, beatPlain, shownChars, advance]);

  // Space / click skips typing, then skips the hold.
  const skip = useCallback(() => {
    if (!currentBeat) return;
    if (shownChars < beatPlain.length) {
      setShownChars(beatPlain.length);
    } else {
      advance();
    }
  }, [currentBeat, beatPlain, shownChars, advance]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = (target.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea" || target.isContentEditable) return;
      }
      if (event.code === "Space") {
        event.preventDefault();
        skip();
      }
      if (event.key === "d" || event.key === "D") setDrawerOpen((open) => !open);
      if (event.key === "t" || event.key === "T") setTomeOpen((open) => !open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [skip]);

  /* ------------------------------------------------------------------ */
  /* Ambience + stage effects                                            */
  /* ------------------------------------------------------------------ */
  const atmosphereRef = useRef<AtmosphereHandle>(null);
  const fxSeenRef = useRef<Set<string> | null>(null);
  const [shakeKey, setShakeKey] = useState(0);
  const [shaking, setShaking] = useState(false);
  const [flashKey, setFlashKey] = useState(0);

  useEffect(() => {
    if (!shakeKey) return;
    setShaking(true);
    const timer = setTimeout(() => setShaking(false), 800);
    return () => clearTimeout(timer);
  }, [shakeKey]);
  const [darkUntil, setDarkUntil] = useState(0);
  const [pulseUntil, setPulseUntil] = useState(0);

  useEffect(() => {
    const effects = campaign.effects || [];
    if (!fxSeenRef.current) {
      fxSeenRef.current = new Set(effects.map((fx) => fx.id));
      return;
    }
    const seen = fxSeenRef.current;
    for (const fx of effects) {
      if (seen.has(fx.id)) continue;
      seen.add(fx.id);
      const times = Math.max(1, Math.min(8, Number(fx.repeat) || 1));
      const gap = Math.max(0, Math.min(5000, Number(fx.delayMs) || 0));
      const fire = () => {
        switch (fx.kind) {
          case "shake": setShakeKey((k) => k + 1); playSfx("rumble", fx.strength); break;
          case "flash": setFlashKey((k) => k + 1); playSfx("flash", fx.strength); break;
          case "darkness": setDarkUntil(Date.now() + 4500); playSfx("darkness"); break;
          case "heartbeat": setPulseUntil(Date.now() + 5200); playSfx("heartbeat"); break;
          default: atmosphereRef.current?.burst(fx.kind, fx.strength);
        }
      };
      for (let i = 0; i < times; i += 1) {
        if (i === 0 || gap === 0) fire();
        else setTimeout(fire, gap * i);
      }
    }
  }, [campaign.effects]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (darkUntil <= now && pulseUntil <= now) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [darkUntil, pulseUntil, now]);

  const mood = debugMood || campaign.ambience?.mood || "calm";
  const intensity = campaign.ambience?.intensity ?? 0.5;

  /* ------------------------------------------------------------------ */
  /* Music — the shared bard (HostExperience picks the score by mood);   */
  /* here we only duck under dice, mute, and unblock autoplay.           */
  /* ------------------------------------------------------------------ */
  // Muting is owned by the floating MusicWidget now; we only mirror the shared
  // bard state so the dice cinematic can silence its own foley when muted.
  const [muted, setMuted] = useState(() => bgmIsMuted());

  useEffect(() => subscribeBgm(({ muted: isMuted }) => setMuted(isMuted)), []);

  useEffect(() => {
    bgmDuck(!!activeDice);
  }, [activeDice]);

  /* ------------------------------------------------------------------ */
  /* Director drawer                                                     */
  /* ------------------------------------------------------------------ */
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [accent, setAccent] = useState("gold");
  useEffect(() => {
    setAccent(initAccent() || currentAccent());
  }, []);
  const [sway, setSway] = useState("");
  const [swayBusy, setSwayBusy] = useState(false);
  const [paintPrompt, setPaintPrompt] = useState("");
  const [paintBusy, setPaintBusy] = useState(false);

  const sendSway = async () => {
    if (!sway.trim()) return;
    setSwayBusy(true);
    try {
      await api.party({ campaignId: campaign.id, action: "sway", guidance: sway.trim() });
      setSway("");
    } catch {
      // The drawer shows dmStatus; a failed sway simply leaves the text in place.
    } finally {
      setSwayBusy(false);
    }
  };

  const paintScene = async () => {
    if (!paintPrompt.trim()) return;
    setPaintBusy(true);
    try {
      await api.generateSceneImage(campaign.id, paintPrompt.trim());
      setPaintPrompt("");
    } catch {
      // ignore; host can retry
    } finally {
      setPaintBusy(false);
    }
  };

  const [nudgeBusy, setNudgeBusy] = useState(false);
  const nudgeBackdrop = async () => {
    setNudgeBusy(true);
    try {
      // Ask the Weaver to repaint the backdrop to match the CURRENT scene
      // (a visual refresh — it does not advance the plot or touch choices).
      await api.party({ campaignId: campaign.id, action: "nudge" });
    } catch {
      // ignore; host can retry
    } finally {
      setNudgeBusy(false);
    }
  };

  const toggleSetting = (key: string, value: boolean) => {
    api.party({ campaignId: campaign.id, action: "updateSettings", [key]: value }).catch(() => undefined);
  };

  const previewEffect = (kind: StageEffectKind) => {
    switch (kind) {
      case "shake": setShakeKey((key) => key + 1); playSfx("rumble", 0.8); break;
      case "flash": setFlashKey((key) => key + 1); playSfx("flash", 0.8); break;
      case "darkness": setDarkUntil(Date.now() + 4500); playSfx("darkness"); break;
      case "heartbeat": setPulseUntil(Date.now() + 5200); playSfx("heartbeat"); break;
      default: atmosphereRef.current?.burst(kind, 0.85);
    }
  };

  const previewDice = (outcome: DiceOutcome, isNpc = false) => {
    const total = outcome === "critical-success" ? 20 : outcome === "critical-failure" ? 1 : outcome.includes("failure") ? 8 : 18;
    setActiveDice({
      id: `debug-${outcome}-${Date.now()}`,
      notation: "1d20+3",
      reason: `Debug preview: ${outcome.replaceAll("-", " ")}`,
      rolls: [Math.max(1, total - 3)],
      modifier: 3,
      total,
      d20Mode: "normal",
      dc: 15,
      outcome,
      speaker: isNpc ? "The Adversary" : "UI Preview Hero",
      isNpc,
      color: isNpc ? "#c48a8a" : visual.accentBright
    });
  };

  /** Queue a sample story beat so the chronicle typewriter can be tested live. */
  const previewBeat = (type: (typeof DEBUG_BEATS)[number]) => {
    const hero = campaign.players[0];
    const heroName = hero?.characterName || hero?.name || "The Hero";
    const npcName = campaign.storyCharacters[0]?.name || "The Adversary";
    const samples: Record<(typeof DEBUG_BEATS)[number], Beat> = {
      narration: {
        id: `debug-beat-${Date.now()}`,
        type: "narration",
        speaker: "NARRATOR",
        content: "The lanterns gutter as something *vast* shifts beneath the floorboards — and every eye at the table turns toward the **sealed door**.",
        createdAt: new Date().toISOString()
      },
      dialogue: {
        id: `debug-beat-${Date.now()}`,
        type: "dialogue",
        speaker: npcName,
        content: "\"You were never meant to find this place,\" the voice purrs. \"*Stay.* We have so much to discuss.\"",
        createdAt: new Date().toISOString()
      },
      playerAction: {
        id: `debug-beat-${Date.now()}`,
        type: "playerAction",
        speaker: heroName,
        playerId: hero?.id,
        content: `${heroName} draws steel in one fluid motion and steps between the party and the dark.`,
        itemUsed: "Star-forged blade",
        createdAt: new Date().toISOString()
      },
      system: {
        id: `debug-beat-${Date.now()}`,
        type: "system",
        speaker: "SYSTEM",
        content: "Debug preview: a system beat crosses the chronicle.",
        createdAt: new Date().toISOString()
      }
    };
    queueRef.current.push(samples[type]);
    setPump((n) => n + 1);
  };

  /** Paint a procedural gradient backdrop so the Ken Burns crossfade can be tested without an image API. */
  const previewBackdrop = () => {
    const canvas = document.createElement("canvas");
    canvas.width = 960;
    canvas.height = 540;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const hue = Math.floor(Math.random() * 360);
    const base = ctx.createLinearGradient(0, 0, 960, 540);
    base.addColorStop(0, `hsl(${hue}, 42%, 16%)`);
    base.addColorStop(1, `hsl(${(hue + 90) % 360}, 55%, 7%)`);
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, 960, 540);
    for (let i = 0; i < 6; i += 1) {
      const x = Math.random() * 960;
      const y = Math.random() * 540;
      const radius = 80 + Math.random() * 220;
      const glow = ctx.createRadialGradient(x, y, 0, x, y, radius);
      glow.addColorStop(0, `hsla(${(hue + i * 40) % 360}, 70%, 55%, 0.22)`);
      glow.addColorStop(1, "hsla(0, 0%, 0%, 0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, 960, 540);
    }
    const url = canvas.toDataURL("image/jpeg", 0.85);
    setLayers((prev) => [...prev, { url, key: (prev[prev.length - 1]?.key ?? 0) + 1 }].slice(-2));
  };

  const closeDebug = () => {
    setDebugOpen(false);
    setDebugTheme(null);
    setDebugMood(null);
    setDebugOutro(null);
    setDebugScene(null);
    setDebugSigil(false);
  };

  /* ------------------------------------------------------------------ */
  /* Derived                                                             */
  /* ------------------------------------------------------------------ */
  const npcsOnStage = useMemo(
    () =>
      campaign.storyCharacters
        // Show a foe the moment it appears — a portrait OR any tracked stat
        // (HP) is enough; enemies shouldn't be invisible until art is painted.
        .filter((npc) => (npc.portraitUrl || (npc.stats && npc.stats.length > 0)) && npc.status !== "Future NPC")
        .slice(-4),
    [campaign.storyCharacters]
  );

  const questLine = useMemo(() => {
    if (!campaign.showQuestOnTV || !campaign.questLog) return null;
    const line = campaign.questLog
      .split(/\r?\n/)
      .map((entry) =>
        entry
          .replace(/^#+\s*/, "")
          .replace(/^[-*]\s*/, "")
          .replace(/\*\*|\*|__|`/g, "")
          .trim()
      )
      .filter(Boolean);
    return line.slice(0, 2).join(" · ") || null;
  }, [campaign.showQuestOnTV, campaign.questLog]);

  const playerBySpeaker = (beat: Beat): Player | undefined => {
    if (beat.playerId) return playersById.get(beat.playerId);
    if (!beat.speaker) return undefined;
    const lower = beat.speaker.toLowerCase();
    return campaign.players.find((p) => (p.characterName || p.name).toLowerCase() === lower);
  };

  const speakerColor = (beat: Beat): string | undefined => {
    const player = playerBySpeaker(beat);
    if (player?.color) return accentColor(player.color);
    const npc = campaign.storyCharacters.find((item) => item.name === beat.speaker);
    if (npc?.color) return accentColor(npc.color);
    return undefined;
  };

  const speakerPortrait = (beat: Beat): string | undefined => {
    const player = playerBySpeaker(beat);
    if (player?.portraitUrl) return player.portraitUrl;
    return campaign.storyCharacters.find((item) => item.name === beat.speaker)?.portraitUrl;
  };

  const isNarrator = (beat: Beat) =>
    !beat.speaker || beat.speaker.toUpperCase() === "NARRATOR" || beat.type === "system" || beat.type === "scene";

  const dark = darkUntil > now;
  const pulsing = pulseUntil > now;

  // Fallback stats board tallied from the chronicle itself, used whenever the
  // AI didn't hand end_campaign an explicit stats array (and for debug outros).
  const derivedStats = useMemo<EndingStat[]>(() => {
    const diceEvents = campaign.displayEvents.filter((event) => event.type === "dice" && event.dice);
    const beats = campaign.displayEvents.filter((event) => event.type === "narration" || event.type === "dialogue").length;
    const nat20s = diceEvents.filter((event) => event.dice!.outcome === "critical-success").length;
    const nat1s = diceEvents.filter((event) => event.dice!.outcome === "critical-failure").length;
    const stats: EndingStat[] = [];
    if (beats) stats.push({ label: "Story Beats", value: String(beats) });
    if (diceEvents.length) stats.push({ label: "Fates Tempted", value: String(diceEvents.length) });
    if (nat20s) stats.push({ label: "Natural 20s", value: String(nat20s) });
    if (nat1s) stats.push({ label: "Natural 1s", value: String(nat1s) });
    if (campaign.images.length) stats.push({ label: "Scenes Painted", value: String(campaign.images.length) });
    stats.push({ label: "Heroes", value: String(campaign.players.length) });
    return stats.slice(0, 6);
  }, [campaign.displayEvents, campaign.images.length, campaign.players.length]);

  // The outro plays for a truly completed saga, or for any finale picked in
  // the debug gallery (which never touches the stored campaign).
  const activeEnding = useMemo<CampaignEnding | null>(() => {
    if (debugOutro) {
      return {
        kind: debugOutro,
        ...DEBUG_ENDING_SAMPLES[debugOutro],
        endedAt: new Date().toISOString()
      };
    }
    if (campaign.status !== "completed" || !campaign.ending) return null;
    return campaign.ending.stats?.length ? campaign.ending : { ...campaign.ending, stats: derivedStats };
  }, [debugOutro, campaign.status, campaign.ending, derivedStats]);

  return (
    <div
      className={`stage screen ${shaking ? "stage-shake" : ""} ${pulsing ? "stage-pulse" : ""} ${campaign.status === "completed" ? "stage-completed" : ""}`}
      data-music-theme={visual.key}
      onClick={skip}
    >
      {/* Painted backdrop with Ken Burns crossfade */}
      <div className="stage-backdrop">
        {layers.map((layer, index) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={layer.key}
            src={layer.url}
            alt=""
            className={`backdrop-layer ${index === layers.length - 1 ? "front" : "back"} kenburns-${layer.key % 2}`}
          />
        ))}
        <div className="stage-grade" style={{ background: MOOD_GRADES[mood] || MOOD_GRADES.calm }} />
      </div>

      <StageAtmosphere ref={atmosphereRef} mood={mood} intensity={intensity} theme={visual.key} />

      <div className="stage-grain" aria-hidden />
      <div className={`stage-darkness ${dark ? "on" : ""}`} aria-hidden />
      {flashKey ? <div key={`flash-${flashKey}`} className="stage-flash" aria-hidden /> : null}
      <div className="stage-vignette" aria-hidden />

      {/* Top chrome */}
      <header className="stage-mast">
        <div className="stage-title-block">
          <span className="stage-title">{campaign.title}</span>
          {questLine ? <span className="stage-quest">⟡ {questLine}</span> : null}
        </div>
        {campaign.turnState?.mode === "combat" ? (
          <span className="stage-combat-badge">
            ⚔ Combat{campaign.turnState.round ? ` · Round ${campaign.turnState.round}` : ""}
            {campaign.turnState.activeId === "enemies" ? " · Enemies act" : ""}
          </span>
        ) : null}
        {campaign.ambience?.note ? <span className="stage-ambience-note">{campaign.ambience.note}</span> : null}
      </header>

      {/* Hero rail (players, left) */}
      <aside className="stage-rail left">
        {campaign.players.map((player) => {
          const color = accentColor(player.color);
          const hp = player.stats.find((stat) => stat.name.toUpperCase() === "HP");
          const speaking = currentBeat?.playerId === player.id;
          const activeTurn = campaign.turnState?.mode === "combat" && campaign.turnState?.activeId === player.id;
          const down = player.canAct === false;
          return (
            <div key={player.id} className={`rail-card ${speaking ? "speaking" : ""} ${activeTurn ? "active-turn" : ""} ${down ? "downed" : ""}`} style={{ borderColor: `${color}` }}>
              <div className="rail-portrait">
                {player.portraitUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={player.portraitUrl} alt={player.characterName || player.name} />
                ) : (
                  <span className="forge-circle small" aria-hidden />
                )}
              </div>
              <div className="rail-info">
                <span className="rail-name" style={{ color }}>
                  {activeTurn ? "▶ " : ""}{player.characterName || player.name}
                </span>
                {hp ? (
                  <span className="rail-hp">
                    <span className="rail-hp-fill" style={{ width: `${Math.max(0, Math.min(100, (hp.value / Math.max(hp.maxValue, 1)) * 100))}%` }} />
                    <span className="rail-hp-text">{hp.value}/{hp.maxValue}</span>
                  </span>
                ) : null}
                {player.status ? <span className="rail-status">{player.status}</span> : null}
              </div>
            </div>
          );
        })}
      </aside>

      {/* NPC rail (right) */}
      <aside className="stage-rail right">
        {npcsOnStage.map((npc: StoryCharacter) => {
          const color = accentColor(npc.color, "#9aa4c0");
          const speaking = currentBeat?.speaker === npc.name;
          const hp = (npc.stats || []).find((stat) => stat.name.toUpperCase() === "HP");
          const isGroup = npc.isGroup || (npc.count !== undefined && npc.count !== 1);
          const remaining = npc.count;
          return (
            <div key={npc.id} className={`rail-card npc ${speaking ? "speaking" : ""}`} style={{ borderColor: color }}>
              <div className="rail-portrait">
                {npc.portraitUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={npc.portraitUrl} alt={npc.name} />
                ) : (
                  <span className="forge-circle small" aria-hidden />
                )}
              </div>
              <div className="rail-info">
                <span className="rail-name" style={{ color }}>
                  {npc.name}{isGroup && remaining !== undefined ? ` ×${remaining}` : ""}
                </span>
                {hp ? (
                  <span className="rail-hp">
                    <span className="rail-hp-fill" style={{ width: `${Math.max(0, Math.min(100, (hp.value / Math.max(hp.maxValue, 1)) * 100))}%` }} />
                    <span className="rail-hp-text">{hp.value}/{hp.maxValue}</span>
                  </span>
                ) : null}
                {isGroup && remaining !== undefined ? (
                  <span className="rail-status">{remaining} left{npc.maxCount ? ` / ${npc.maxCount}` : ""}</span>
                ) : null}
                {npc.status ? <span className="rail-status">{npc.status}</span> : null}
              </div>
            </div>
          );
        })}
      </aside>

      {/* The Chronicle — one beat at a time */}
      <section className="chronicle">
        {currentBeat ? (
          <div className={`beat beat-${currentBeat.type} ${isNarrator(currentBeat) ? "beat-narrator" : "beat-voiced"}`}>
            {!isNarrator(currentBeat) ? (
              <div className="beat-plate">
                {speakerPortrait(currentBeat) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="beat-face" src={speakerPortrait(currentBeat)} alt="" />
                ) : null}
                <span className="beat-speaker" style={{ color: speakerColor(currentBeat) }}>
                  {currentBeat.speaker}
                </span>
                {currentBeat.type === "playerAction" ? <span className="beat-tag">acts</span> : null}
                {currentBeat.itemUsed ? <span className="beat-tag item">✦ {currentBeat.itemUsed}</span> : null}
                {currentBeat.abilityUsed ? <span className="beat-tag ability">✧ {currentBeat.abilityUsed}</span> : null}
              </div>
            ) : null}
            <p className={`beat-text ${currentBeat.type === "system" ? "system" : ""}`}>
              {renderTokens(beatTokens, shownChars)}
              {shownChars < beatPlain.length ? <span className="beat-caret" aria-hidden>❘</span> : null}
            </p>
            {holdMs > 0 && shownChars >= beatPlain.length ? (
              <span
                key={`hold-${currentBeat.id}`}
                className="beat-hold"
                style={{ animationDuration: `${holdMs}ms` }}
                aria-hidden
              />
            ) : null}
          </div>
        ) : campaign.dmStatus ? null : (
          <p className="chronicle-idle">{campaign.overview}</p>
        )}
        {queueRef.current.length > 0 && currentBeat ? (
          <span className="chronicle-more" aria-hidden>⌄ {queueRef.current.length} more</span>
        ) : null}
      </section>

      {/* Oracle sigil — the DM is weaving */}
      {campaign.dmStatus || debugSigil ? (
        <div className="oracle-sigil" role="status">
          <span className="sigil-ring" aria-hidden />
          <span className="sigil-text">{campaign.dmStatus || "The Weaver is weaving…"}</span>
        </div>
      ) : null}

      {/* The Grand Outro — a Three.js finale choreographed by the ending kind */}
      {activeEnding ? (
        <OutroTheater
          key={`${activeEnding.kind}-${visual.key}`}
          ending={activeEnding}
          players={campaign.players}
          campaignTitle={campaign.title}
          theme={visual.key}
          onExit={debugOutro ? undefined : onExit}
        />
      ) : null}

      {activeDice ? (
        <DiceTheater key={activeDice.id} roll={activeDice} muted={muted} onDone={() => setActiveDice(null)} />
      ) : null}

      {/* Utility chrome */}
      <div className="stage-tools" onClick={(event) => event.stopPropagation()}>
        <button className="tool-chip" onClick={() => setTomeOpen((open) => !open)}>Tome</button>
        <button className="tool-chip" onClick={() => setDrawerOpen((open) => !open)}>Director</button>
        {debugMode ? <button className={`tool-chip ${debugOpen ? "attention" : ""}`} onClick={() => setDebugOpen((open) => !open)}>Gallery</button> : null}
      </div>

      {/* Debug-only Three.js scene overlays (Cosmos backdrop / Weaving loom) */}
      {debugMode && debugScene ? (
        <div className="debug-scene-overlay" onClick={(event) => event.stopPropagation()}>
          {debugScene === "cosmos" ? (
            <CosmosCanvas accent={visual.accent} drama={0.85} theme={visual.key} />
          ) : (
            <WeavingLoom progress={loomProgress} accent={visual.accent} theme={visual.key} />
          )}
          <button className="ghost-button debug-scene-close" onClick={() => setDebugScene(null)}>
            ✕ Close {debugScene === "cosmos" ? "cosmos" : `loom (${Math.round(loomProgress * 100)}%)`}
          </button>
        </div>
      ) : null}

      {debugMode && debugOpen ? (
        <aside className="debug-menu panel" onClick={(event) => event.stopPropagation()}>
          <div className="tome-head">
            <h3 className="panel-subtitle">UI Debug Gallery</h3>
            <span className="debug-menu-actions">
              <button className="ghost-button" onClick={closeDebug}>Hide</button>
              <button className="ghost-button" onClick={onExit}>Title screen</button>
            </span>
          </div>

          <label className="director-label">Menus</label>
          <div className="debug-grid menus">
            <button className="chip-toggle tiny" onClick={() => setTomeOpen(true)}>Tome</button>
            <button className="chip-toggle tiny" onClick={() => setDrawerOpen(true)}>Director</button>
            <button className={`chip-toggle tiny ${debugSigil ? "selected" : ""}`} onClick={() => setDebugSigil((shown) => !shown)}>Oracle sigil</button>
          </div>

          <label className="director-label">Three.js scenes</label>
          <div className="debug-grid menus">
            <button className={`chip-toggle tiny ${debugScene === "cosmos" ? "selected" : ""}`} onClick={() => setDebugScene((scene) => (scene === "cosmos" ? null : "cosmos"))}>Cosmos</button>
            <button className={`chip-toggle tiny ${debugScene === "loom" ? "selected" : ""}`} onClick={() => setDebugScene((scene) => (scene === "loom" ? null : "loom"))}>Weaving Loom</button>
            <button className="chip-toggle tiny" onClick={() => previewDice("success")}>Dice Theater</button>
          </div>

          <label className="director-label">Outro finales (Three.js)</label>
          <div className="debug-grid">
            {DEBUG_ENDINGS.map((endingKind) => (
              <button
                key={endingKind}
                className={`chip-toggle tiny ${debugOutro === endingKind ? "selected" : ""}`}
                onClick={() => {
                  if (debugOutro === endingKind) {
                    setDebugOutro(null);
                  } else {
                    setDebugOutro(endingKind);
                    setDebugMood("outro");
                  }
                }}
              >
                {endingKind}
              </button>
            ))}
          </div>

          <label className="director-label">Themes</label>
          <div className="debug-grid">
            {DEBUG_THEMES.map((themeKey) => (
              <button key={themeKey} className={`chip-toggle tiny ${visual.key === themeKey ? "selected" : ""}`} onClick={() => setDebugTheme(themeKey)}>
                {themeKey}
              </button>
            ))}
          </div>

          <label className="director-label">Atmosphere moods</label>
          <div className="debug-grid">
            {DEBUG_MOODS.map((moodKey) => (
              <button key={moodKey} className={`chip-toggle tiny ${mood === moodKey ? "selected" : ""}`} onClick={() => setDebugMood(moodKey)}>
                {moodKey}
              </button>
            ))}
          </div>

          <label className="director-label">Stage effects</label>
          <div className="debug-grid">
            {DEBUG_EFFECTS.map((effect) => <button key={effect} className="chip-toggle tiny" onClick={() => previewEffect(effect)}>{effect}</button>)}
            <button className="chip-toggle tiny" onClick={() => previewBackdrop()}>backdrop fade</button>
          </div>

          <label className="director-label">Chronicle beats</label>
          <div className="debug-grid">
            {DEBUG_BEATS.map((beatType) => (
              <button key={beatType} className="chip-toggle tiny" onClick={() => previewBeat(beatType)}>
                {beatType === "playerAction" ? "player action" : beatType}
              </button>
            ))}
          </div>

          <label className="director-label">SFX cues</label>
          <div className="debug-grid">
            {DEBUG_SFX.map((cue) => <button key={cue} className="chip-toggle tiny" onClick={() => playSfx(cue)}>{cue}</button>)}
          </div>

          <label className="director-label">Dice outcomes</label>
          <div className="debug-grid">
            {DEBUG_OUTCOMES.map((outcome) => <button key={outcome} className="chip-toggle tiny" onClick={() => previewDice(outcome)}>{outcome.replaceAll("-", " ")}</button>)}
            <button className="chip-toggle tiny" onClick={() => previewDice("hard-failure", true)}>NPC roll</button>
          </div>
        </aside>
      ) : null}

      {/* The Tome — scrollback */}
      {tomeOpen ? (
        <aside className="tome panel" onClick={(event) => event.stopPropagation()}>
          <div className="tome-head">
            <h3 className="panel-subtitle">The Tome</h3>
            <button className="ghost-button" onClick={() => setTomeOpen(false)}>✕</button>
          </div>
          <div className="tome-scroll">
            {campaign.displayEvents.slice(-40).map((event) => (
              <div key={event.id} className={`tome-entry type-${event.type}`}>
                <span className="tome-speaker" style={{ color: speakerColor(event) }}>
                  {event.type === "dice" && event.dice
                    ? `⚄ ${event.speaker || "Dice"} — ${event.dice.total}`
                    : event.speaker || "—"}
                </span>
                <span className="tome-content">{event.content ? renderInline(event.content) : null}</span>
              </div>
            ))}
          </div>
        </aside>
      ) : null}

      {/* Director's drawer */}
      {drawerOpen ? (
        <aside className="director panel" onClick={(event) => event.stopPropagation()}>
          <div className="tome-head">
            <h3 className="panel-subtitle">Director&apos;s Drawer</h3>
            <button className="ghost-button" onClick={() => setDrawerOpen(false)}>✕</button>
          </div>

          <label className="director-label">Whisper to the Weaver</label>
          <textarea
            className="field textarea slim"
            rows={3}
            placeholder="Sway the story: “introduce a rival crew”, “raise the stakes”, “wrap this scene soon”…"
            value={sway}
            onChange={(event) => setSway(event.target.value)}
          />
          <button className="oracle-button" disabled={swayBusy || !sway.trim()} onClick={sendSway}>
            {swayBusy ? "Whispering…" : "✦ Whisper"}
          </button>

          <label className="director-label">Paint a new backdrop</label>
          <textarea
            className="field textarea slim"
            rows={2}
            placeholder="Describe the vista to paint…"
            value={paintPrompt}
            onChange={(event) => setPaintPrompt(event.target.value)}
          />
          <button className="oracle-button" disabled={paintBusy || !paintPrompt.trim()} onClick={paintScene}>
            {paintBusy ? "Painting…" : "🎨 Paint"}
          </button>

          <button className="ghost-button nudge" disabled={nudgeBusy} onClick={nudgeBackdrop}>
            {nudgeBusy ? "Nudging the Weaver…" : "✨ Nudge — repaint to match the scene"}
          </button>

          {campaign.images.length ? (
            <>
              <label className="director-label">Recall a painted scene</label>
              <div className="gallery">
                {campaign.images.slice(-8).map((image) => (
                  <button
                    key={image.id}
                    className={`gallery-thumb ${campaign.currentImageUrl === image.url ? "current" : ""}`}
                    title={image.prompt}
                    onClick={() => api.party({ campaignId: campaign.id, action: "setBackground", url: image.url }).catch(() => undefined)}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={image.url} alt={image.prompt.slice(0, 60)} />
                  </button>
                ))}
              </div>
            </>
          ) : null}

          <label className="director-label">Table colors</label>
          <div className="accent-row">
            {ACCENT_THEMES.map((themeOption) => (
              <button
                key={themeOption.key}
                className={`accent-swatch ${accent === themeOption.key ? "current" : ""}`}
                style={{ background: themeOption.swatch }}
                title={themeOption.label}
                aria-label={themeOption.label}
                onClick={() => { applyAccent(themeOption.key); setAccent(themeOption.key); }}
              />
            ))}
          </div>

          <label className="director-label">Table settings</label>
          <div className="director-toggles">
            {([
              ["showQuestOnTV", "Quest on the TV", campaign.showQuestOnTV],
              ["showQuestOnController", "Quest on phones", campaign.showQuestOnController],
              ["showPartyInventories", "Party sees inventories", campaign.showPartyInventories],
              ["showPartyAbilities", "Party sees abilities", campaign.showPartyAbilities]
            ] as Array<[string, string, boolean | undefined]>).map(([key, label, value]) => (
              <button key={key} className={`chip-toggle tiny ${value ? "selected" : ""}`} onClick={() => toggleSetting(key, !value)}>
                {label}
              </button>
            ))}
          </div>

          <button className="ghost-button leave" onClick={onExit}>Leave the table (keeps the saga)</button>
        </aside>
      ) : null}
    </div>
  );
}
