import type { MusicTheme } from "@/lib/campaign/musicTheme";

/**
 * The visual identity of each campaign theme — one spec drives the lobby
 * cosmos, the Weaving loom, the stage atmosphere tint, and the UI copy, so
 * a "scifi" saga looks scifi from the first lobby frame to the last credits.
 * "none" is the neutral Astral Table used before a theme exists (portal,
 * create wizard, sealed envelopes).
 */
export type ThemeKey = MusicTheme | "none";

/**
 * Per-genre motion personality of the Weaving loom — how the unassembled
 * halo swirls and drifts (rising fantasy embers, noir rain, post-apoc ash),
 * how the glyph rings precess and sway, how the camera orbits, and whether
 * the light gutters (horror candles, wasteland reactors).
 */
export type LoomMotion = {
  /** Halo orbit speed multiplier (1 = stately). */
  swirl: number;
  /** Vertical drift of unassembled motes; positive rises, negative falls. */
  rise: number;
  /** Jitter amplitude of unassembled motes. */
  wobble: number;
  /** Glyph ring precession speed multiplier. */
  ringSpeed: number;
  /** Ring tilt sway amplitude (radians, small). */
  ringSway: number;
  /** Camera orbit speed. */
  orbit: number;
  /** 0..1 irregular light gutter. */
  flicker: number;
};

export type ThemeVisual = {
  key: ThemeKey;
  /** Primary glow — dust, dice edges, key light, glyph rings. */
  accent: string;
  accentBright: string;
  /** Counterpart color — rim light, loom threads, second nebula. */
  secondary: string;
  /** Scene fog / depth color. */
  fog: string;
  fogDensity: number;
  ambient: string;
  /** Star-dust behavior: color, size, and a constant wind (x, y per second). */
  dust: { color: string; size: number; flow: [number, number] };
  /** Three nebula glows, back of the scene. */
  nebulae: [string, string, string];
  /** Signature full-scene layer, one per theme. */
  effect: "aurora" | "warp" | "haunt" | "rain" | "bokeh" | "frontier" | "none";
  /** Drifting dice-moon materials. */
  dice: { body: string; roughness: number; metalness: number; opacity: number; edge: string; edgeOpacity: number };
  /** Glyph alphabet worn by the loom's great rings. */
  glyphs: string;
  glyphFont: string;
  /** Loom of Worlds palette and motion personality. */
  loom: { heart: string; world: string; wireBoost: number; motion: LoomMotion };
  copy: {
    kicker: string;
    join: string;
    reconnect: string;
    /** A hero's thread is woven out after a disconnect timeout. */
    depart: string;
    gathering: string;
    joinGathering: string;
  };
};

