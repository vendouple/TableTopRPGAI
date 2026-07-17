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
   the world holds. The campaign theme recolors the palette, re-letters the
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
  theme = "none"
}: {
  /** "lobby": the unforged fragments drift, charged by `drama`. "weaving": `progress` assembles the world. */
  mode?: "lobby" | "weaving";
  /** 0..1, monotonic — how much of the world is forged. */
  progress?: number;
  /** Lobby charge (players seated); 0..1-ish. */
  drama?: number;
  accent?: string;
  theme?: ThemeKey | string | null;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef(progress);
  progressRef.current = progress;
  const dramaRef = useRef(drama);
  dramaRef.current = drama;

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

    /* -- far debris: never assembles, pure depth dressing ------------------ */
    const debris: Array<{ line: THREE.LineSegments; radius: number; y: number; seed: number; speed: number }> = [];
    const debrisMaterial = new THREE.LineBasicMaterial({ color: accentColor, transparent: true, opacity: 0.1 });
    disposables.push(debrisMaterial);
    for (let i = 0; i < 10; i += 1) {
      const geometry = new THREE.EdgesGeometry(new THREE.TetrahedronGeometry(0.22 + rand() * 0.3, 0));
      const line = new THREE.LineSegments(geometry, debrisMaterial);
      scene.add(line);
      debris.push({ line, radius: 15 + rand() * 9, y: 1 + rand() * 8, seed: rand() * Math.PI * 2, speed: 0.35 + rand() * 0.6 });
      disposables.push(geometry);
    }

    /* -- foundation grid (holographic scaffolding) ------------------------- */
    const gridUniforms = {
      uTime: { value: 0 },
      uEnergy: { value: 0.4 },
      uFade: { value: 1 },
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
        "uniform float uTime; uniform float uEnergy; uniform float uFade;",
        "uniform vec3 uColorA; uniform vec3 uColorB;",
        "void main() {",
        "  vec2 p = (vUv - 0.5) * 40.0;",
        "  float r = length(p);",
        "  float ang = atan(p.y, p.x) / 6.2831853;",
        "  float ringLine = 1.0 - smoothstep(0.0, 0.09, abs(fract(r / 1.7) - 0.5) * 1.7);",
        "  float spoke = 1.0 - smoothstep(0.0, 0.055, abs(fract(ang * 24.0 + uTime * 0.012) - 0.5) * (6.2831853 / 24.0) * r);",
        "  float pulse = exp(-abs(r - fract(uTime * 0.16) * 17.0) * 1.5);",
        "  float falloff = exp(-r * 0.17);",
        "  float glow = (ringLine * 0.42 + spoke * 0.26) * falloff + pulse * 0.55 * falloff;",
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

    /* -- the worldheart + light column -------------------------------------- */
    const HEART_Y = 4.9;
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
    const heartGlowMaterial = new THREE.SpriteMaterial({ map: heartGlowTexture, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending });
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
    const flashMaterial = new THREE.SpriteMaterial({ map: heartGlowTexture, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    const flash = new THREE.Sprite(flashMaterial);
    flash.position.set(0, 3, 0);
    flash.scale.setScalar(1);
    scene.add(flash);
    disposables.push(flashMaterial);

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
    let frame = 0;
    let smoothP = isLobby ? 0 : Math.min(0.04, progressRef.current);
    let finaleT = -1;
    let freqData: Uint8Array<ArrayBuffer> | null = null;
    let musicLevel = 0;
    const tmp = new THREE.Vector3();
    const tmpB = new THREE.Vector3();
    const emitter = new THREE.Vector3();

    const renderFrame = () => {
      const dt = Math.min(clock.getDelta(), 0.05);
      const t = clock.elapsedTime;
      const charge = isLobby ? clamp01(dramaRef.current) : 0;

      // Progress eases toward the live value and never regresses.
      if (!isLobby) {
        smoothP += (Math.max(smoothP, clamp01(progressRef.current)) - smoothP) * Math.min(1, dt * 1.6);
      }
      const p = smoothP;

      // Music drive from the shared BGM analyser (silent fallback: slow sine).
      const analyser = bgmGetAnalyser();
      if (analyser) {
        if (!freqData || freqData.length !== analyser.frequencyBinCount) {
          freqData = new Uint8Array(analyser.frequencyBinCount);
        }
        analyser.getByteFrequencyData(freqData);
        let sum = 0;
        const bins = Math.max(8, Math.floor(freqData.length * 0.25));
        for (let i = 0; i < bins; i += 1) sum += freqData[i];
        musicLevel += (sum / (bins * 255) - musicLevel) * Math.min(1, dt * 8);
      } else {
        musicLevel += ((0.22 + Math.sin(t * 0.9) * 0.1) - musicLevel) * Math.min(1, dt * 2);
      }

      // Theme light gutter — layered sines so candlelight sputters organically.
      let gutter = 1;
      if (motion.flicker > 0) {
        const g = Math.sin(t * 11.3) * Math.sin(t * 5.1 + 1.7) * Math.sin(t * 2.3 + 4.2);
        gutter = 1 - motion.flicker * (0.12 + 0.3 * Math.max(0, g));
      }

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
      vortexMaterial.opacity = (isLobby ? 0.4 + charge * 0.2 : 0.55 - easeInOutCubic(p) * 0.3) * (0.8 + musicLevel * 0.4) * gutter;

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

      /* weather ---------------------------------------------------------------- */
      const weatherAlpha = isLobby ? 0.3 + charge * 0.15 : clamp01((p - 0.28) / 0.25) * 0.5;
      weatherMaterial.opacity += (weatherAlpha * gutter - weatherMaterial.opacity) * Math.min(1, dt * 2);
      if (weatherMaterial.opacity > 0.02) {
        const wAttr = weatherGeometry.getAttribute("position") as THREE.BufferAttribute;
        for (let i = 0; i < WEATHER; i += 1) {
          const y = ((wSeeds[i * 4 + 2] + t * weatherSpeed * weatherUp) % 11 + 11) % 11;
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

      /* foundation, glyphs, heart, beam ---------------------------------------- */
      gridUniforms.uTime.value = t;
      const buildEnergy = isLobby ? 0.3 + charge * 0.35 : 0.45 + p * 0.55 - easeInOutCubic(clamp01((p - 0.9) / 0.1)) * 0.6;
      gridUniforms.uEnergy.value = (buildEnergy + musicLevel * 0.2) * gutter;

      glyphRing.rotation.z = t * 0.04 * motion.ringSpeed;
      glyphMaterial.opacity = (isLobby ? 0.2 + charge * 0.12 : 0.24 + p * 0.1 + musicLevel * 0.15) * gutter;

      const breath = Math.sin(t * 1.6) * 0.05;
      const heartScale = isLobby
        ? 0.45 + charge * 0.22 + breath * 0.5
        : Math.max(0.08, 0.28 + p * 1.0 + breath * p);
      heart.scale.setScalar(heartScale);
      heart.rotation.y = t * 0.3;
      heartWireOuter.rotation.x = t * 0.21;
      heartWireOuter.rotation.z = -t * 0.13;
      heartWireInner.rotation.x = -t * 0.17;
      heartCore.scale.setScalar(1 + Math.sin(t * 2.4) * 0.12 + musicLevel * 0.25);
      heartGlowMaterial.opacity = (0.35 + musicLevel * 0.4 + (isLobby ? charge * 0.15 : p * 0.25)) * gutter;
      heartLight.intensity = (isLobby ? 4 + charge * 8 : 4 + p * 22) * gutter + musicLevel * 16;

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
      const radius = isLobby
        ? 17 - charge * 1.2
        : 17.5 - easeOutCubic(p) * 6 - musicLevel * 0.4;
      const height = isLobby ? 5.4 : 5.6 - p * 2.2;
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
      camera.lookAt(0, 1.4 + (isLobby ? 0.4 : p * 1.1), 0);

      renderer.render(scene, camera);
    };

    if (reducedMotion) {
      // A still frame: the world as built as progress says, no animation.
      smoothP = isLobby ? 0 : Math.max(0.6, progressRef.current);
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
