"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { bgmGetAnalyser } from "@/lib/client/audio";
import { themeVisual, ThemeKey, ThemeVisual } from "@/components/three/themeVisuals";

/* ═══════════════════════════════════════════════════════════════════════════
   THE WORLDFORGE — one visual language for the Gathering and the Weaving.

   A floating island world hangs unbuilt in the void: every landmark of it
   (the island itself, a spire, mountains, groves, standing stones, an arch,
   loose shards) drifts far out in the dark as a tumbling wireframe ghost.

   In the lobby the fragments simply orbit, charged a little more with every
   hero who takes a seat (`drama`). During the Weaving, `progress` (0..1,
   monotonic) pulls them home one by one: each fragment is tractored in on a
   rising arc, snaps into place with a spark burst, then MATERIALIZES — a
   reveal front sweeps it bottom-to-top, wireframe dying away as solid faceted
   matter fills in behind an emissive scan line. A stardust vortex contracts
   into the worldheart, a builder-stream of motes feeds whichever landmark is
   currently forming, and at 100% a ground shockwave and flash mark the moment
   the world holds. An energy draw spirals motes in from the void to feed the
   worldheart for the whole weave. The campaign theme recolors the palette, re-letters the
   ground inscription, swaps the landmark kit, and sets the motion personality
   (rising fantasy embers, noir rain, machine-steady scifi rings…).
   ═══════════════════════════════════════════════════════════════════════ */

const easeOutCubic = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);
const easeInOutCubic = (x: number) => {
  const t = clamp01(x);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};
function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

/** Deterministic per-mount PRNG so scatter orbits don't reshuffle on rebuild. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Soft radial glow sprite texture. */
function makeGlowTexture(inner: string, outer: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(128, 128, 6, 128, 128, 128);
  gradient.addColorStop(0, inner);
  gradient.addColorStop(1, outer);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(canvas);
}

/** Round particle sprite — additive Points read as light, not squares. */
function makeSparkTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.35, "rgba(255,255,255,0.65)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

/** Vertical gradient for the worldheart's light column. */
function makeBeamTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createLinearGradient(0, 0, 0, 256);
  gradient.addColorStop(0, "rgba(255,255,255,0.85)");
  gradient.addColorStop(0.6, "rgba(255,255,255,0.25)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 256);
  return new THREE.CanvasTexture(canvas);
}