export const THEME_VISUALS: Record<ThemeKey, ThemeVisual> = {
  none: {
    key: "none",
    accent: "#c9a35c",
    accentBright: "#e6c378",
    secondary: "#7b6cff",
    fog: "#05070d",
    fogDensity: 0.055,
    ambient: "#2a3350",
    dust: { color: "#c9a35c", size: 0.045, flow: [0, 0] },
    nebulae: ["#7b6cff", "#c9a35c", "#4c8cb4"],
    effect: "none",
    dice: { body: "#0d1322", roughness: 0.35, metalness: 0.75, opacity: 1, edge: "#c9a35c", edgeOpacity: 0.5 },
    glyphs: "ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃᛇᛈᛉᛊᛏᛒᛖᛗᛚᛜᛞᛟ",
    glyphFont: "44px serif",
    loom: {
      heart: "230,195,120", world: "#0b1020", wireBoost: 1,
      motion: { swirl: 1, rise: 0, wobble: 1, ringSpeed: 1, ringSway: 0.02, orbit: 0.05, flicker: 0 }
    },
    copy: {
      kicker: "The Weaving begins",
      join: "A new hero is woven in",
      reconnect: "A lost thread returns to the loom",
      depart: "A thread slips loose from the loom",
      gathering: "The threads are gathering…",
      joinGathering: "The loom makes room for another…"
    }
  },
  fantasy: {
    key: "fantasy",
    accent: "#e0b25f",
    accentBright: "#ffe2a1",
    secondary: "#8d7fff",
    fog: "#060810",
    fogDensity: 0.05,
    ambient: "#2e3252",
    dust: { color: "#ffd98a", size: 0.05, flow: [0, 0.12] },
    nebulae: ["#8d7fff", "#e0b25f", "#4fd8a8"],
    effect: "aurora",
    dice: { body: "#141126", roughness: 0.3, metalness: 0.8, opacity: 1, edge: "#ffd98a", edgeOpacity: 0.65 },
    glyphs: "ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃᛇᛈᛉᛊᛏᛒᛖᛗᛚᛜᛞᛟ",
    glyphFont: "44px serif",
    loom: {
      heart: "255,214,138", world: "#0d1024", wireBoost: 1.1,
      // Rising embers, a graceful waltz of a swirl.
      motion: { swirl: 1.3, rise: 0.35, wobble: 1.15, ringSpeed: 1, ringSway: 0.035, orbit: 0.06, flicker: 0 }
    },
    copy: {
      kicker: "The Weaving begins",
      join: "A new hero is woven in",
      reconnect: "A lost thread returns to the loom",
      depart: "A thread slips loose from the loom",
      gathering: "The threads are gathering…",
      joinGathering: "The loom makes room for another…"
    }
  },
  scifi: {
    key: "scifi",
    accent: "#4fd8ff",
    accentBright: "#a8ecff",
    secondary: "#ff4fa8",
    fog: "#020610",
    fogDensity: 0.045,
    ambient: "#16324a",
    dust: { color: "#7fe2ff", size: 0.042, flow: [0, 0] },
    nebulae: ["#2450c8", "#ff4fa8", "#4fd8ff"],
    effect: "warp",
    dice: { body: "#04101c", roughness: 0.15, metalness: 0.4, opacity: 0.22, edge: "#4fd8ff", edgeOpacity: 0.95 },
    glyphs: "0123456789ABCDEF∆◇",
    glyphFont: "40px monospace",
    loom: {
      heart: "120,220,255", world: "#04101e", wireBoost: 1.8,
      // Fast, precise, machine-steady: quick rings, no jitter, brisk camera.
      motion: { swirl: 2.3, rise: 0, wobble: 0.35, ringSpeed: 1.8, ringSway: 0.012, orbit: 0.085, flicker: 0 }
    },
    copy: {
      kicker: "Reality compiles",
      join: "A new signal joins the constellation",
      reconnect: "Signal reacquired — re-syncing",
      depart: "Signal lost — sealing the airlock",
      gathering: "Assembling the starfield…",
      joinGathering: "Docking a new arrival…"
    }
  },
  horror: {
    key: "horror",
    accent: "#9fb86a",
    accentBright: "#c9dd8f",
    secondary: "#b3202a",
    fog: "#050303",
    fogDensity: 0.075,
    ambient: "#1c2418",
    dust: { color: "#8a9a6a", size: 0.04, flow: [0, 0.22] },
    nebulae: ["#3d0f14", "#41501f", "#20262c"],
    effect: "haunt",
    dice: { body: "#160f0d", roughness: 0.9, metalness: 0.1, opacity: 1, edge: "#9fb86a", edgeOpacity: 0.4 },
    glyphs: "†‡☽☾ΨΦΘΞΔϟζξ",
    glyphFont: "44px serif",
    loom: {
      heart: "170,200,110", world: "#100a08", wireBoost: 0.8,
      // Slow sinking dread; rings list like a derelict; candlelight gutters.
      motion: { swirl: 0.55, rise: -0.25, wobble: 2.4, ringSpeed: 0.45, ringSway: 0.09, orbit: 0.03, flicker: 0.8 }
    },
    copy: {
      kicker: "Something stirs in the dark",
      join: "Another soul wanders in",
      reconnect: "A lost soul claws its way back",
      depart: "The dark swallows a soul whole",
      gathering: "The shadows are knitting together…",
      joinGathering: "The dark makes room…"
    }
  },
  noir: {
    key: "noir",
    accent: "#d9c69a",
    accentBright: "#f2e3bb",
    secondary: "#5f7285",
    fog: "#04050a",
    fogDensity: 0.06,
    ambient: "#242a34",
    dust: { color: "#aebdd6", size: 0.032, flow: [0.05, -0.05] },
    nebulae: ["#2a3542", "#d9c69a", "#141a22"],
    effect: "rain",
    dice: { body: "#0c0d12", roughness: 0.2, metalness: 0.9, opacity: 1, edge: "#d9c69a", edgeOpacity: 0.42 },
    glyphs: "?!•§¶†×—",
    glyphFont: "42px monospace",
    loom: {
      heart: "217,198,154", world: "#0b0d13", wireBoost: 0.9,
      // Rain streaks down past the streetlamp; a faint neon buzz in the light.
      motion: { swirl: 0.45, rise: -0.9, wobble: 0.55, ringSpeed: 0.55, ringSway: 0.015, orbit: 0.035, flicker: 0.2 }
    },
    copy: {
      kicker: "The case file opens",
      join: "A new face walks into the precinct",
      reconnect: "An old face steps back out of the rain",
      depart: "A silhouette fades into the rain",
      gathering: "Smoke curls under the streetlamp…",
      joinGathering: "Someone new takes a seat in the back…"
    }
  },
  modern: {
    key: "modern",
    accent: "#4fe0c4",
    accentBright: "#9df2e1",
    secondary: "#ff9a3c",
    fog: "#030809",
    fogDensity: 0.05,
    ambient: "#183434",
    dust: { color: "#7fe8d4", size: 0.038, flow: [0.08, 0] },
    nebulae: ["#0f3c3c", "#ff9a3c", "#274a6a"],
    effect: "bokeh",
    dice: { body: "#0a1014", roughness: 0.15, metalness: 0.65, opacity: 1, edge: "#4fe0c4", edgeOpacity: 0.55 },
    glyphs: "0123456789°′″NSEW·",
    glyphFont: "40px monospace",
    loom: {
      heart: "110,235,205", world: "#081014", wireBoost: 1.4,
      motion: { swirl: 1.6, rise: 0.1, wobble: 0.6, ringSpeed: 1.25, ringSway: 0.02, orbit: 0.07, flicker: 0 }
    },
    copy: {
      kicker: "The operation goes live",
      join: "A new operative is being briefed",
      reconnect: "Re-establishing the uplink",
      depart: "An asset goes dark — covering their exit",
      gathering: "Assets are moving into position…",
      joinGathering: "Clearing a new asset…"
    }
  },
  western: {
    key: "western",
    accent: "#ffb35c",
    accentBright: "#ffd9a0",
    secondary: "#c4573a",
    fog: "#0a0503",
    fogDensity: 0.05,
    ambient: "#3a2414",
    dust: { color: "#d9a976", size: 0.05, flow: [0.55, 0.04] },
    nebulae: ["#c4573a", "#ffb35c", "#4a2a1a"],
    effect: "frontier",
    dice: { body: "#170f0a", roughness: 0.6, metalness: 0.4, opacity: 1, edge: "#d9964a", edgeOpacity: 0.55 },
    glyphs: "★✶✦☆♠♦†$",
    glyphFont: "42px serif",
    loom: {
      heart: "255,179,92", world: "#160d06", wireBoost: 1,
      // Dust on a hot wind; campfire flicker in the light.
      motion: { swirl: 1.1, rise: 0.12, wobble: 1.5, ringSpeed: 0.8, ringSway: 0.045, orbit: 0.045, flicker: 0.3 }
    },
    copy: {
      kicker: "The frontier awakens",
      join: "A stranger rides into town",
      reconnect: "A familiar silhouette returns at dusk",
      depart: "A rider vanishes over the ridge",
      gathering: "Dust rises on the horizon…",
      joinGathering: "Hoofbeats approach the camp…"
    }
  },
  postapoc: {
    key: "postapoc",
    accent: "#d98a3c",
    accentBright: "#ffc27a",
    secondary: "#9fd23c",
    fog: "#0a0806",
    fogDensity: 0.065,
    ambient: "#2e2a20",
    dust: { color: "#b09a7a", size: 0.055, flow: [0.4, 0.08] },
    nebulae: ["#5a3a1a", "#9fd23c", "#3a3430"],
    effect: "frontier",
    dice: { body: "#141210", roughness: 0.85, metalness: 0.3, opacity: 1, edge: "#d98a3c", edgeOpacity: 0.5 },
    glyphs: "☢☣▲✚Ø×∅≡",
    glyphFont: "42px monospace",
    loom: {
      heart: "217,138,60", world: "#12100c", wireBoost: 0.9,
      // Ash sifts down; the world knits together under a failing reactor glow.
      motion: { swirl: 0.8, rise: -0.55, wobble: 1.9, ringSpeed: 0.7, ringSway: 0.055, orbit: 0.04, flicker: 0.45 }
    },
    copy: {
      kicker: "The old world stirs",
      join: "A survivor crests the ridge",
      reconnect: "A survivor limps back to the fire",
      depart: "A survivor's trail goes cold",
      gathering: "Ash settles over the meeting ground…",
      joinGathering: "Another silhouette against the dust…"
    }
  }
};

export function themeVisual(theme: ThemeKey | string | null | undefined): ThemeVisual {
  return THEME_VISUALS[(theme || "none") as ThemeKey] || THEME_VISUALS.none;
}