/** Theme glyph strip wrapped around the ground inscription ring (polar UVs). */
function makeGlyphBandTexture(accent: string, glyphs: string, font: string, anisotropy: number) {
  const width = 4096;
  const height = 160;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = accent;
  ctx.globalAlpha = 0.3;
  ctx.fillRect(0, 4, width, 2);
  ctx.fillRect(0, height - 6, width, 2);
  const family = font.replace(/^[\d.]+px\s*/, "") || "serif";
  ctx.font = `${Math.round(height * 0.6)}px ${family}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = accent;
  ctx.shadowBlur = 6;
  const count = 40;
  for (let i = 0; i < count; i += 1) {
    ctx.globalAlpha = 0.55 + (i % 3) * 0.15;
    ctx.fillText(glyphs[i % glyphs.length], ((i + 0.5) / count) * width, height * 0.52);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.anisotropy = anisotropy;
  return texture;
}

/* ── landmark kits ─────────────────────────────────────────────────────────
   Every theme builds the same seven-fragment world (island + six landmarks in
   fixed slots) from a tiny primitive DSL, so silhouettes read distinctly per
   genre while the assembly choreography stays one code path. */

type Prim = {
  g: "box" | "cone" | "cyl" | "ico" | "tet" | "oct" | "torus" | "sphere";
  a: number[];
  p?: [number, number, number];
  r?: [number, number, number];
};

type LandmarkDef = {
  prims: Prim[];
  /** Fragments that never truly settle — shards/drones keep floating. */
  float?: boolean;
};

function makeGeometry(prim: Prim): THREE.BufferGeometry {
  switch (prim.g) {
    case "box": return new THREE.BoxGeometry(prim.a[0], prim.a[1], prim.a[2]);
    case "cone": return new THREE.ConeGeometry(prim.a[0], prim.a[1], Math.round(prim.a[2] ?? 6));
    case "cyl": return new THREE.CylinderGeometry(prim.a[0], prim.a[1], prim.a[2], Math.round(prim.a[3] ?? 6));
    case "ico": return new THREE.IcosahedronGeometry(prim.a[0], Math.round(prim.a[1] ?? 0));
    case "tet": return new THREE.TetrahedronGeometry(prim.a[0], 0);
    case "oct": return new THREE.OctahedronGeometry(prim.a[0], 0);
    case "torus": return new THREE.TorusGeometry(prim.a[0], prim.a[1], Math.round(prim.a[2] ?? 6), Math.round(prim.a[3] ?? 24), prim.a[4]);
    case "sphere": return new THREE.SphereGeometry(prim.a[0], Math.round(prim.a[1] ?? 8), Math.round(prim.a[2] ?? 6));
  }
}

/** The floating island every theme shares — plateau above, crag below. */
const ISLAND: LandmarkDef = {
  prims: [
    { g: "cyl", a: [4.3, 2.9, 1.5, 9], p: [0, -0.75, 0] },
    { g: "cone", a: [2.5, 3.0, 7], p: [0, -2.9, 0], r: [Math.PI, 0, 0] }
  ]
};

/** Small helpers so kit tables stay readable. */
const ring = (g: Prim["g"], a: number[], n: number, radius: number, y: number, tilt = 0): Prim[] =>
  Array.from({ length: n }, (_, i) => {
    const angle = (i / n) * Math.PI * 2;
    return {
      g,
      a,
      p: [Math.cos(angle) * radius, y, Math.sin(angle) * radius] as [number, number, number],
      r: [tilt * ((i % 2) * 2 - 1), -angle, 0] as [number, number, number]
    };
  });

const trio = (make: (i: number) => Prim[], spots: Array<[number, number]>): Prim[] =>
  spots.flatMap(([x, z], i) => make(i).map((prim) => ({
    ...prim,
    p: [(prim.p?.[0] ?? 0) + x, prim.p?.[1] ?? 0, (prim.p?.[2] ?? 0) + z] as [number, number, number]
  })));

/** Six landmark slots on the island plateau (x, z), hero slot first. */
const SLOTS: Array<[number, number]> = [
  [0, -0.2],
  [-2.2, -1.1],
  [2.0, 1.1],
  [-1.5, 1.9],
  [1.9, -1.7],
  [0.5, 0.9]
];

const KITS: Record<ThemeKey, LandmarkDef[]> = {
  none: [
    { prims: [{ g: "box", a: [0.55, 2.6, 0.55], p: [0, 1.3, 0] }, { g: "oct", a: [0.42], p: [0, 2.95, 0] }] },
    { prims: [{ g: "cone", a: [1.15, 2.2, 5], p: [-0.3, 1.1, 0] }, { g: "cone", a: [0.8, 1.5, 5], p: [0.7, 0.75, 0.4] }] },
    { prims: trio(() => [{ g: "cyl", a: [0.13, 0.18, 1.25, 6], p: [0, 0.62, 0] }], [[0, 0], [0.65, 0.3], [-0.5, 0.45]]) },
    { prims: ring("box", [0.28, 0.8, 0.18], 6, 1.05, 0.4) },
    { prims: [{ g: "box", a: [0.3, 1.6, 0.3], p: [-0.75, 0.8, 0] }, { g: "box", a: [0.3, 1.6, 0.3], p: [0.75, 0.8, 0] }, { g: "box", a: [2.1, 0.32, 0.34], p: [0, 1.72, 0] }] },
    { float: true, prims: [{ g: "oct", a: [0.26], p: [0, 1.7, 0] }, { g: "oct", a: [0.18], p: [0.7, 2.3, 0.3] }, { g: "oct", a: [0.14], p: [-0.6, 2.7, -0.2] }] }
  ],
  fantasy: [
    { prims: [{ g: "cyl", a: [0.5, 0.72, 2.6, 6], p: [0, 1.3, 0] }, { g: "cone", a: [0.78, 1.4, 6], p: [0, 3.3, 0] }, { g: "oct", a: [0.26], p: [0, 4.35, 0] }] },
    { prims: [{ g: "cone", a: [1.15, 2.3, 5], p: [-0.3, 1.15, 0] }, { g: "cone", a: [0.8, 1.5, 5], p: [0.75, 0.75, 0.4] }] },
    { prims: trio(() => [{ g: "cyl", a: [0.09, 0.13, 0.5, 5], p: [0, 0.25, 0] }, { g: "cone", a: [0.46, 1.15, 6], p: [0, 1.05, 0] }], [[0, 0], [0.7, 0.35], [-0.55, 0.5]]) },
    { prims: ring("box", [0.28, 0.85, 0.2], 6, 1.05, 0.42) },
    { prims: [{ g: "box", a: [0.3, 1.6, 0.3], p: [-0.75, 0.8, 0] }, { g: "box", a: [0.3, 1.6, 0.3], p: [0.75, 0.8, 0] }, { g: "box", a: [2.1, 0.34, 0.36], p: [0, 1.74, 0] }] },
    { float: true, prims: [{ g: "tet", a: [0.3], p: [0, 1.8, 0] }, { g: "tet", a: [0.2], p: [0.7, 2.4, 0.3] }, { g: "tet", a: [0.16], p: [-0.6, 2.9, -0.2] }] }
  ],
  scifi: [
    { prims: [{ g: "box", a: [0.95, 1.2, 0.95], p: [0, 0.6, 0] }, { g: "box", a: [0.62, 1.15, 0.62], p: [0, 1.75, 0] }, { g: "cyl", a: [0.045, 0.045, 1.7, 4], p: [0, 3.15, 0] }, { g: "oct", a: [0.24], p: [0, 4.1, 0] }] },
    { prims: [{ g: "tet", a: [1.35], p: [-0.2, 0.85, 0], r: [0.35, 0.5, 0] }, { g: "tet", a: [0.85], p: [0.85, 0.5, 0.4], r: [0.2, 1.4, 0.1] }] },
    { prims: trio(() => [{ g: "cyl", a: [0.055, 0.055, 1.35, 4], p: [0, 0.67, 0] }, { g: "oct", a: [0.22], p: [0, 1.5, 0] }], [[0, 0], [0.7, 0.3], [-0.55, 0.45]]) },
    { prims: ring("box", [0.3, 1.1, 0.12], 5, 1.05, 0.55) },
    { prims: [{ g: "torus", a: [1.0, 0.09, 6, 20, Math.PI], p: [0, 0.02, 0] }] },
    { float: true, prims: [{ g: "oct", a: [0.18], p: [0, 1.9, 0] }, { g: "oct", a: [0.15], p: [0.75, 2.5, 0.3] }, { g: "oct", a: [0.12], p: [-0.65, 3.0, -0.25] }] }
  ],
  horror: [
    { prims: [{ g: "cyl", a: [0.45, 0.65, 2.4, 5], p: [0, 1.2, 0], r: [0, 0, 0.07] }, { g: "cone", a: [0.72, 1.35, 5], p: [0.16, 3.0, 0], r: [0, 0, 0.14] }] },
    { prims: [{ g: "cone", a: [1.05, 2.4, 4], p: [-0.3, 1.2, 0], r: [0, 0, 0.12] }, { g: "cone", a: [0.7, 1.6, 4], p: [0.7, 0.8, 0.4], r: [0.08, 0, -0.1] }] },
    { prims: trio((i) => [{ g: "cyl", a: [0.05, 0.1, 1.5, 4], p: [0, 0.75, 0], r: [0, 0, 0.18 * (i - 1)] }], [[0, 0], [0.6, 0.4], [-0.55, 0.35]]) },
    { prims: ring("box", [0.3, 0.52, 0.09], 6, 1.0, 0.3, 0.16) },
    { prims: [{ g: "box", a: [0.28, 1.5, 0.28], p: [-0.7, 0.75, 0] }, { g: "box", a: [1.5, 0.3, 0.32], p: [0.15, 1.45, 0], r: [0, 0, -0.38] }] },
    { float: true, prims: [{ g: "sphere", a: [0.13, 6, 5], p: [0, 1.6, 0] }, { g: "sphere", a: [0.1, 6, 5], p: [0.65, 2.2, 0.3] }, { g: "sphere", a: [0.08, 6, 5], p: [-0.55, 2.6, -0.2] }] }
  ],
  noir: [
    { prims: [{ g: "box", a: [1.0, 2.8, 1.0], p: [0, 1.4, 0] }, { g: "box", a: [0.68, 1.2, 0.68], p: [0, 3.4, 0] }, { g: "cyl", a: [0.035, 0.035, 1.0, 4], p: [0, 4.5, 0] }] },
    { prims: [{ g: "box", a: [0.85, 1.7, 0.85], p: [-0.4, 0.85, 0] }, { g: "box", a: [0.6, 2.3, 0.6], p: [0.55, 1.15, 0.35] }] },
    { prims: trio(() => [{ g: "cyl", a: [0.045, 0.045, 1.55, 4], p: [0, 0.77, 0] }, { g: "sphere", a: [0.1, 6, 5], p: [0, 1.6, 0] }], [[0, 0], [0.75, 0.3], [-0.6, 0.4]]) },
    { prims: ring("box", [0.5, 0.68, 0.06], 4, 1.0, 0.34) },
    { prims: [{ g: "box", a: [0.26, 1.3, 0.26], p: [-0.85, 0.65, 0] }, { g: "box", a: [0.26, 1.3, 0.26], p: [0.85, 0.65, 0] }, { g: "box", a: [2.35, 0.22, 0.42], p: [0, 1.35, 0] }] },
    { float: true, prims: [{ g: "tet", a: [0.16], p: [0, 1.7, 0] }, { g: "tet", a: [0.12], p: [0.6, 2.2, 0.25] }, { g: "tet", a: [0.1], p: [-0.5, 2.6, -0.2] }] }
  ],
  modern: [
    { prims: [{ g: "box", a: [0.92, 3.0, 0.92], p: [0, 1.5, 0] }, { g: "box", a: [1.02, 0.14, 1.02], p: [0, 3.05, 0] }, { g: "cyl", a: [0.03, 0.03, 0.9, 4], p: [0, 3.6, 0] }] },
    { prims: [{ g: "box", a: [0.72, 1.9, 0.72], p: [-0.4, 0.95, 0] }, { g: "box", a: [0.56, 1.35, 0.56], p: [0.5, 0.68, 0.35] }] },
    { prims: trio(() => [{ g: "cyl", a: [0.045, 0.045, 1.4, 4], p: [0, 0.7, 0] }, { g: "oct", a: [0.16], p: [0, 1.55, 0] }], [[0, 0], [0.7, 0.3], [-0.55, 0.45]]) },
    { prims: ring("box", [0.62, 0.42, 0.06], 4, 1.05, 0.55) },
    { prims: [{ g: "box", a: [0.24, 1.15, 0.24], p: [-0.8, 0.58, 0] }, { g: "box", a: [0.24, 1.15, 0.24], p: [0.8, 0.58, 0] }, { g: "box", a: [2.2, 0.18, 0.5], p: [0, 1.2, 0] }] },
    { float: true, prims: [{ g: "oct", a: [0.16], p: [0, 1.8, 0] }, { g: "oct", a: [0.13], p: [0.65, 2.35, 0.3] }, { g: "oct", a: [0.1], p: [-0.55, 2.8, -0.25] }] }
  ],
  western: [
    { prims: [{ g: "cyl", a: [0.045, 0.045, 1.9, 4], p: [-0.35, 0.95, -0.3], r: [0, 0, 0.12] }, { g: "cyl", a: [0.045, 0.045, 1.9, 4], p: [0.35, 0.95, -0.3], r: [0, 0, -0.12] }, { g: "cyl", a: [0.045, 0.045, 1.9, 4], p: [0, 0.95, 0.42], r: [0.12, 0, 0] }, { g: "cyl", a: [0.6, 0.6, 0.75, 7], p: [0, 2.2, 0] }, { g: "cone", a: [0.7, 0.5, 7], p: [0, 2.83, 0] }] },
    { prims: [{ g: "cyl", a: [0.85, 1.15, 1.35, 6], p: [-0.3, 0.68, 0] }, { g: "cyl", a: [0.55, 0.78, 0.95, 5], p: [0.75, 0.48, 0.4] }] },
    { prims: trio(() => [{ g: "cyl", a: [0.12, 0.15, 1.05, 6], p: [0, 0.52, 0] }, { g: "cyl", a: [0.09, 0.1, 0.5, 5], p: [0.28, 0.85, 0], r: [0, 0, Math.PI / 2.4] }], [[0, 0], [0.8, 0.35], [-0.65, 0.4]]) },
    { prims: ring("box", [0.2, 0.5, 0.12], 5, 1.0, 0.26, 0.1) },
    { prims: [{ g: "box", a: [0.24, 1.7, 0.24], p: [-0.9, 0.85, 0] }, { g: "box", a: [0.24, 1.7, 0.24], p: [0.9, 0.85, 0] }, { g: "box", a: [2.4, 0.26, 0.3], p: [0, 1.82, 0] }] },
    { float: true, prims: [{ g: "tet", a: [0.22], p: [0, 1.4, 0] }, { g: "tet", a: [0.16], p: [0.6, 1.9, 0.3] }, { g: "tet", a: [0.13], p: [-0.55, 2.3, -0.2] }] }
  ],
  postapoc: [
    { prims: [{ g: "box", a: [0.85, 2.2, 0.85], p: [0, 1.1, 0], r: [0, 0, 0.06] }, { g: "box", a: [0.55, 0.95, 0.55], p: [0.2, 2.55, 0], r: [0, 0, 0.2] }, { g: "tet", a: [0.35], p: [0.42, 3.25, 0.1], r: [0.4, 0.2, 0.5] }] },
    { prims: [{ g: "cone", a: [1.05, 1.5, 5], p: [-0.3, 0.75, 0] }, { g: "cone", a: [0.72, 1.05, 4], p: [0.7, 0.52, 0.4] }] },
    { prims: trio((i) => [{ g: "cyl", a: [0.035, 0.05, 1.45, 4], p: [0, 0.72, 0], r: [0.12 * (i - 1), 0, 0.2 * (i - 1)] }], [[0, 0], [0.55, 0.35], [-0.5, 0.4]]) },
    { prims: ring("box", [0.34, 0.4, 0.1], 5, 1.05, 0.2, 0.22) },
    { prims: [{ g: "box", a: [0.3, 1.6, 0.3], p: [-0.75, 0.8, 0] }, { g: "box", a: [1.9, 0.3, 0.34], p: [0.35, 0.24, 0.15], r: [0, 0.2, 1.32] }] },
    { float: true, prims: [{ g: "tet", a: [0.2], p: [0, 1.5, 0] }, { g: "tet", a: [0.15], p: [0.6, 2.0, 0.3] }, { g: "tet", a: [0.12], p: [-0.5, 2.4, -0.2] }] }
  ]
};

/* ── theme signature relics ────────────────────────────────────────────────
   Each genre gets one emblem — its signature made literal (a crowned crystal,
   a ringed station, drifting tombstones, a streetlamp lost in the rain, a
   wagon wheel, a dead gear…) — that orbits the unforged world in BOTH the
   lobby and the weave. Two fly at opposite phases so one is always in shot. */

const EMBLEMS: Record<ThemeKey, { prims: Prim[]; y: number }> = {
  none: {
    y: 4.6,
    prims: [
      { g: "torus", a: [1.05, 0.045, 6, 30] },
      { g: "oct", a: [0.42] }
    ]
  },
  fantasy: {
    // A crowned crystal with attendant shards — arcana adrift.
    y: 5.2,
    prims: [
      { g: "oct", a: [0.6] },
      { g: "torus", a: [1.05, 0.04, 5, 26], r: [Math.PI / 2.4, 0, 0] },
      { g: "tet", a: [0.2], p: [1.05, 0.35, 0] },
      { g: "tet", a: [0.15], p: [-0.95, -0.4, 0.25] }
    ]
  },
  scifi: {
    // A ringed orbital station with a solar truss.
    y: 5.6,
    prims: [
      { g: "cyl", a: [0.26, 0.26, 1.15, 8] },
      { g: "torus", a: [0.95, 0.05, 6, 30], r: [Math.PI / 2, 0, 0] },
      { g: "box", a: [2.5, 0.05, 0.5] }
    ]
  },
  horror: {
    // Uprooted tombstones and a skull-round stone, circling like carrion.
    y: 3.6,
    prims: [
      { g: "box", a: [0.7, 1.1, 0.14], p: [0, 0.25, 0], r: [0, 0, 0.16] },
      { g: "box", a: [0.5, 0.75, 0.12], p: [0.8, -0.15, 0.25], r: [0, 0.35, -0.24] },
      { g: "sphere", a: [0.2, 6, 5], p: [-0.55, -0.35, 0.1] }
    ]
  },
  noir: {
    // A streetlamp torn loose from its corner, still leaning into the rain.
    y: 4.4,
    prims: [
      { g: "cyl", a: [0.05, 0.07, 2.5, 6] },
      { g: "box", a: [0.75, 0.1, 0.28], p: [0.32, 1.28, 0] },
      { g: "cone", a: [0.34, 0.45, 6], p: [0.58, 1.05, 0], r: [Math.PI, 0, 0] }
    ]
  },
  modern: {
    // A comms satellite: bus, twin panels, whip antenna.
    y: 5.4,
    prims: [
      { g: "box", a: [0.55, 0.55, 0.9] },
      { g: "box", a: [1.9, 0.04, 0.55], p: [1.35, 0, 0] },
      { g: "box", a: [1.9, 0.04, 0.55], p: [-1.35, 0, 0] },
      { g: "cyl", a: [0.025, 0.025, 0.8, 4], p: [0, 0.65, 0] }
    ]
  },
  western: {
    // A wagon wheel, spokes and all, tumbling over the frontier.
    y: 3.9,
    prims: [
      { g: "torus", a: [0.85, 0.08, 6, 20] },
      { g: "box", a: [1.62, 0.08, 0.08] },
      { g: "box", a: [1.62, 0.08, 0.08], r: [0, 0, Math.PI / 3] },
      { g: "box", a: [1.62, 0.08, 0.08], r: [0, 0, -Math.PI / 3] }
    ]
  },
  postapoc: {
    // A dead gear from some machine the old world forgot to finish.
    y: 4.8,
    prims: [
      { g: "torus", a: [0.85, 0.14, 5, 9], r: [Math.PI / 2, 0, 0] },
      ...ring("box", [0.2, 0.32, 0.2], 6, 1.0, 0)
    ]
  }
};

/* Far-orbit debris silhouettes, themed: crystals, hull plates, skull-round
   stones, glass slivers, planks… depth dressing that reads in genre. */
const DEBRIS_SHAPE: Record<ThemeKey, (rand: () => number) => THREE.BufferGeometry> = {
  none: (r) => new THREE.TetrahedronGeometry(0.22 + r() * 0.3, 0),
  fantasy: (r) => new THREE.OctahedronGeometry(0.2 + r() * 0.26, 0),
  scifi: (r) => new THREE.BoxGeometry(0.34 + r() * 0.3, 0.1 + r() * 0.1, 0.22 + r() * 0.22),
  horror: (r) => new THREE.SphereGeometry(0.15 + r() * 0.16, 5, 4),
  noir: (r) => new THREE.BoxGeometry(0.06, 0.4 + r() * 0.45, 0.06),
  modern: (r) => new THREE.IcosahedronGeometry(0.17 + r() * 0.18, 0),
  western: (r) => new THREE.BoxGeometry(0.45 + r() * 0.35, 0.07, 0.16),
  postapoc: (r) => new THREE.TetrahedronGeometry(0.26 + r() * 0.34, 0)
};

/* ── per-theme audio flavor ────────────────────────────────────────────────
   Beyond the bass beat (which fires the ground ripple), the music drives the
   scene through three bands — bass, mids, treble — plus a mid-band onset
   detector (the riff). Each genre reacts through its own channels so its
   music feels alive in its own way: noir rain pours harder with the mids,
   scifi rings spin up on treble, postapoc surges on the riff, horror lights
   sag under the swell.
     rush    — mids accelerate the theme weather (rain / ash / embers)
     twinkle — treble shimmers the dust, weather, and vortex motes
     spin    — treble spins the ascension rings and foundation spokes
     surge   — riff onsets flare the heart, emblems, and sigil
     sag     — mids strain the lights (candle / reactor gutter deepens) */
const AUDIO_FLAVOR: Record<ThemeKey, { rush: number; twinkle: number; spin: number; surge: number; sag: number }> = {
  none: { rush: 0.5, twinkle: 0.6, spin: 0.4, surge: 0.6, sag: 0 },
  fantasy: { rush: 0.9, twinkle: 1.1, spin: 0.4, surge: 0.7, sag: 0 },
  scifi: { rush: 0.4, twinkle: 0.8, spin: 1.6, surge: 0.9, sag: 0 },
  horror: { rush: 0.7, twinkle: 0.3, spin: 0.2, surge: 0.4, sag: 1.2 },
  noir: { rush: 1.5, twinkle: 0.5, spin: 0.3, surge: 0.4, sag: 0.5 },
  modern: { rush: 0.6, twinkle: 1.0, spin: 1.1, surge: 0.7, sag: 0 },
  western: { rush: 1.2, twinkle: 0.6, spin: 0.4, surge: 0.6, sag: 0.6 },
  postapoc: { rush: 1.0, twinkle: 0.5, spin: 0.5, surge: 1.65, sag: 0.8 }
};

/* ── the materialization shader ────────────────────────────────────────────
   One MeshStandardMaterial per landmark, extended with a world-space reveal
   front: fragments above uReveal are discarded, and a thin emissive scan band
   glows just under the front — matter visibly "prints" bottom-to-top. */

type MatterUniforms = {
  uReveal: { value: number };
  uMinY: { value: number };
  uMaxY: { value: number };
  uEdgeColor: { value: THREE.Color };
  uEdgeGain: { value: number };
};

function makeMatterMaterial(visual: ThemeVisual, accent: THREE.Color): { material: THREE.MeshStandardMaterial; uniforms: MatterUniforms } {
  const uniforms: MatterUniforms = {
    uReveal: { value: 0 },
    uMinY: { value: 0 },
    uMaxY: { value: 1 },
    uEdgeColor: { value: accent.clone() },
    uEdgeGain: { value: 1.2 }
  };
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(visual.loom.world),
    roughness: 0.55,
    metalness: 0.35,
    flatShading: true,
    emissive: accent.clone(),
    emissiveIntensity: 0.05
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying float vForgeY;")
      .replace(
        "#include <project_vertex>",
        "#include <project_vertex>\nvForgeY = (modelMatrix * vec4(transformed, 1.0)).y;"
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying float vForgeY;\nuniform float uReveal;\nuniform float uMinY;\nuniform float uMaxY;\nuniform vec3 uEdgeColor;\nuniform float uEdgeGain;"
      )
      .replace(
        "#include <dithering_fragment>",
        [
          "float forgeH = clamp((vForgeY - uMinY) / max(uMaxY - uMinY, 0.0001), 0.0, 1.0);",
          "if (uReveal < 0.9995 && forgeH > uReveal) discard;",
          "float forgeEdge = smoothstep(uReveal - 0.14, uReveal, forgeH) * (1.0 - step(0.9995, uReveal));",
          "gl_FragColor.rgb += uEdgeColor * forgeEdge * uEdgeGain;",
          "#include <dithering_fragment>"
        ].join("\n")
      );
  };
  return { material, uniforms };
}

/* ── runtime landmark state ──────────────────────────────────────────────── */

type Landmark = {
  group: THREE.Group;
  wire: THREE.LineSegments;
  wireMaterial: THREE.LineBasicMaterial;
  matter: THREE.Mesh[];
  uniforms: MatterUniforms;
  anchor: THREE.Vector3;
  windowStart: number;
  windowWidth: number;
  float: boolean;
  seed: number;
  orbitRadius: number;
  orbitY: number;
  dir: number;
  locked: boolean;
  flash: number;
};

/** Merge the EdgesGeometry of every prim into one wireframe per landmark. */
function buildWireframe(group: THREE.Group): THREE.BufferGeometry {
  const chunks: number[] = [];
  const v = new THREE.Vector3();
  group.updateMatrixWorld(true);
  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const edges = new THREE.EdgesGeometry(child.geometry as THREE.BufferGeometry, 12);
    const position = edges.getAttribute("position");
    for (let i = 0; i < position.count; i += 1) {
      v.fromBufferAttribute(position as THREE.BufferAttribute, i);
      child.localToWorld(v);
      group.worldToLocal(v);
      chunks.push(v.x, v.y, v.z);
    }
    edges.dispose();
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(chunks), 3));
  return geometry;
}

export default function WorldForge({
  mode = "weaving",
  progress = 0,
  drama = 0.5,
  accent,
  theme = "none",
  title = ""
}: {
  /** "lobby": the unforged fragments drift, charged by `drama`. "weaving": `progress` assembles the world. */
  mode?: "lobby" | "weaving";
  /** 0..1, monotonic — how much of the world is forged. */
  progress?: number;
  /** Lobby charge (players seated); 0..1-ish. */
  drama?: number;
  accent?: string;
  theme?: ThemeKey | string | null;
  /** Weaving only: drawn into the in-scene readout (kicker + title + percent). */
  title?: string;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef(progress);
  progressRef.current = progress;
  const dramaRef = useRef(drama);
  dramaRef.current = drama;
  // Ref, not an effect dep: a sealed campaign's title is revealed mid-finale,
  // and rebuilding the whole scene for a caption change would reset the world.
  const titleRef = useRef(title);
  titleRef.current = title;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const visual = themeVisual(theme);
    const accentHex = accent || visual.accent;
    const isLobby = mode === "lobby";

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(new THREE.Color(visual.fog), 0.026);

    const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 220);
    camera.position.set(0, 4.6, 16.5);
    // In the scene graph so camera-anchored children (the readout) render.
    scene.add(camera);

    const accentColor = new THREE.Color(accentHex);
    const brightColor = new THREE.Color(visual.accentBright);
    const secondaryColor = new THREE.Color(visual.secondary);
    const motion = visual.loom.motion;
    const rand = mulberry32(0x5eed + visual.key.length * 101);

    const disposables: Array<{ dispose: () => void }> = [];
    const sparkTexture = makeSparkTexture();
    disposables.push(sparkTexture);

    /* -- lights ----------------------------------------------------------- */
    scene.add(new THREE.AmbientLight(new THREE.Color(visual.ambient), 1.3));
    const heartLight = new THREE.PointLight(accentColor, 6, 70, 1.8);
    heartLight.position.set(0, 4.9, 0);
    scene.add(heartLight);
    const rimLight = new THREE.PointLight(secondaryColor, 14, 80, 2);
    rimLight.position.set(10, 7, -8);
    scene.add(rimLight);

    /* -- landmarks -------------------------------------------------------- */
    const kit = KITS[visual.key] || KITS.none;
    const defs: Array<{ def: LandmarkDef; anchor: THREE.Vector3 }> = [
      { def: ISLAND, anchor: new THREE.Vector3(0, 0.75, 0) },
      ...kit.map((def, i) => ({
        def,
        anchor: new THREE.Vector3(SLOTS[i][0], 0.75, SLOTS[i][1])
      }))
    ];

    const N = defs.length;
    const SPAN_START = 0.05;
    const SPAN_END = 0.955;
    const width = ((SPAN_END - SPAN_START) * 1.55) / N;
    const landmarks: Landmark[] = defs.map(({ def, anchor }, index) => {
      const group = new THREE.Group();
      const { material, uniforms } = makeMatterMaterial(visual, accentColor);
      const matter: THREE.Mesh[] = [];
      for (const prim of def.prims) {
        const geometry = makeGeometry(prim);
        const mesh = new THREE.Mesh(geometry, material);
        if (prim.p) mesh.position.set(...prim.p);
        if (prim.r) mesh.rotation.set(...prim.r);
        mesh.visible = false;
        group.add(mesh);
        matter.push(mesh);
        disposables.push(geometry);
      }
      disposables.push(material);
      group.position.copy(anchor);
      scene.add(group);

      const wireGeometry = buildWireframe(group);
      const wireMaterial = new THREE.LineBasicMaterial({ color: accentColor, transparent: true, opacity: 0.14 });
      const wire = new THREE.LineSegments(wireGeometry, wireMaterial);
      group.add(wire);
      disposables.push(wireGeometry, wireMaterial);

      // Final-position bounds drive the world-space reveal sweep.
      const bbox = new THREE.Box3().setFromObject(group);
      uniforms.uMinY.value = bbox.min.y - 0.05;
      uniforms.uMaxY.value = bbox.max.y + 0.05;

      const seed = rand();
      return {
        group,
        wire,
        wireMaterial,
        matter,
        uniforms,
        anchor: anchor.clone(),
        windowStart: SPAN_START + ((SPAN_END - SPAN_START - width) * index) / Math.max(1, N - 1),
        windowWidth: width,
        float: !!def.float,
        seed,
        orbitRadius: 9.5 + seed * 5.5,
        orbitY: 2.2 + rand() * 4.8,
        dir: rand() > 0.5 ? 1 : -1,
        locked: false,
        flash: 0
      };
    });

    /* -- far debris: never assembles, pure depth dressing (themed) ---------- */
    const debrisShape = DEBRIS_SHAPE[visual.key] || DEBRIS_SHAPE.none;
    const debris: Array<{ line: THREE.LineSegments; radius: number; y: number; seed: number; speed: number }> = [];
    const debrisMaterial = new THREE.LineBasicMaterial({ color: accentColor, transparent: true, opacity: 0.1 });
    disposables.push(debrisMaterial);
    for (let i = 0; i < 14; i += 1) {
      const geometry = new THREE.EdgesGeometry(debrisShape(rand));
      const line = new THREE.LineSegments(geometry, debrisMaterial);
      scene.add(line);
      debris.push({ line, radius: 15 + rand() * 9, y: 1 + rand() * 8, seed: rand() * Math.PI * 2, speed: 0.35 + rand() * 0.6 });
      disposables.push(geometry);
    }

    /* -- theme emblems: the genre's signature relics, orbiting mid-field ---- */
    const emblemDef = EMBLEMS[visual.key] || EMBLEMS.none;
    const emblemTemp = new THREE.Group();
    const emblemTempGeoms: THREE.BufferGeometry[] = [];
    for (const prim of emblemDef.prims) {
      const geometry = makeGeometry(prim);
      const mesh = new THREE.Mesh(geometry);
      if (prim.p) mesh.position.set(...prim.p);
      if (prim.r) mesh.rotation.set(...prim.r);
      emblemTemp.add(mesh);
      emblemTempGeoms.push(geometry);
    }
    const emblemGeometry = buildWireframe(emblemTemp);
    for (const geometry of emblemTempGeoms) geometry.dispose();
    disposables.push(emblemGeometry);
    const emblems: Array<{ group: THREE.Group; material: THREE.LineBasicMaterial; phase: number; radius: number; y: number; dir: number }> = [];
    for (let i = 0; i < 2; i += 1) {
      const material = new THREE.LineBasicMaterial({ color: i === 0 ? accentColor : secondaryColor, transparent: true, opacity: 0 });
      const group = new THREE.Group();
      group.add(new THREE.LineSegments(emblemGeometry, material));
      scene.add(group);
      emblems.push({
        group,
        material,
        phase: i * Math.PI + rand() * 0.8,
        radius: 10.5 + i * 1.9,
        y: emblemDef.y + (i ? 1.7 : 0),
        dir: i ? -1 : 1
      });
      disposables.push(material);
    }

    /* -- foundation grid (holographic scaffolding) ------------------------- */
    const gridUniforms = {
      uTime: { value: 0 },
      // Accumulated spoke drift — advanced on the CPU so treble can speed it
      // up without the pattern jumping.
      uSpin: { value: 0 },
      uEnergy: { value: 0.4 },
      uFade: { value: 1 },
      // Beat-driven ripple: uPulseR is the ring's current radius, uPulseA its
      // strength. The BGM's bass onsets (or a quiet metronome fallback) fire
      // it, so the ground breathes in time with the music.
      uPulseR: { value: 0 },
      uPulseA: { value: 0 },
      uColorA: { value: accentColor.clone() },
      uColorB: { value: secondaryColor.clone() }
    };
    const gridMaterial = new THREE.ShaderMaterial({
      uniforms: gridUniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: [
        "varying vec2 vUv;",
        "void main() {",
        "  vUv = uv;",
        "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
        "}"
      ].join("\n"),
      fragmentShader: [
        "varying vec2 vUv;",
        "uniform float uTime; uniform float uSpin; uniform float uEnergy; uniform float uFade;",
        "uniform float uPulseR; uniform float uPulseA;",
        "uniform vec3 uColorA; uniform vec3 uColorB;",
        "void main() {",
        "  vec2 p = (vUv - 0.5) * 40.0;",
        "  float r = length(p);",
        "  float ang = atan(p.y, p.x) / 6.2831853;",
        "  float ringLine = 1.0 - smoothstep(0.0, 0.09, abs(fract(r / 1.7) - 0.5) * 1.7);",
        "  float spoke = 1.0 - smoothstep(0.0, 0.055, abs(fract(ang * 24.0 + uSpin) - 0.5) * (6.2831853 / 24.0) * r);",
        "  float pulse = exp(-abs(r - uPulseR) * 1.6) * uPulseA;",
        "  float falloff = exp(-r * 0.17);",
        "  float glow = (ringLine * 0.42 + spoke * 0.26) * falloff + pulse * 0.7 * falloff;",
        "  vec3 col = mix(uColorB, uColorA, clamp(ringLine + pulse, 0.0, 1.0));",
        "  float a = glow * uEnergy * uFade;",
        "  gl_FragColor = vec4(col * a, a);",
        "}"
      ].join("\n")
    });
    const grid = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), gridMaterial);
    grid.rotation.x = -Math.PI / 2;
    grid.position.y = -0.02;
    scene.add(grid);
    disposables.push(grid.geometry, gridMaterial);

    /* -- glyph inscription ring on the foundation -------------------------- */
    const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const glyphTexture = makeGlyphBandTexture(accentHex, visual.glyphs, visual.glyphFont, anisotropy);
    const glyphSegments = 200;
    const glyphGeometry = new THREE.RingGeometry(5.6, 6.5, glyphSegments, 1);
    const glyphUv = glyphGeometry.getAttribute("uv") as THREE.BufferAttribute;
    for (let j = 0; j <= 1; j += 1) {
      for (let i = 0; i <= glyphSegments; i += 1) {
        glyphUv.setXY(j * (glyphSegments + 1) + i, i / glyphSegments, j);
      }
    }
    glyphUv.needsUpdate = true;
    const glyphMaterial = new THREE.MeshBasicMaterial({
      map: glyphTexture,
      color: accentColor,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    const glyphRing = new THREE.Mesh(glyphGeometry, glyphMaterial);
    glyphRing.rotation.x = -Math.PI / 2;
    glyphRing.position.y = 0.02;
    scene.add(glyphRing);
    disposables.push(glyphTexture, glyphGeometry, glyphMaterial);

    /* -- the sigil IS the progress meter (weaving) ---------------------------
       No sweeping bar: the whole inscription CHARGES like a ritual circle.
       Every glyph glows — faint at 0%, white-hot at 100% — each letter
       breathing on its own clock, and a curtain of embers rises off the ring
       like a portal opening, taller and denser the further the weave gets. */
    const sigilUniforms = {
      uMap: { value: glyphTexture },
      uCharge: { value: 0 },
      uTime: { value: 0 },
      uBeat: { value: 0 },
      uSurge: { value: 0 },
      uColor: { value: accentColor.clone() },
      uHot: { value: brightColor.clone() }
    };
    const sigilVertexShader = [
      "varying vec2 vUv;",
      "void main() {",
      "  vUv = uv;",
      "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
      "}"
    ].join("\n");
    const sigilGlowMaterial = new THREE.ShaderMaterial({
      uniforms: sigilUniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: sigilVertexShader,
      fragmentShader: [
        "varying vec2 vUv;",
        "uniform sampler2D uMap;",
        "uniform float uCharge; uniform float uTime; uniform float uBeat; uniform float uSurge;",
        "uniform vec3 uColor; uniform vec3 uHot;",
        "void main() {",
        "  vec4 tex = texture2D(uMap, vUv);",
        "  float id = floor(vUv.x * 40.0);",
        "  float twinkle = 0.72 + 0.28 * sin(uTime * (1.1 + mod(id, 3.0) * 0.5) + id * 13.7);",
        "  float glow = uCharge * (0.5 + 0.9 * uCharge) * twinkle + (uBeat * 0.5 + uSurge * 0.45) * (0.25 + uCharge);",
        "  vec3 col = mix(uColor, uHot, clamp(uCharge * 0.7 + uBeat * 0.35, 0.0, 1.0));",
        "  float alpha = tex.a * glow;",
        "  gl_FragColor = vec4(col * alpha, alpha);",
        "}"
      ].join("\n")
    });
    const sigilGlow = new THREE.Mesh(glyphGeometry, sigilGlowMaterial);
    sigilGlow.rotation.x = -Math.PI / 2;
    sigilGlow.position.y = 0.03;
    sigilGlow.visible = !isLobby;
    scene.add(sigilGlow);
    disposables.push(sigilGlowMaterial);

    // Soft under-glow band beneath the inscription — the circle's charge.
    const sigilBandUniforms = {
      uCharge: { value: 0 },
      uBeat: { value: 0 },
      uColor: { value: accentColor.clone() }
    };
    const sigilBandMaterial = new THREE.ShaderMaterial({
      uniforms: sigilBandUniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: sigilVertexShader,
      fragmentShader: [
        "varying vec2 vUv;",
        "uniform float uCharge; uniform float uBeat;",
        "uniform vec3 uColor;",
        "void main() {",
        "  float radial = smoothstep(0.0, 0.4, vUv.y) * smoothstep(1.0, 0.6, vUv.y);",
        "  float alpha = radial * uCharge * (0.16 + uBeat * 0.2);",
        "  gl_FragColor = vec4(uColor * alpha, alpha);",
        "}"
      ].join("\n")
    });
    const sigilBand = new THREE.Mesh(new THREE.RingGeometry(5.15, 6.95, 96, 1), sigilBandMaterial);
    const bandUv = sigilBand.geometry.getAttribute("uv") as THREE.BufferAttribute;
    for (let j = 0; j <= 1; j += 1) {
      for (let i = 0; i <= 96; i += 1) {
        bandUv.setXY(j * 97 + i, i / 96, j);
      }
    }
    bandUv.needsUpdate = true;
    sigilBand.rotation.x = -Math.PI / 2;
    sigilBand.position.y = 0.026;
    sigilBand.visible = !isLobby;
    scene.add(sigilBand);
    disposables.push(sigilBand.geometry, sigilBandMaterial);

    // Ritual embers: born on the inscription, rising in a gentle inward
    // spiral. Height, pace, and brightness all scale with the charge.
    const RITUAL = 520;
    const ritualSeeds = new Float32Array(RITUAL * 4); // angle, phase, speed, radial jitter
    for (let i = 0; i < RITUAL; i += 1) {
      ritualSeeds[i * 4] = rand() * Math.PI * 2;
      ritualSeeds[i * 4 + 1] = rand();
      ritualSeeds[i * 4 + 2] = 0.5 + rand() * 0.7;
      ritualSeeds[i * 4 + 3] = (rand() - 0.5) * 0.9;
    }
    const ritualGeometry = new THREE.BufferGeometry();
    ritualGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(RITUAL * 3), 3));
    const ritualMaterial = new THREE.PointsMaterial({
      map: sparkTexture,
      color: brightColor,
      size: 0.055,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true
    });
    const ritual = new THREE.Points(ritualGeometry, ritualMaterial);
    ritual.visible = !isLobby;
    scene.add(ritual);
    disposables.push(ritualGeometry, ritualMaterial);

    /* -- the inscription readout (weaving) -----------------------------------
       Kicker, title, and the percent — drawn onto a canvas texture and
       billboarded at the sigil's near edge, so every readout lives inside the
       scene. It follows the camera's azimuth to always face the room. */
    const rootStyle = getComputedStyle(document.documentElement);
    const displayFont = rootStyle.getPropertyValue("--font-display").trim() || "serif";
    const readoutCanvas = document.createElement("canvas");
    readoutCanvas.width = 1024;
    readoutCanvas.height = 640;
    const readoutCtx = readoutCanvas.getContext("2d")!;
    const readoutTexture = new THREE.CanvasTexture(readoutCanvas);
    readoutTexture.colorSpace = THREE.SRGBColorSpace;
    readoutTexture.anisotropy = anisotropy;
    let drawnPercent = -1;
    let drawnTitle: string | null = null;
    const drawReadout = (pct: number, titleText: string) => {
      const ctx = readoutCtx;
      ctx.clearRect(0, 0, 1024, 640);
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      // Kicker — tracked-out micro label.
      ctx.font = `600 30px ${displayFont}`;
      try { (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = "10px"; } catch { /* older canvas */ }
      ctx.fillStyle = accentHex;
      ctx.globalAlpha = 0.85;
      ctx.shadowColor = accentHex;
      ctx.shadowBlur = 16;
      ctx.fillText(visual.copy.kicker.toUpperCase(), 512, 72);
      // Title — fitted to width.
      let size = 84;
      ctx.font = `700 ${size}px ${displayFont}`;
      while (size > 38 && ctx.measureText(titleText).width > 944) {
        size -= 4;
        ctx.font = `700 ${size}px ${displayFont}`;
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#f2ead8";
      ctx.shadowColor = "rgba(0, 0, 0, 0.9)";
      ctx.shadowBlur = 22;
      ctx.fillText(titleText, 512, 192);
      // The percent, burning big.
      try { (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = "0px"; } catch { /* older canvas */ }
      ctx.font = `700 300px ${displayFont}`;
      ctx.fillStyle = visual.accentBright;
      ctx.shadowColor = accentHex;
      ctx.shadowBlur = 42;
      ctx.fillText(String(pct), 512, 512);
      ctx.font = `600 58px ${displayFont}`;
      ctx.globalAlpha = 0.75;
      ctx.fillText("%", 512, 596);
      ctx.globalAlpha = 1;
      readoutTexture.needsUpdate = true;
    };
    // The display font may not be resolved on first draw (this scene can be
    // the page's only user of it) — redraw once it lands.
    document.fonts?.load(`700 100px ${displayFont}`).then(() => { drawnPercent = -1; }).catch(() => {});
    const readoutMaterial = new THREE.SpriteMaterial({
      map: readoutTexture,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false
    });
    const readout = new THREE.Sprite(readoutMaterial);
    readout.scale.set(4.4, 2.75, 1);
    readout.renderOrder = 20;
    readout.visible = !isLobby;
    // A child of the CAMERA, not the world: it holds one screen position no
    // matter how far the finale zooms in, so it can never be cropped.
    camera.add(readout);
    disposables.push(readoutTexture, readoutMaterial);

    /* -- the worldheart + light column -------------------------------------- */
    // The heart must hover clear of the tallest landmark — kits differ (the
    // noir tower reaches far past the fantasy spire), and no building may
    // pierce the orb. 1.7 ≈ outer wire radius × max heart scale.
    const worldTop = landmarks.reduce(
      (top, lm) => Math.max(top, new THREE.Box3().setFromObject(lm.group).max.y),
      0
    );
    const HEART_Y = Math.max(4.9, worldTop + 1.7 + 0.45);
    const heartLift = HEART_Y - 4.9;
    heartLight.position.y = HEART_Y;
    const heart = new THREE.Group();
    heart.position.set(0, HEART_Y, 0);
    scene.add(heart);
    const heartWireOuter = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1.25, 0)),
      new THREE.LineBasicMaterial({ color: secondaryColor, transparent: true, opacity: 0.22 })
    );
    const heartWireInner = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(0.85, 1)),
      new THREE.LineBasicMaterial({ color: accentColor, transparent: true, opacity: 0.55 })
    );
    const heartCore = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 12, 10),
      new THREE.MeshBasicMaterial({ color: brightColor })
    );
    heart.add(heartWireOuter, heartWireInner, heartCore);
    disposables.push(
      heartWireOuter.geometry, heartWireOuter.material as THREE.Material,
      heartWireInner.geometry, heartWireInner.material as THREE.Material,
      heartCore.geometry, heartCore.material as THREE.Material
    );
    const heartGlowTexture = makeGlowTexture(`rgba(${visual.loom.heart},0.85)`, `rgba(${visual.loom.heart},0)`);
    // depthTest off: the glow is light, not matter — geometry crossing its
    // billboard plane must never carve a hard silhouette out of it.
    const heartGlowMaterial = new THREE.SpriteMaterial({ map: heartGlowTexture, transparent: true, opacity: 0.5, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const heartGlow = new THREE.Sprite(heartGlowMaterial);
    heartGlow.scale.setScalar(6);
    heart.add(heartGlow);
    disposables.push(heartGlowTexture, heartGlowMaterial);

    const beamTexture = makeBeamTexture();
    const beamMaterial = new THREE.MeshBasicMaterial({
      map: beamTexture,
      color: accentColor,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide
    });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.6, HEART_Y - 0.6, 10, 1, true), beamMaterial);
    beam.position.y = 0.6 + (HEART_Y - 0.6) / 2;
    scene.add(beam);
    disposables.push(beamTexture, beam.geometry, beamMaterial);

    /* -- ascension rings: halos that ignite AROUND the whole island world ---
       Weaving-only spectacle that escalates with progress: each ring wakes as
       the weave crosses its threshold (with a spark burst at the heart), so
       the sky visibly gains structure the closer the world is to holding.
       They orbit OUTSIDE everything solid — inner radius clears the island +
       landmarks (~5.4) and the ground sigil (6.65), tilts stay shallow so the
       widest ring never dips below the foundation or up into the heart — so
       nothing ever clips through them. */
    const ascRings: Array<{ mesh: THREE.Mesh; material: THREE.MeshBasicMaterial; threshold: number; tilt: number; speed: number; phase: number; lit: boolean }> = [];
    const RING_Y = 2.3;
    for (let i = 0; i < 5; i += 1) {
      const geometry = new THREE.TorusGeometry(6.9 + i * 0.7, 0.016 + i * 0.004, 6, 128);
      const material = new THREE.MeshBasicMaterial({
        color: i % 2 ? secondaryColor : accentColor,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.y = RING_Y;
      mesh.visible = !isLobby;
      scene.add(mesh);
      ascRings.push({
        mesh,
        material,
        threshold: 0.18 + i * 0.16,
        tilt: (0.09 + i * 0.02) * (i % 2 ? -1 : 1),
        speed: (0.22 + i * 0.09) * (i % 2 ? -1 : 1),
        phase: i * 1.3,
        lit: false
      });
      disposables.push(geometry, material);
    }

    /* -- stardust vortex ----------------------------------------------------
       Contracts and accelerates as the world forges; at 100% what remains
       becomes the worldheart's halo. */
    const VORTEX = 2400;
    const vSeeds = new Float32Array(VORTEX * 4); // radius, phase, speed, yBase
    const vColors = new Float32Array(VORTEX * 3);
    const vPositions = new Float32Array(VORTEX * 3);
    const parchment = new THREE.Color("#e8dcc0");
    for (let i = 0; i < VORTEX; i += 1) {
      vSeeds[i * 4] = 2.4 + Math.pow(rand(), 0.72) * 9.6;
      vSeeds[i * 4 + 1] = rand() * Math.PI * 2;
      vSeeds[i * 4 + 2] = 0.35 + rand() * 1.1;
      vSeeds[i * 4 + 3] = (rand() - 0.5) * 7.5 + 2.4;
      const pick = rand();
      const color = pick < 0.55 ? accentColor : pick < 0.85 ? secondaryColor : parchment;
      vColors[i * 3] = color.r;
      vColors[i * 3 + 1] = color.g;
      vColors[i * 3 + 2] = color.b;
    }
    const vortexGeometry = new THREE.BufferGeometry();
    vortexGeometry.setAttribute("position", new THREE.BufferAttribute(vPositions, 3));
    vortexGeometry.setAttribute("color", new THREE.BufferAttribute(vColors, 3));
    const vortexMaterial = new THREE.PointsMaterial({
      map: sparkTexture,
      size: 0.055,
      vertexColors: true,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true
    });
    const vortex = new THREE.Points(vortexGeometry, vortexMaterial);
    scene.add(vortex);
    disposables.push(vortexGeometry, vortexMaterial);

    /* -- builder stream: motes arcing into whatever is being forged --------- */
    const STREAM = 210;
    const sSeeds = new Float32Array(STREAM * 2); // offset, speed
    const sPositions = new Float32Array(STREAM * 3);
    for (let i = 0; i < STREAM; i += 1) {
      sSeeds[i * 2] = rand();
      sSeeds[i * 2 + 1] = 0.45 + rand() * 0.5;
    }
    const streamGeometry = new THREE.BufferGeometry();
    streamGeometry.setAttribute("position", new THREE.BufferAttribute(sPositions, 3));
    const streamMaterial = new THREE.PointsMaterial({
      map: sparkTexture,
      color: brightColor,
      size: 0.09,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true
    });
    const stream = new THREE.Points(streamGeometry, streamMaterial);
    scene.add(stream);
    disposables.push(streamGeometry, streamMaterial);
    const streamTarget = new THREE.Vector3(0, HEART_Y, 0);

    /* -- energy draw: motes spiral in from the void to feed the worldheart --
       The heart visibly PULLS — particles are born far out in the dark and
       accelerate along a tightening spiral into it for the whole weave. */
    const DRAW = 320;
    const dSeeds = new Float32Array(DRAW * 4); // phase, speed, angle0, yScatter
    for (let i = 0; i < DRAW; i += 1) {
      dSeeds[i * 4] = rand();
      dSeeds[i * 4 + 1] = 0.14 + rand() * 0.2;
      dSeeds[i * 4 + 2] = rand() * Math.PI * 2;
      dSeeds[i * 4 + 3] = (rand() - 0.5) * 7;
    }
    const drawGeometry = new THREE.BufferGeometry();
    drawGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(DRAW * 3), 3));
    const drawMaterial = new THREE.PointsMaterial({
      map: sparkTexture,
      color: brightColor,
      size: 0.07,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true
    });
    const draw = new THREE.Points(drawGeometry, drawMaterial);
    scene.add(draw);
    disposables.push(drawGeometry, drawMaterial);

    /* -- lock-in spark bursts (pooled) -------------------------------------- */
    const BURSTS = 8;
    const BURST_PARTICLES = 42;
    type Burst = { points: THREE.Points; material: THREE.PointsMaterial; dirs: Float32Array; origin: THREE.Vector3; age: number; alive: boolean };
    const bursts: Burst[] = [];
    for (let b = 0; b < BURSTS; b += 1) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(BURST_PARTICLES * 3), 3));
      const material = new THREE.PointsMaterial({
        map: sparkTexture,
        color: brightColor,
        size: 0.12,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true
      });
      const dirs = new Float32Array(BURST_PARTICLES * 3);
      const points = new THREE.Points(geometry, material);
      points.visible = false;
      scene.add(points);
      bursts.push({ points, material, dirs, origin: new THREE.Vector3(), age: 0, alive: false });
      disposables.push(geometry, material);
    }
    const spawnBurst = (at: THREE.Vector3) => {
      const burst = bursts.find((b) => !b.alive) || bursts[0];
      burst.origin.copy(at);
      for (let i = 0; i < BURST_PARTICLES; i += 1) {
        const u = rand() * 2 - 1;
        const phi = rand() * Math.PI * 2;
        const s = Math.sqrt(1 - u * u);
        burst.dirs[i * 3] = s * Math.cos(phi);
        burst.dirs[i * 3 + 1] = Math.abs(u) * 0.8 + 0.2;
        burst.dirs[i * 3 + 2] = s * Math.sin(phi);
      }
      burst.age = 0;
      burst.alive = true;
      burst.points.visible = true;
    };

    /* -- ambient weather: the theme's air ----------------------------------- */
    const WEATHER = 440;
    const wSeeds = new Float32Array(WEATHER * 4); // x, z, yPhase, sway
    const wPositions = new Float32Array(WEATHER * 3);
    for (let i = 0; i < WEATHER; i += 1) {
      wSeeds[i * 4] = (rand() - 0.5) * 26;
      wSeeds[i * 4 + 1] = (rand() - 0.5) * 26;
      wSeeds[i * 4 + 2] = rand() * 11;
      wSeeds[i * 4 + 3] = rand() * Math.PI * 2;
    }
    const weatherGeometry = new THREE.BufferGeometry();
    weatherGeometry.setAttribute("position", new THREE.BufferAttribute(wPositions, 3));
    const weatherMaterial = new THREE.PointsMaterial({
      map: sparkTexture,
      color: new THREE.Color(visual.dust.color),
      size: visual.dust.size * 1.4,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true
    });
    const weather = new THREE.Points(weatherGeometry, weatherMaterial);
    scene.add(weather);
    disposables.push(weatherGeometry, weatherMaterial);
    // rise > 0: embers float up; rise < 0: rain/ash falls; 0: motes drift.
    const weatherSpeed = motion.rise === 0 ? 0.25 : Math.abs(motion.rise) * 2.2;
    const weatherUp = motion.rise > 0 ? 1 : motion.rise < 0 ? -1 : 1;

    /* -- deep sky ------------------------------------------------------------ */
    const STARS = 850;
    const starPositions = new Float32Array(STARS * 3);
    for (let i = 0; i < STARS; i += 1) {
      starPositions[i * 3] = (rand() - 0.5) * 90;
      starPositions[i * 3 + 1] = (rand() - 0.5) * 50 + 6;
      starPositions[i * 3 + 2] = -12 - rand() * 60;
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    const starMaterial = new THREE.PointsMaterial({ color: 0xcfd6ee, size: 0.06, transparent: true, opacity: 0.55, depthWrite: false, sizeAttenuation: true });
    scene.add(new THREE.Points(starGeometry, starMaterial));
    disposables.push(starGeometry, starMaterial);

    const nebulae: THREE.Sprite[] = [];
    [visual.nebulae[0], visual.nebulae[1]].forEach((hex, index) => {
      const color = new THREE.Color(hex);
      const rgba = (alpha: number) => `rgba(${Math.round(color.r * 255)},${Math.round(color.g * 255)},${Math.round(color.b * 255)},${alpha})`;
      const texture = makeGlowTexture(rgba(0.24), rgba(0));
      const material = new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 0.4, depthWrite: false, blending: THREE.AdditiveBlending });
      const sprite = new THREE.Sprite(material);
      sprite.position.set(index === 0 ? -16 : 15, index === 0 ? 9 : -2, -30 - index * 6);
      sprite.scale.setScalar(30 + index * 8);
      scene.add(sprite);
      nebulae.push(sprite);
      disposables.push(texture, material);
    });

    /* -- finale: shockwave ring + flash ------------------------------------- */
    const shockMaterial = new THREE.MeshBasicMaterial({ color: brightColor, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    const shock = new THREE.Mesh(new THREE.TorusGeometry(1, 0.05, 8, 96), shockMaterial);
    shock.rotation.x = -Math.PI / 2;
    shock.position.y = 0.05;
    shock.visible = false;
    scene.add(shock);
    disposables.push(shock.geometry, shockMaterial);
    const flashMaterial = new THREE.SpriteMaterial({ map: heartGlowTexture, transparent: true, opacity: 0, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const flash = new THREE.Sprite(flashMaterial);
    flash.position.set(0, 3, 0);
    flash.scale.setScalar(1);
    scene.add(flash);
    disposables.push(flashMaterial);

    /* -- progress ripples: a ground ring races outward each eighth of the
       weave, so every stretch of progress lands as a visible pulse. -------- */
    const ripples: Array<{ mesh: THREE.Mesh; material: THREE.MeshBasicMaterial; age: number; alive: boolean }> = [];
    for (let i = 0; i < 3; i += 1) {
      const material = new THREE.MeshBasicMaterial({
        color: accentColor,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide
      });
      const mesh = new THREE.Mesh(new THREE.TorusGeometry(1, 0.035, 6, 72), material);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.06;
      mesh.visible = false;
      scene.add(mesh);
      ripples.push({ mesh, material, age: 0, alive: false });
      disposables.push(mesh.geometry, material);
    }
    let rippleStep = 0;
    const spawnRipple = () => {
      const ripple = ripples.find((r) => !r.alive) || ripples[0];
      ripple.age = 0;
      ripple.alive = true;
      ripple.mesh.visible = true;
    };

    /* -- pointer parallax ---------------------------------------------------- */
    const pointer = { x: 0, y: 0 };
    const onPointerMove = (event: PointerEvent) => {
      pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
      pointer.y = (event.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener("pointermove", onPointerMove);

    const resize = () => {
      const { clientWidth, clientHeight } = mount;
      renderer.setSize(clientWidth, clientHeight, false);
      camera.aspect = clientWidth / Math.max(clientHeight, 1);
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(mount);

    /* -- animation ------------------------------------------------------------ */
    const clock = new THREE.Clock();
    const flavor = AUDIO_FLAVOR[visual.key] || AUDIO_FLAVOR.none;
    let frame = 0;
    let smoothP = isLobby ? 0 : Math.min(0.04, progressRef.current);
    let finaleT = -1;
    let freqData: Uint8Array<ArrayBuffer> | null = null;
    let musicLevel = 0;
    // Beat tracker: bass onsets fire the ground pulse (and kick the heart +
    // sigil) on the music's actual beat. Fires on a rising edge over a slow
    // envelope — with a TIGHT margin so it catches real kicks readily, not
    // just the loudest spikes — and a tempo catch-up guarantees a pulse at
    // least every ~1s while music plays. With no analyser it falls back to a
    // quiet metronome.
    let bassPrev = 0;
    let bassAvg = 0;
    let beatCool = 0;
    let beatKick = 0;
    let pulseT = 1;
    let lastBeatAt = -10;
    // Mid/treble bands + the riff detector (mid-band onsets): each genre's
    // AUDIO_FLAVOR routes these into its own channels.
    let midLevel = 0;
    let trebleLevel = 0;
    let midAvg = 0;
    let midCool = 0;
    let midKick = 0;
    // Accumulated phases, so band-driven speed changes never jump the pattern.
    let weatherPhase = 0;
    let gridSpin = 0;
    let sigilSpin = 0;
    let ritualPhase = 0;
    const tmp = new THREE.Vector3();
    const tmpB = new THREE.Vector3();
    const emitter = new THREE.Vector3();

    const renderFrame = () => {
      const dt = Math.min(clock.getDelta(), 0.05);
      const t = clock.elapsedTime;
      const charge = isLobby ? clamp01(dramaRef.current) : 0;

      // Progress eases toward the live value and never regresses. Rate-capped
      // so a remount mid-weave (theme swap, reload) builds up instead of
      // snapping the world together.
      if (!isLobby) {
        const step = (Math.max(smoothP, clamp01(progressRef.current)) - smoothP) * Math.min(1, dt * 1.6);
        smoothP += Math.min(step, dt * 0.12);
      }
      const p = smoothP;

      // Music drive from the shared BGM analyser (silent fallback: slow sine).
      const analyser = bgmGetAnalyser();
      beatCool -= dt;
      midCool -= dt;
      let beatNow = false;
      if (analyser) {
        if (!freqData || freqData.length !== analyser.frequencyBinCount) {
          freqData = new Uint8Array(analyser.frequencyBinCount);
        }
        analyser.getByteFrequencyData(freqData);
        const nBins = freqData.length;
        const band = (from: number, to: number) => {
          const a = Math.floor(nBins * from);
          const b = Math.max(a + 1, Math.floor(nBins * to));
          let sum = 0;
          for (let i = a; i < b; i += 1) sum += freqData![i];
          return sum / ((b - a) * 255);
        };
        const bass = band(0, 0.09);
        const mid = band(0.1, 0.42);
        const treble = band(0.45, 0.9);
        musicLevel += (band(0, 0.25) - musicLevel) * Math.min(1, dt * 8);
        midLevel += (mid - midLevel) * Math.min(1, dt * 7);
        trebleLevel += (treble - trebleLevel) * Math.min(1, dt * 7);
        // Beat: a rising bass edge over its slow envelope. The margin is
        // barely above the average at all — almost any local rise qualifies —
        // and the average itself re-catches quickly after each hit so the
        // NEXT beat doesn't need to wait for a quiet gap first. A short tempo
        // catch-up backstops the rest: the pulse should read as frequent even
        // on material the transient detector doesn't cleanly catch.
        bassAvg += (bass - bassAvg) * Math.min(1, dt * 1.8);
        const rising = bass - bassPrev > 0.006;
        bassPrev += (bass - bassPrev) * Math.min(1, dt * 14);
        if (beatCool <= 0 && bass > 0.045 && rising && bass > bassAvg * 1.03 + 0.004) beatNow = true;
        if (beatCool <= 0 && !beatNow && musicLevel > 0.04 && t - lastBeatAt > 0.8) beatNow = true;
        // The riff: mid-band onsets (stabs, snares, lead hits) — same loose
        // margin, so a genre's riff (postapoc's especially) reads as a beat
        // of its own instead of an occasional accent.
        midAvg += (mid - midAvg) * Math.min(1, dt * 1.8);
        if (midCool <= 0 && mid > 0.05 && mid > midAvg * 1.04 + 0.003) {
          midKick = 1;
          midCool = 0.16;
        }
      } else {
        musicLevel += ((0.22 + Math.sin(t * 0.9) * 0.1) - musicLevel) * Math.min(1, dt * 2);
        midLevel += ((0.16 + Math.sin(t * 0.63 + 1.2) * 0.08) - midLevel) * Math.min(1, dt * 2);
        trebleLevel += ((0.12 + Math.sin(t * 1.1 + 2.4) * 0.06) - trebleLevel) * Math.min(1, dt * 2);
        if (beatCool <= 0 && t - lastBeatAt >= 1.9) beatNow = true;
      }
      if (beatNow) {
        beatCool = 0.14;
        lastBeatAt = t;
        pulseT = 0;
        beatKick = 1;
      }
      pulseT = Math.min(1.2, pulseT + dt / 0.95);
      // Snappier decay on both kicks — an instant attack (set to 1 on
      // detection) with a fast fade reads as a hit, not a slow swell.
      beatKick = Math.max(0, beatKick - dt * 3.6);
      midKick = Math.max(0, midKick - dt * 3.2);
      const surge = midKick * flavor.surge;

      // Theme light gutter — layered sines so candlelight sputters organically,
      // plus the flavor's sag: horror candles and wasteland reactors strain
      // under the music's swells.
      let gutter = 1;
      if (motion.flicker > 0) {
        const g = Math.sin(t * 11.3) * Math.sin(t * 5.1 + 1.7) * Math.sin(t * 2.3 + 4.2);
        gutter = 1 - motion.flicker * (0.12 + 0.3 * Math.max(0, g));
      }
      if (flavor.sag > 0) gutter *= 1 - Math.min(0.35, flavor.sag * midLevel * 0.3);

      /* landmarks: drift → tractor in → lock → materialize ------------------ */
      let frontier: Landmark | null = null;
      for (const lm of landmarks) {
        const k = isLobby ? 0 : clamp01((p - lm.windowStart) / lm.windowWidth);
        const flight = easeOutCubic(Math.min(1, k / 0.62));
        const m = easeInOutCubic(clamp01((k - 0.58) / 0.42));
        if (!frontier && k > 0 && k < 1) frontier = lm;

        if (flight < 1) {
          // Ghost orbit out in the dark; the tractor arc blends home from it.
          const angle = lm.seed * Math.PI * 2 + t * 0.05 * motion.swirl * lm.dir;
          const bob = Math.sin(t * 0.5 + lm.seed * 9) * (0.5 + motion.wobble * 0.25);
          tmp.set(
            Math.cos(angle) * lm.orbitRadius,
            lm.orbitY + bob,
            Math.sin(angle) * lm.orbitRadius
          );
          lm.group.position.lerpVectors(tmp, lm.anchor, flight);
          // A rising arc so fragments swoop in instead of beelining.
          lm.group.position.y += Math.sin(flight * Math.PI) * 1.6;
          const tumble = (1 - flight) * (0.6 + motion.wobble * 0.4);
          lm.group.rotation.set(
            Math.sin(t * 0.31 + lm.seed * 7) * tumble,
            t * 0.23 * lm.dir * tumble + lm.seed * 6,
            Math.cos(t * 0.27 + lm.seed * 4) * tumble
          );
          // Rotation eases to true as it docks.
          lm.group.rotation.x *= 1 - flight;
          lm.group.rotation.z *= 1 - flight;
          if (flight > 0.9) lm.group.rotation.y *= 1 - flight;
        } else {
          lm.group.position.copy(lm.anchor);
          lm.group.rotation.set(0, 0, 0);
          if (lm.float) {
            // Shards and drones never quite settle.
            lm.group.position.y += Math.sin(t * 0.8 + lm.seed * 5) * 0.22;
            lm.group.rotation.y = t * 0.25 * lm.dir;
          }
          if (!lm.locked && !isLobby) {
            lm.locked = true;
            lm.flash = 1;
            spawnBurst(tmpB.copy(lm.anchor).setY(lm.anchor.y + 0.8));
          }
        }

        lm.flash = Math.max(0, lm.flash - dt * 2.2);
        const ghostGlow = isLobby
          ? 0.1 + charge * 0.1 + musicLevel * 0.06
          : 0.14 + musicLevel * 0.05;
        const wireAlpha =
          m > 0
            ? THREE.MathUtils.lerp(0.9, 0.16, m)
            : flight > 0
              ? THREE.MathUtils.lerp(0.25, 0.9, flight)
              : ghostGlow;
        lm.wireMaterial.opacity = clamp01(wireAlpha * visual.loom.wireBoost + lm.flash * 0.6) * gutter;

        const showMatter = m > 0.002;
        if (showMatter !== lm.matter[0].visible) {
          for (const mesh of lm.matter) mesh.visible = showMatter;
        }
        lm.uniforms.uReveal.value = m;
        lm.uniforms.uEdgeGain.value = 1.3 + musicLevel * 1.6 + lm.flash * 2;
      }

      /* spark bursts --------------------------------------------------------- */
      for (const burst of bursts) {
        if (!burst.alive) continue;
        burst.age += dt;
        const k = burst.age / 0.85;
        if (k >= 1) {
          burst.alive = false;
          burst.points.visible = false;
          continue;
        }
        const radius = easeOutCubic(k) * 1.9;
        const attr = burst.points.geometry.getAttribute("position") as THREE.BufferAttribute;
        for (let i = 0; i < BURST_PARTICLES; i += 1) {
          attr.setXYZ(
            i,
            burst.origin.x + burst.dirs[i * 3] * radius,
            burst.origin.y + burst.dirs[i * 3 + 1] * radius - k * k * 0.7,
            burst.origin.z + burst.dirs[i * 3 + 2] * radius
          );
        }
        attr.needsUpdate = true;
        burst.material.opacity = (1 - k) * 0.95;
      }

      /* ascension rings -------------------------------------------------------- */
      if (!isLobby) {
        for (const halo of ascRings) {
          const on = p >= halo.threshold;
          if (on && !halo.lit) {
            halo.lit = true;
            spawnBurst(tmpB.set(0, HEART_Y, 0));
          }
          const target = on
            ? (0.13 + 0.28 * easeOutCubic(clamp01((p - halo.threshold) / 0.1))) * (0.75 + musicLevel * 0.7 + beatKick * 0.5 + surge * 0.55)
            : 0;
          halo.material.opacity += (target * gutter - halo.material.opacity) * Math.min(1, dt * 2.4);
          // Near-flat planetary rings with a slow, shallow precession — the
          // tilt is capped so the widest ring stays clear of ground and heart.
          // Spin rides an accumulated phase so treble can speed it up (scifi
          // rings race, horror barely turns) without the ring ever jumping.
          halo.phase += dt * halo.speed * (0.35 + p * 0.65) * (1 + trebleLevel * flavor.spin * 1.6);
          halo.mesh.rotation.set(
            Math.PI / 2 + Math.sin(t * 0.22 + halo.tilt * 9) * halo.tilt,
            halo.phase,
            Math.cos(t * 0.19 + halo.tilt * 5) * halo.tilt * 0.5
          );
          halo.mesh.scale.setScalar(1 + musicLevel * 0.03 + beatKick * 0.025);
        }
      }

      /* progress ripples -------------------------------------------------------- */
      const rippleIndex = Math.floor(p * 8);
      if (!isLobby && rippleIndex > rippleStep) {
        rippleStep = rippleIndex;
        if (p > 0.05 && p < 0.98) spawnRipple();
      }
      for (const ripple of ripples) {
        if (!ripple.alive) continue;
        ripple.age += dt;
        const k = ripple.age / 1.6;
        if (k >= 1) {
          ripple.alive = false;
          ripple.mesh.visible = false;
          continue;
        }
        const s = 1 + easeOutCubic(k) * 10.5;
        ripple.mesh.scale.set(s, s, 1);
        ripple.material.opacity = (1 - k) * 0.45;
      }

      /* stardust vortex ------------------------------------------------------- */
      const contraction = isLobby ? charge * 0.12 : easeInOutCubic(p) * 0.72;
      const vortexSpeed = (isLobby ? 0.45 + charge * 0.5 : 0.5 + p * 1.9) * motion.swirl;
      const vAttr = vortexGeometry.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < VORTEX; i += 1) {
        const radius = vSeeds[i * 4] * (1 - contraction);
        const angle = vSeeds[i * 4 + 1] + vSeeds[i * 4] * 0.22 + t * vSeeds[i * 4 + 2] * vortexSpeed * 0.4;
        const yBase = vSeeds[i * 4 + 3];
        // Dust lifts toward the worldheart as the world completes.
        const y = THREE.MathUtils.lerp(yBase, HEART_Y + (yBase - 2.4) * 0.35, isLobby ? 0 : easeInOutCubic(p) * 0.85)
          + Math.sin(t * 1.1 + i * 0.7) * 0.06;
        vAttr.setXYZ(i, Math.cos(angle) * radius, y, Math.sin(angle) * radius);
      }
      vAttr.needsUpdate = true;
      vortexMaterial.opacity = (isLobby ? 0.4 + charge * 0.2 : 0.55 - easeInOutCubic(p) * 0.25) * (0.8 + musicLevel * 0.4) * gutter;
      // The dust burns brighter-per-mote as it contracts toward the heart,
      // and sparkles with the music's high end.
      vortexMaterial.size = 0.055 * (1 + (isLobby ? charge * 0.3 : p * 0.9)) * (1 + trebleLevel * flavor.twinkle * 0.35);

      /* builder stream --------------------------------------------------------- */
      const streamOn = !isLobby && frontier !== null && p < 0.97;
      streamMaterial.opacity += ((streamOn ? 0.85 : 0) - streamMaterial.opacity) * Math.min(1, dt * 3);
      if (streamMaterial.opacity > 0.02) {
        if (frontier) streamTarget.lerp(tmpB.copy(frontier.anchor).setY(frontier.anchor.y + 1), Math.min(1, dt * 4));
        emitter.set(Math.cos(t * 0.6) * 8, 6 + Math.sin(t * 0.9) * 0.9, Math.sin(t * 0.6) * 8);
        const sAttr = streamGeometry.getAttribute("position") as THREE.BufferAttribute;
        for (let i = 0; i < STREAM; i += 1) {
          const u = (sSeeds[i * 2] + t * sSeeds[i * 2 + 1] * 0.4) % 1;
          const inv = 1 - u;
          // Quadratic bezier: emitter → lifted midpoint → frontier anchor.
          const midX = (emitter.x + streamTarget.x) * 0.5;
          const midY = Math.max(emitter.y, streamTarget.y) + 2.4;
          const midZ = (emitter.z + streamTarget.z) * 0.5;
          const jitter = Math.sin(i * 37.7) * 0.3 * inv;
          sAttr.setXYZ(
            i,
            inv * inv * emitter.x + 2 * inv * u * midX + u * u * streamTarget.x + jitter,
            inv * inv * emitter.y + 2 * inv * u * midY + u * u * streamTarget.y + Math.cos(i * 21.3) * 0.3 * inv,
            inv * inv * emitter.z + 2 * inv * u * midZ + u * u * streamTarget.z + jitter
          );
        }
        sAttr.needsUpdate = true;
      }

      /* energy draw ------------------------------------------------------------ */
      const drawAlpha = isLobby
        ? charge * 0.3
        : (0.42 + p * 0.45 + musicLevel * 0.35) * (1 - easeInOutCubic(clamp01((p - 0.92) / 0.08)) * 0.8);
      drawMaterial.opacity += (drawAlpha * gutter - drawMaterial.opacity) * Math.min(1, dt * 2);
      if (drawMaterial.opacity > 0.02) {
        const dAttr = drawGeometry.getAttribute("position") as THREE.BufferAttribute;
        for (let i = 0; i < DRAW; i += 1) {
          const u = (dSeeds[i * 4] + t * dSeeds[i * 4 + 1]) % 1;
          const pull = u * u; // accelerates as the heart's grip tightens
          const radius = 13.5 - 13.1 * pull;
          const angle = dSeeds[i * 4 + 2] + u * 2.8 * motion.swirl + t * 0.04;
          const y = THREE.MathUtils.lerp(HEART_Y + dSeeds[i * 4 + 3], HEART_Y, pull);
          dAttr.setXYZ(i, Math.cos(angle) * radius, y, Math.sin(angle) * radius);
        }
        dAttr.needsUpdate = true;
      }

      /* weather ---------------------------------------------------------------- */
      // The mids drive the weather's pace (noir rain pours with the score,
      // ash rides the swells) via an accumulated phase — no speed jumps —
      // and treble makes the motes themselves glint.
      weatherPhase += dt * weatherSpeed * (1 + midLevel * flavor.rush * 1.4);
      weatherMaterial.size = visual.dust.size * 1.4 * (1 + trebleLevel * flavor.twinkle * 0.5);
      const weatherAlpha = isLobby ? 0.3 + charge * 0.15 : clamp01((p - 0.2) / 0.25) * (0.35 + p * 0.35);
      weatherMaterial.opacity += (weatherAlpha * gutter - weatherMaterial.opacity) * Math.min(1, dt * 2);
      if (weatherMaterial.opacity > 0.02) {
        const wAttr = weatherGeometry.getAttribute("position") as THREE.BufferAttribute;
        for (let i = 0; i < WEATHER; i += 1) {
          const y = ((wSeeds[i * 4 + 2] + weatherPhase * weatherUp) % 11 + 11) % 11;
          wAttr.setXYZ(
            i,
            wSeeds[i * 4] + Math.sin(t * 0.5 + wSeeds[i * 4 + 3]) * (0.4 + motion.wobble * 0.4),
            y - 1.5,
            wSeeds[i * 4 + 1] + Math.cos(t * 0.4 + wSeeds[i * 4 + 3]) * 0.4
          );
        }
        wAttr.needsUpdate = true;
      }

      /* debris ---------------------------------------------------------------- */
      for (const piece of debris) {
        const angle = piece.seed + t * 0.03 * piece.speed;
        piece.line.position.set(Math.cos(angle) * piece.radius, piece.y + Math.sin(t * 0.4 + piece.seed) * 0.5, Math.sin(angle) * piece.radius);
        piece.line.rotation.set(t * 0.2 * piece.speed, t * 0.16 * piece.speed, 0);
      }
      debrisMaterial.opacity = (0.08 + musicLevel * 0.05) * gutter;

      /* theme emblems ---------------------------------------------------------- */
      for (const emblem of emblems) {
        const angle = emblem.phase + t * 0.055 * emblem.dir * (0.5 + motion.swirl * 0.5);
        emblem.group.position.set(
          Math.cos(angle) * emblem.radius,
          emblem.y + Math.sin(t * 0.45 + emblem.phase) * 0.5,
          Math.sin(angle) * emblem.radius
        );
        emblem.group.rotation.y = t * 0.18 * emblem.dir;
        emblem.group.rotation.z = Math.sin(t * 0.33 + emblem.phase) * (0.1 + motion.wobble * 0.06);
        const target = isLobby ? 0.2 + charge * 0.25 : 0.22 + p * 0.35;
        emblem.material.opacity += ((target + musicLevel * 0.15 + surge * 0.3) * gutter - emblem.material.opacity) * Math.min(1, dt * 2);
      }

      /* foundation, ritual sigil, heart, beam ----------------------------------- */
      gridUniforms.uTime.value = t;
      // Spokes drift on an accumulated phase; treble spins them up.
      gridSpin += dt * 0.012 * (1 + trebleLevel * flavor.spin * 2);
      gridUniforms.uSpin.value = gridSpin;
      const buildEnergy = isLobby ? 0.3 + charge * 0.35 : 0.45 + p * 0.55 - easeInOutCubic(clamp01((p - 0.9) / 0.1)) * 0.6;
      gridUniforms.uEnergy.value = (buildEnergy + musicLevel * 0.2) * gutter;
      // The ground ripple rides the beat tracker: born at the center on each
      // onset, racing outward and fading.
      gridUniforms.uPulseR.value = easeOutCubic(clamp01(pulseT)) * 17;
      gridUniforms.uPulseA.value = (1 - clamp01(pulseT)) * (0.85 + musicLevel * 0.7);

      // The ritual circle turns — and spins up as it charges. Base inscription
      // stays dim; the glow overlay above it carries the charge.
      sigilSpin += dt * 0.04 * motion.ringSpeed * (1 + (isLobby ? 0 : p * 1.4));
      glyphRing.rotation.z = sigilSpin;
      glyphMaterial.opacity = (isLobby ? 0.2 + charge * 0.12 : 0.16 + musicLevel * 0.05) * gutter;

      if (!isLobby) {
        // The whole inscription charges with progress — every glyph glowing,
        // kicked by the beat, flared by the riff.
        sigilGlow.rotation.z = sigilSpin;
        sigilUniforms.uCharge.value = p;
        sigilUniforms.uTime.value = t;
        sigilUniforms.uBeat.value = beatKick;
        sigilUniforms.uSurge.value = surge;
        sigilBandUniforms.uCharge.value = p * gutter;
        sigilBandUniforms.uBeat.value = beatKick;

        // Ritual embers: the curtain rises taller, denser, and faster the
        // closer the world is to holding.
        ritualPhase += dt * (0.3 + p * 0.9) * (1 + midLevel * 0.35);
        const ritualTarget = p > 0.02 ? p * 0.8 * (0.75 + musicLevel * 0.5) * gutter : 0;
        ritualMaterial.opacity += (ritualTarget - ritualMaterial.opacity) * Math.min(1, dt * 2);
        ritualMaterial.size = 0.05 + p * 0.03 + trebleLevel * flavor.twinkle * 0.02;
        if (ritualMaterial.opacity > 0.02) {
          const riseH = 2.2 + p * 3.0;
          const rAttr = ritualGeometry.getAttribute("position") as THREE.BufferAttribute;
          for (let i = 0; i < RITUAL; i += 1) {
            const u = (ritualSeeds[i * 4 + 1] + ritualPhase * ritualSeeds[i * 4 + 2]) % 1;
            const ang = ritualSeeds[i * 4] + t * 0.06 * motion.swirl + u * 0.8;
            const rad = 6.05 + ritualSeeds[i * 4 + 3] * (1 - u * 0.55);
            rAttr.setXYZ(i, Math.cos(ang) * rad, 0.05 + u * riseH, Math.sin(ang) * rad);
          }
          rAttr.needsUpdate = true;
        }
      }

      const breath = Math.sin(t * 1.6) * 0.05;
      const heartScale = isLobby
        ? 0.45 + charge * 0.22 + breath * 0.5
        : Math.max(0.08, 0.28 + p * 1.0 + breath * p);
      heart.scale.setScalar(heartScale);
      heart.rotation.y = t * 0.3;
      heartWireOuter.rotation.x = t * 0.21;
      heartWireOuter.rotation.z = -t * 0.13;
      heartWireInner.rotation.x = -t * 0.17;
      heartCore.scale.setScalar(1 + Math.sin(t * 2.4) * 0.12 + musicLevel * 0.25 + beatKick * 0.32);
      heartGlowMaterial.opacity = (0.35 + musicLevel * 0.4 + (isLobby ? charge * 0.15 : p * 0.25)) * gutter;
      heartLight.intensity = (isLobby ? 4 + charge * 8 : 4 + p * 22) * gutter + musicLevel * 16 + beatKick * 11 + surge * 16;

      beamMaterial.opacity = ((isLobby ? 0.08 + charge * 0.1 : 0.1 + p * 0.3 - easeInOutCubic(clamp01((p - 0.92) / 0.08)) * 0.25) + musicLevel * 0.12) * gutter;
      beam.rotation.y = t * 0.5;

      /* finale ------------------------------------------------------------------ */
      if (!isLobby && p >= 0.985 && finaleT < 0) {
        finaleT = 0;
        shock.visible = true;
        spawnBurst(tmpB.set(0, 1.4, 0));
      }
      if (finaleT >= 0) {
        finaleT += dt;
        const k = finaleT / 1.2;
        if (k <= 1) {
          const s = 0.6 + easeOutCubic(k) * 15;
          shock.scale.set(s, s, 1);
          shockMaterial.opacity = (1 - k) * 0.8;
          flashMaterial.opacity = Math.exp(-k * 3.4) * 1.1;
          flash.scale.setScalar(8 + easeOutCubic(k) * 26);
          heartLight.intensity += 42 * (1 - k);
        } else {
          shock.visible = false;
          shockMaterial.opacity = 0;
          flashMaterial.opacity = 0;
        }
      }

      /* camera ------------------------------------------------------------------ */
      const orbit = t * (isLobby ? 0.35 : 1) * motion.orbit + Math.PI * 0.35;
      // heartLift widens the end framing so the raised heart stays in shot.
      const radius = isLobby
        ? 17 - charge * 1.2
        : 17.5 - easeOutCubic(p) * Math.max(2.5, 6 - heartLift * 0.9) - musicLevel * 0.4;
      const height = isLobby ? 5.4 : 5.6 - p * Math.max(0.8, 2.2 - heartLift * 0.35);
      const dampXY = 1 - Math.exp(-dt * 2.2);
      const dampZ = 1 - Math.exp(-dt * 1.2);
      tmp.set(
        Math.sin(orbit) * radius + pointer.x * 1.1,
        height + Math.sin(t * 0.2) * 0.35 - pointer.y * 0.8,
        Math.cos(orbit) * radius
      );
      camera.position.x += (tmp.x - camera.position.x) * dampXY;
      camera.position.y += (tmp.y - camera.position.y) * dampXY;
      camera.position.z += (tmp.z - camera.position.z) * dampZ;
      camera.lookAt(0, 1.4 + (isLobby ? 0.4 + heartLift * 0.12 : p * (1.1 + heartLift * 0.45)), 0);

      /* the inscription readout ------------------------------------------------- */
      if (!isLobby) {
        // Redraw only when the count or the title actually changes (a sealed
        // campaign reveals its true title mid-finale).
        const percent = p > 0.993 ? 100 : Math.min(99, Math.floor(p * 100));
        if (percent !== drawnPercent || titleRef.current !== drawnTitle) {
          drawnPercent = percent;
          drawnTitle = titleRef.current;
          drawReadout(percent, drawnTitle || "");
        }
        // Camera-space anchor pinned to the bottom of the frame: distance is
        // chosen so the block always fits horizontally, and the y drops it to
        // the frustum's lower edge with a fixed margin — no zoom can crop it.
        const halfV = Math.tan((camera.fov * Math.PI) / 360);
        const halfH = halfV * camera.aspect;
        const readoutDist = Math.max(7.2, 2.5 / Math.max(halfH, 0.15));
        readout.position.set(0, -(readoutDist * halfV - 1.55) + Math.sin(t * 0.9) * 0.04, -readoutDist);
        const finaleGlow = finaleT >= 0 && finaleT <= 1.2 ? (1.2 - finaleT) * 0.35 : 0;
        readoutMaterial.opacity += (0.96 - readoutMaterial.opacity) * Math.min(1, dt * 1.4);
        const readoutScale = 1 + finaleGlow * 0.12 + beatKick * 0.012;
        readout.scale.set(4.4 * readoutScale, 2.75 * readoutScale, 1);
      }

      renderer.render(scene, camera);
    };

    if (reducedMotion) {
      // A still frame: the world as built as progress says, no animation —
      // with the readout and ritual at full strength, since there's no
      // fade-in to ride.
      smoothP = isLobby ? 0 : Math.max(0.6, progressRef.current);
      if (!isLobby) {
        readoutMaterial.opacity = 0.96;
        ritualMaterial.opacity = smoothP * 0.7;
      }
      renderFrame();
    } else {
      const loop = () => {
        renderFrame();
        frame = requestAnimationFrame(loop);
      };
      frame = requestAnimationFrame(loop);
    }

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      renderer.dispose();
      for (const item of disposables) item.dispose();
      if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement);
    };
  }, [accent, theme, mode]);

  return <div ref={mountRef} className="cosmos-canvas" aria-hidden />;
}
