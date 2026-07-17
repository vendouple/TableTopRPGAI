"use client";

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { CampaignEnding, EndingCastMember, EndingKind, EndingStat, Player } from "@/lib/campaign/types";
import { accentColor } from "@/lib/client/api";
import { themeVisual, ThemeKey } from "@/components/three/themeVisuals";
import { createThemeLayer, themeGutter } from "@/components/three/themeLayers";

/**
 * Every ending kind gets its own finale choreography — the same instruments
 * (vortex, sigil ring, god rays, shockwaves, streaks, camera) tuned into six
 * very different last images, each crowned by a signature effect no other
 * ending has:
 *
 *   victory     – a golden ascension: the vortex is a rising funnel, shockwave
 *                 rings bloom, comets cross the sky, a molten core blazes.
 *   defeat      – ash falls, the light dies, the great ring slowly collapses,
 *                 and lone embers flare briefly in the dark before going out.
 *   bittersweet – gold and cold blue share the sky; lanterns drift up gently.
 *   escape      – everything streams sideways past the camera; speed-lines
 *                 whip by while the ring recedes behind the fleeing party.
 *   draw        – two mirrored rings counter-rotate in perfect balance, and
 *                 two orbs circle each other forever, neither catching up.
 *   cliffhanger – the vortex keeps stalling mid-turn, the ring is unfinished,
 *                 the sky flickers like a film about to snap, and each stall
 *                 leaves the whole scene wrenched slightly out of true.
 *   generic     – the fallback seal for any ending the six above don't cover:
 *                 a calm parchment-and-dusk spiral under a completed sigil.
 */
type FinaleSignature = "ascension" | "embers" | "lanterns" | "rush" | "balance" | "fracture" | "none";

type FinaleRecipe = {
  label: string;
  fin: string;
  colors: [string, string];
  /** Deep background tint behind the canvas. */
  deep: string;
  /** Tangential vortex speed (radians/s at speed seed 1). */
  swirl: number;
  /** Vertical drift per second; positive = rising. */
  lift: number;
  /** Lateral wind per second (escape's sideways rush). */
  sweep: number;
  turbulence: number;
  rays: number;
  /** Fraction of the sigil circle that gets drawn (cliffhanger < 1). */
  ringArc: number;
  ringSpin: number;
  /** Per-second scale factor applied to the ring (defeat collapses it). */
  ringCollapse: number;
  /** Seconds between shockwave rings; 0 = never. */
  burstEvery: number;
  /** Seconds between comet streaks; 0 = never. */
  streakEvery: number;
  /** Streak heading (unit-ish direction, x/y). */
  streakDir: [number, number];
  /** Camera drift per second. */
  camDrift: [number, number, number];
  /** 1 = the cliffhanger stall-and-flicker cycle is active. */
  flicker: number;
  /** True = split the field into two counter-rotating halves (draw). */
  mirrored: boolean;
  particleSize: number;
  opacity: number;
  /** Vortex silhouette: + widens with height (tornado), - widens downward. */
  funnel: number;
  /** The one-of-a-kind extra layered on top of the shared instruments. */
  signature: FinaleSignature;
  /** Central glow: scale and strength (0 disables). */
  core: [number, number];
};

const FINALES: Record<EndingKind | "generic", FinaleRecipe> = {
  victory: {
    label: "Victory", fin: "✦ FIN ✦",
    colors: ["#ffe6a8", "#ffb84d"], deep: "#120c04",
    swirl: 0.85, lift: 0.6, sweep: 0, turbulence: 0.8, rays: 1,
    ringArc: 1, ringSpin: 0.14, ringCollapse: 0, burstEvery: 4.5,
    streakEvery: 1.4, streakDir: [0.7, 0.55], camDrift: [0, 0.12, 0],
    flicker: 0, mirrored: false, particleSize: 0.075, opacity: 0.95,
    funnel: 0.5, signature: "ascension", core: [9, 0.5]
  },
  defeat: {
    label: "Defeat", fin: "✦ FIN ✦",
    colors: ["#8a8f9c", "#ff5c3c"], deep: "#080304",
    swirl: 0.12, lift: -0.55, sweep: 0, turbulence: 0.35, rays: 0.12,
    ringArc: 1, ringSpin: 0.03, ringCollapse: 0.02, burstEvery: 0,
    streakEvery: 0, streakDir: [0, -1], camDrift: [0, -0.08, 0],
    flicker: 0, mirrored: false, particleSize: 0.055, opacity: 0.7,
    funnel: -0.35, signature: "embers", core: [5, 0.24]
  },
  bittersweet: {
    label: "Bittersweet", fin: "✦ FIN ✦",
    colors: ["#ffd98a", "#9ec8ff"], deep: "#0a0a10",
    swirl: 0.4, lift: 0.32, sweep: 0, turbulence: 0.55, rays: 0.55,
    ringArc: 1, ringSpin: 0.08, ringCollapse: 0, burstEvery: 9,
    streakEvery: 4.5, streakDir: [0.5, 0.5], camDrift: [0, 0.06, 0],
    flicker: 0, mirrored: false, particleSize: 0.065, opacity: 0.85,
    funnel: 0.15, signature: "lanterns", core: [7, 0.32]
  },
  escape: {
    label: "Escape", fin: "✦ FIN ✦",
    colors: ["#a8ecff", "#f2fbff"], deep: "#040a10",
    swirl: 0.22, lift: 0.08, sweep: 3.2, turbulence: 0.5, rays: 0.3,
    ringArc: 1, ringSpin: 0.06, ringCollapse: 0, burstEvery: 0,
    streakEvery: 0.8, streakDir: [1, 0.08], camDrift: [0, 0, 0.14],
    flicker: 0, mirrored: false, particleSize: 0.06, opacity: 0.85,
    funnel: 0, signature: "rush", core: [8, 0.3]
  },
  draw: {
    label: "Stalemate", fin: "THE SCALES REST EVEN",
    colors: ["#d9dde6", "#c9a35c"], deep: "#090a0e",
    swirl: 0.5, lift: 0.14, sweep: 0, turbulence: 0.4, rays: 0.4,
    ringArc: 1, ringSpin: 0.07, ringCollapse: 0, burstEvery: 0,
    streakEvery: 0, streakDir: [0, 1], camDrift: [0, 0, 0],
    flicker: 0, mirrored: true, particleSize: 0.06, opacity: 0.8,
    funnel: 0, signature: "balance", core: [5, 0.22]
  },
  cliffhanger: {
    label: "To Be Continued", fin: "TO BE CONTINUED…",
    colors: ["#b18cff", "#ff4fa8"], deep: "#0a0512",
    swirl: 0.75, lift: 0.28, sweep: 0, turbulence: 1.1, rays: 0.35,
    ringArc: 0.72, ringSpin: 0.16, ringCollapse: 0, burstEvery: 0,
    streakEvery: 3, streakDir: [0.6, 0.7], camDrift: [0.04, 0, -0.05],
    flicker: 1, mirrored: false, particleSize: 0.07, opacity: 0.9,
    funnel: 0.3, signature: "fracture", core: [7, 0.4]
  },
  // Fallback seal for ending kinds the DM invents beyond the known six.
  generic: {
    label: "The Tale Ends", fin: "✦ FIN ✦",
    colors: ["#e8dcc0", "#8fa3c8"], deep: "#0a0b10",
    swirl: 0.45, lift: 0.2, sweep: 0, turbulence: 0.5, rays: 0.4,
    ringArc: 1, ringSpin: 0.08, ringCollapse: 0, burstEvery: 7,
    streakEvery: 3, streakDir: [0.6, 0.5], camDrift: [0, 0.05, 0],
    flicker: 0, mirrored: false, particleSize: 0.065, opacity: 0.85,
    funnel: 0.2, signature: "none", core: [7, 0.32]
  }
};

const VORTEX_COUNT = 1800;
const STAR_COUNT = 500;

/** Tall soft-edged shaft, bright at the top, dissolving downward. */
function makeRayTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 512;
  const ctx = canvas.getContext("2d")!;
  const vertical = ctx.createLinearGradient(0, 0, 0, 512);
  vertical.addColorStop(0, "rgba(255,255,255,0.7)");
  vertical.addColorStop(0.65, "rgba(255,255,255,0.18)");
  vertical.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = vertical;
  ctx.fillRect(0, 0, 128, 512);
  ctx.globalCompositeOperation = "destination-in";
  const horizontal = ctx.createLinearGradient(0, 0, 128, 0);
  horizontal.addColorStop(0, "rgba(255,255,255,0)");
  horizontal.addColorStop(0.5, "rgba(255,255,255,1)");
  horizontal.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = horizontal;
  ctx.fillRect(0, 0, 128, 512);
  return new THREE.CanvasTexture(canvas);
}

/** Thin expanding shockwave circle. */
function makeShockTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(128, 128, 96, 128, 128, 122);
  gradient.addColorStop(0, "rgba(255,255,255,0)");
  gradient.addColorStop(0.65, "rgba(255,255,255,0.9)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(canvas);
}

/** Comet streak — a hot head trailing off to nothing. */
function makeStreakTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 32;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createLinearGradient(0, 0, 256, 0);
  gradient.addColorStop(0, "rgba(255,255,255,0)");
  gradient.addColorStop(0.75, "rgba(255,255,255,0.35)");
  gradient.addColorStop(0.96, "rgba(255,255,255,1)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 32);
  ctx.globalCompositeOperation = "destination-in";
  const vertical = ctx.createLinearGradient(0, 0, 0, 32);
  vertical.addColorStop(0, "rgba(255,255,255,0)");
  vertical.addColorStop(0.5, "rgba(255,255,255,1)");
  vertical.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = vertical;
  ctx.fillRect(0, 0, 256, 32);
  return new THREE.CanvasTexture(canvas);
}

/** Soft-cored radial glow — the finale's molten heart, tinted per ending. */
function makeCoreTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(128, 128, 4, 128, 128, 128);
  gradient.addColorStop(0, "rgba(255,255,255,0.95)");
  gradient.addColorStop(0.22, "rgba(255,255,255,0.4)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(canvas);
}

/**
 * The Grand Sigil — the campaign theme's glyph alphabet arranged in a great
 * circle, with concentric orbit lines. `arc` < 1 leaves the circle unfinished
 * (the cliffhanger's broken seal). Drawn at 2048px so the ring stays a sharp
 * etched seal instead of a blurred smudge when it fills the screen.
 */
function makeSigilTexture(glyphs: string, glyphFont: string, arc: number) {
  const size = 2048;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const cx = size / 2;
  const cy = size / 2;
  const sweep = Math.PI * 2 * arc;
  const start = -Math.PI / 2;

  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(cx, cy, 860, start, start + sweep);
  ctx.stroke();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.beginPath();
  ctx.arc(cx, cy, 660, start, start + sweep);
  ctx.stroke();

  const letters = glyphs.split("");
  const count = Math.max(letters.length, 12);
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  // Keep the theme's font family, doubled to match the doubled canvas.
  const fontSize = Math.round((parseFloat(glyphFont) || 44) * 2.1);
  ctx.font = `${fontSize}px ${glyphFont.replace(/^[\d.]+px\s*/, "") || "serif"}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let i = 0; i < count; i += 1) {
    const fraction = i / count;
    if (fraction > arc) continue;
    const angle = start + fraction * Math.PI * 2;
    const glyph = letters[i % letters.length];
    ctx.save();
    ctx.translate(cx + Math.cos(angle) * 764, cy + Math.sin(angle) * 764);
    ctx.rotate(angle + Math.PI / 2);
    ctx.fillText(glyph, 0, 0);
    ctx.restore();
  }
  return new THREE.CanvasTexture(canvas);
}

/**
 * The final cinematic. A full-screen Three.js finale choreographed by the
 * ending kind and tinted by the campaign theme, beneath a staged credits
 * scroll: kind → title → epilogue → highlights → stats board → cast → fin.
 */
export default function OutroTheater({
  ending,
  players,
  campaignTitle,
  theme,
  onExit
}: {
  ending: CampaignEnding;
  players: Player[];
  campaignTitle: string;
  theme?: ThemeKey | string | null;
  onExit?: () => void;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  // Unknown ending kinds get the generic seal — but keep the DM's own word
  // for the badge, so a "tragedy" still reads as one over the fallback finale.
  const kind: EndingKind | "generic" = FINALES[ending.kind] ? ending.kind : "generic";
  const recipe = FINALES[kind];
  const kindLabel =
    kind === "generic" && ending.kind
      ? String(ending.kind).replace(/\b\w/g, (c) => c.toUpperCase())
      : recipe.label;
  const visual = themeVisual(theme);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) return;

    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 90);
    const camBase = new THREE.Vector3(0, 0, 16);
    camera.position.copy(camBase);

    // Theme tint — the finale's palette leans toward the campaign's colors,
    // so a scifi victory blazes cyan-gold while a western one burns amber.
    const tint = visual.key === "none" ? 0 : 0.25;
    const colorA = new THREE.Color(recipe.colors[0]).lerp(new THREE.Color(visual.accentBright), tint);
    const colorB = new THREE.Color(recipe.colors[1]).lerp(new THREE.Color(visual.secondary), tint);

    /* ---------------- Distant starfield ---------------- */
    const starPositions = new Float32Array(STAR_COUNT * 3);
    for (let i = 0; i < STAR_COUNT; i += 1) {
      starPositions[i * 3] = (Math.random() - 0.5) * 70;
      starPositions[i * 3 + 1] = (Math.random() - 0.5) * 44;
      starPositions[i * 3 + 2] = -18 - Math.random() * 30;
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    const starMaterial = new THREE.PointsMaterial({
      size: 0.05,
      color: 0xffffff,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      sizeAttenuation: true
    });
    const stars = new THREE.Points(starGeometry, starMaterial);
    scene.add(stars);

    /* ---------------- The finale vortex ---------------- */
    // Particles live in cylinder coordinates (angle, radius, height) around
    // the vertical axis; each kind writes a different motion into them.
    const angles = new Float32Array(VORTEX_COUNT);
    const radii = new Float32Array(VORTEX_COUNT);
    const heights = new Float32Array(VORTEX_COUNT);
    const seeds = new Float32Array(VORTEX_COUNT);
    const positions = new Float32Array(VORTEX_COUNT * 3);
    const colors = new Float32Array(VORTEX_COUNT * 3);
    const mixed = new THREE.Color();
    for (let i = 0; i < VORTEX_COUNT; i += 1) {
      angles[i] = Math.random() * Math.PI * 2;
      radii[i] = 1.5 + Math.pow(Math.random(), 0.7) * 11;
      heights[i] = (Math.random() - 0.5) * 18;
      seeds[i] = 0.4 + Math.random() * 1.2;
      // Draw splits the sky into two clean camps; everything else blends.
      const blend = recipe.mirrored ? (i % 2) : (i % 9) / 8;
      mixed.copy(colorA).lerp(colorB, blend);
      colors[i * 3] = mixed.r;
      colors[i * 3 + 1] = mixed.g;
      colors[i * 3 + 2] = mixed.b;
    }
    const vortexGeometry = new THREE.BufferGeometry();
    vortexGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    vortexGeometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const vortexMaterial = new THREE.PointsMaterial({
      size: recipe.particleSize,
      transparent: true,
      vertexColors: true,
      opacity: recipe.opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true
    });
    const vortex = new THREE.Points(vortexGeometry, vortexMaterial);
    scene.add(vortex);

    /* ---------------- The molten core ---------------- */
    const coreTexture = makeCoreTexture();
    const coreMaterial = new THREE.SpriteMaterial({
      map: coreTexture,
      transparent: true,
      opacity: 0,
      color: colorA,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    const core = new THREE.Sprite(coreMaterial);
    core.position.set(0, 0, -4.5);
    core.scale.setScalar(recipe.core[0]);
    scene.add(core);

    /* ---------------- The Grand Sigil rings ---------------- */
    const sigilTexture = makeSigilTexture(visual.glyphs, visual.glyphFont, recipe.ringArc);
    sigilTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const outerRingMaterial = new THREE.MeshBasicMaterial({
      map: sigilTexture,
      transparent: true,
      opacity: 0.55,
      color: colorA,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide
    });
    const outerRing = new THREE.Mesh(new THREE.PlaneGeometry(13, 13), outerRingMaterial);
    outerRing.position.set(0, 0, -6);
    scene.add(outerRing);

    const innerRingMaterial = outerRingMaterial.clone();
    innerRingMaterial.opacity = 0.32;
    innerRingMaterial.color = colorB;
    // Draw's twin ring matches the outer one — two equal seals in balance.
    const innerSize = recipe.mirrored ? 13 : 8;
    const innerRing = new THREE.Mesh(new THREE.PlaneGeometry(innerSize, innerSize), innerRingMaterial);
    innerRing.position.set(0, 0, -5.4);
    scene.add(innerRing);

    /* ---------------- God rays ---------------- */
    const rayTexture = makeRayTexture();
    const rays: Array<{ mesh: THREE.Mesh; seed: number }> = [];
    for (let i = 0; i < 4; i += 1) {
      const material = new THREE.MeshBasicMaterial({
        map: rayTexture,
        transparent: true,
        opacity: 0,
        color: colorA,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2.6 + i * 1.1, 26), material);
      mesh.position.set(-8 + i * 5.4, 5.5, -7 - i * 0.6);
      mesh.rotation.z = -0.32 - i * 0.06;
      rays.push({ mesh, seed: Math.random() * Math.PI * 2 });
      scene.add(mesh);
    }

    /* ---------------- Shockwave rings ---------------- */
    const shockTexture = makeShockTexture();
    const shocks: Array<{ mesh: THREE.Mesh; born: number }> = [];
    for (let i = 0; i < 4; i += 1) {
      const material = new THREE.MeshBasicMaterial({
        map: shockTexture,
        transparent: true,
        opacity: 0,
        color: colorA,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
      mesh.position.set(0, 0, -4);
      shocks.push({ mesh, born: -1 });
      scene.add(mesh);
    }

    /* ---------------- Comet streaks ---------------- */
    const streakTexture = makeStreakTexture();
    const streaks: Array<{ mesh: THREE.Mesh; born: number; velocity: THREE.Vector2 }> = [];
    for (let i = 0; i < 8; i += 1) {
      const material = new THREE.MeshBasicMaterial({
        map: streakTexture,
        transparent: true,
        opacity: 0,
        color: i % 2 ? colorB : colorA,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(4.5, 0.28), material);
      streaks.push({ mesh, born: -1, velocity: new THREE.Vector2() });
      scene.add(mesh);
    }

    /* ---------------- Signature effects (one per ending kind) ---------------- */
    // Defeat: lone embers that flare in the dark and go out.
    // Bittersweet: paper lanterns drifting slowly upward.
    // Draw: two orbs circling each other in perfect, endless balance.
    // Escape: thin speed-lines whipping past the fleeing camera.
    const emberSprites: Array<{ sprite: THREE.Sprite; seed: number }> = [];
    const lanternSprites: Array<{ sprite: THREE.Sprite; x: number; speed: number; seed: number; size: number }> = [];
    const balanceOrbs: THREE.Sprite[] = [];
    const rushLines: Array<{ mesh: THREE.Mesh; y: number; z: number; speed: number; seed: number }> = [];
    const extraDisposables: Array<{ dispose: () => void }> = [];
    const makeGlowSprite = (color: THREE.Color, opacity: number) => {
      const material = new THREE.SpriteMaterial({
        map: coreTexture,
        transparent: true,
        opacity,
        color,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      });
      const sprite = new THREE.Sprite(material);
      extraDisposables.push(material);
      return sprite;
    };
    if (recipe.signature === "embers") {
      for (let i = 0; i < 7; i += 1) {
        const sprite = makeGlowSprite(colorB, 0);
        sprite.position.set((Math.random() - 0.5) * 18, -6 + Math.random() * 4, -4 - Math.random() * 3);
        sprite.scale.setScalar(0.7 + Math.random() * 0.6);
        scene.add(sprite);
        emberSprites.push({ sprite, seed: 0.5 + Math.random() * 1.3 });
      }
    }
    if (recipe.signature === "lanterns") {
      for (let i = 0; i < 12; i += 1) {
        const sprite = makeGlowSprite(i % 2 ? colorB : colorA, 0);
        const size = 0.5 + Math.random() * 0.7;
        sprite.scale.setScalar(size);
        scene.add(sprite);
        lanternSprites.push({
          sprite,
          x: (Math.random() - 0.5) * 20,
          speed: 0.18 + Math.random() * 0.3,
          seed: Math.random() * Math.PI * 2,
          size
        });
      }
    }
    if (recipe.signature === "balance") {
      for (let i = 0; i < 2; i += 1) {
        const orb = makeGlowSprite(i ? colorB : colorA, 0.6);
        orb.scale.setScalar(1.8);
        scene.add(orb);
        balanceOrbs.push(orb);
      }
    }
    if (recipe.signature === "rush") {
      for (let i = 0; i < 10; i += 1) {
        const material = new THREE.MeshBasicMaterial({
          map: streakTexture,
          transparent: true,
          opacity: 0.22,
          color: i % 2 ? colorB : colorA,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide
        });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(6, 0.09), material);
        extraDisposables.push(mesh.geometry, material);
        scene.add(mesh);
        rushLines.push({
          mesh,
          y: (Math.random() - 0.5) * 14,
          z: -3 - Math.random() * 6,
          speed: 16 + Math.random() * 12,
          seed: Math.random() * 34
        });
      }
      // Escape's core is a stretched horizon glow along the flight axis.
      core.scale.set(recipe.core[0] * 3, recipe.core[0] * 0.55, 1);
    }

    /* ---------------- Theme garnish (one per campaign genre) ---------------- */
    // The genre's signature weather plays through the finale too — noir rain
    // keeps falling on the credits, fantasy auroras crown the victory, ash
    // sifts across a wasteland defeat. Same layers as the live stage.
    const themeLayer = createThemeLayer(scene, visual, { width: 38, height: 24, z: -9 });

    const resize = () => {
      renderer.setSize(mount.clientWidth, mount.clientHeight, false);
      camera.aspect = mount.clientWidth / Math.max(mount.clientHeight, 1);
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(mount);

    const clock = new THREE.Clock();
    let frame = 0;
    let nextShock = 1.2;
    let nextStreak = 0.8;
    let ringScale = 1;
    let stallCycle = -1;
    let twistTarget = 0;

    const loop = () => {
      frame = requestAnimationFrame(loop);
      const dt = Math.min(clock.getDelta(), 0.05);
      const t = clock.elapsedTime;
      // The whole finale breathes in over the first seconds instead of
      // popping on fully formed under the fading credits veil.
      const fadeIn = Math.min(1, t / 2.4);

      // Cliffhanger cycle: every five seconds the whole finale stalls for a
      // heartbeat — motion freezes, the light gutters — then lurches onward,
      // and each stall leaves the sky wrenched slightly out of true.
      let speedMul = 1;
      // The genre's own light personality plays under the finale: a horror
      // ending gutters like dying candles, a wasteland one stutters, a fantasy
      // one holds steady gold.
      let lightMul = themeGutter(visual, t);
      if (recipe.flicker > 0) {
        const cycle = Math.floor(t / 5);
        const phase = t % 5;
        if (phase < 0.55) {
          speedMul = 0.06;
          lightMul = 0.45 + Math.random() * 0.4;
          if (recipe.signature === "fracture" && cycle !== stallCycle) {
            stallCycle = cycle;
            twistTarget = (Math.random() - 0.5) * 0.5;
          }
        } else {
          twistTarget = 0;
        }
      }
      if (recipe.signature === "fracture") {
        vortex.rotation.z += (twistTarget - vortex.rotation.z) * Math.min(1, dt * 4);
        outerRing.rotation.x = vortex.rotation.z * 0.4;
        innerRing.rotation.x = vortex.rotation.z * -0.6;
      }

      for (let i = 0; i < VORTEX_COUNT; i += 1) {
        const seed = seeds[i];
        const direction = recipe.mirrored && i % 2 ? -1 : 1;
        angles[i] += recipe.swirl * seed * direction * dt * speedMul;
        heights[i] += recipe.lift * seed * dt * speedMul;
        // Victory's ascension: a strong updraft near the funnel's throat.
        if (recipe.signature === "ascension") {
          heights[i] += dt * speedMul * seed * Math.max(0, 1.5 - radii[i] * 0.12);
        }
        radii[i] += Math.sin(t * 0.35 + seed * 9) * recipe.turbulence * 0.25 * dt;
        if (heights[i] > 10) heights[i] = -10;
        if (heights[i] < -10) heights[i] = 10;
        if (radii[i] < 1.2) radii[i] = 12;
        if (radii[i] > 12.8) radii[i] = 1.4;
        const px = i * 3;
        // The funnel gives each ending a silhouette: victory rises into a
        // widening tornado, defeat slumps into a collapsing mound.
        const funnelRadius = Math.max(0.4, radii[i] * (1 + recipe.funnel * (heights[i] / 10)));
        positions[px] = Math.cos(angles[i]) * funnelRadius;
        positions[px + 1] = heights[i] + Math.sin(t * seed + angles[i]) * recipe.turbulence * 0.3;
        positions[px + 2] = Math.sin(angles[i]) * funnelRadius * 0.55 - 3;
        if (recipe.sweep) {
          // Escape: the sky itself streams past the fleeing camera.
          positions[px] = ((positions[px] + t * recipe.sweep * seed + 17) % 34) - 17;
        }
      }
      vortexGeometry.attributes.position.needsUpdate = true;
      vortexMaterial.opacity = recipe.opacity * lightMul * fadeIn;

      // The molten core breathes with the swirl.
      coreMaterial.opacity = recipe.core[1] * (0.8 + Math.sin(t * 0.9) * 0.2) * lightMul * fadeIn;
      if (recipe.signature !== "rush") {
        core.scale.setScalar(recipe.core[0] * (1 + Math.sin(t * 0.55) * 0.06));
      }
      if (recipe.ringCollapse > 0) {
        // Defeat: the dying heart shrinks and reddens with the falling seal.
        core.scale.setScalar(recipe.core[0] * Math.max(0.25, ringScale));
        coreMaterial.color.copy(colorA).lerp(colorB, Math.min(1, 1 - ringScale + 0.35));
      }

      // Signature layers.
      for (const ember of emberSprites) {
        // Each ember flares briefly on its own slow cycle, then goes dark.
        const flare = Math.pow(Math.max(0, Math.sin(t * 0.6 * ember.seed + ember.seed * 20)), 6);
        (ember.sprite.material as THREE.SpriteMaterial).opacity = flare * 0.75 * lightMul * fadeIn;
        ember.sprite.position.y += dt * flare * 0.5;
      }
      lanternSprites.forEach((lantern, index) => {
        const path = ((t * lantern.speed + index / lanternSprites.length) % 1 + 1) % 1;
        lantern.sprite.position.set(
          lantern.x + Math.sin(t * 0.4 + lantern.seed) * 0.9,
          -8 + path * 17,
          -4 - (index % 4)
        );
        (lantern.sprite.material as THREE.SpriteMaterial).opacity = Math.sin(path * Math.PI) * 0.65 * fadeIn;
      });
      balanceOrbs.forEach((orb, index) => {
        const angle = t * 0.45 + index * Math.PI;
        orb.position.set(Math.cos(angle) * 6.8, Math.sin(angle) * 4.4, -4.5);
        (orb.material as THREE.SpriteMaterial).opacity = (0.45 + 0.25 * Math.sin(t * 0.8 + index * Math.PI)) * fadeIn;
      });
      for (const line of rushLines) {
        line.mesh.position.set((((line.seed + t * line.speed) % 34) + 34) % 34 - 17, line.y, line.z);
        (line.mesh.material as THREE.MeshBasicMaterial).opacity = 0.22 * fadeIn;
      }

      // The great seal turns; defeat lets it slowly fall inward and fade.
      if (recipe.ringCollapse > 0) {
        ringScale = Math.max(0.12, ringScale - recipe.ringCollapse * dt);
        outerRingMaterial.opacity = 0.55 * ringScale * lightMul * fadeIn;
        innerRingMaterial.opacity = 0.32 * ringScale * lightMul * fadeIn;
      } else {
        const breathe = 1 + Math.sin(t * 0.4) * 0.02;
        ringScale = breathe;
        outerRingMaterial.opacity = (0.42 + Math.sin(t * 0.7) * 0.12) * lightMul * fadeIn;
        innerRingMaterial.opacity = (0.24 + Math.sin(t * 0.9 + 1.7) * 0.08) * lightMul * fadeIn;
      }
      outerRing.scale.setScalar(ringScale);
      innerRing.scale.setScalar(recipe.mirrored ? ringScale : ringScale * 0.98);
      outerRing.rotation.z += recipe.ringSpin * dt * speedMul;
      innerRing.rotation.z -= recipe.ringSpin * 1.6 * dt * speedMul;

      rays.forEach((ray, index) => {
        const material = ray.mesh.material as THREE.MeshBasicMaterial;
        material.opacity = recipe.rays * (0.14 + 0.1 * Math.sin(t * 0.24 + ray.seed)) * lightMul * fadeIn;
        ray.mesh.rotation.z = -0.32 - index * 0.06 + Math.sin(t * 0.09 + ray.seed) * 0.04;
      });

      // Shockwaves — victory's blooming rings of light.
      if (recipe.burstEvery > 0 && t >= nextShock) {
        nextShock = t + recipe.burstEvery;
        const idle = shocks.find((shock) => shock.born < 0);
        if (idle) idle.born = t;
      }
      for (const shock of shocks) {
        if (shock.born < 0) continue;
        const age = (t - shock.born) / 2.6;
        if (age >= 1) {
          shock.born = -1;
          (shock.mesh.material as THREE.MeshBasicMaterial).opacity = 0;
          continue;
        }
        const size = 1.5 + age * 20;
        shock.mesh.scale.setScalar(size);
        (shock.mesh.material as THREE.MeshBasicMaterial).opacity = Math.sin(age * Math.PI) * 0.5 * lightMul;
      }

      // Comet streaks.
      if (recipe.streakEvery > 0 && t >= nextStreak) {
        nextStreak = t + recipe.streakEvery * (0.6 + Math.random() * 0.8);
        const idle = streaks.find((streak) => streak.born < 0);
        if (idle) {
          idle.born = t;
          const [dx, dy] = recipe.streakDir;
          idle.velocity.set(
            (dx + (Math.random() - 0.5) * 0.4) * (Math.random() < 0.5 && !recipe.sweep ? -1 : 1),
            dy + (Math.random() - 0.5) * 0.4
          ).normalize().multiplyScalar(14 + Math.random() * 8);
          idle.mesh.position.set(
            -idle.velocity.x * 0.9 + (Math.random() - 0.5) * 10,
            -idle.velocity.y * 0.9 + (Math.random() - 0.5) * 7,
            -5 - Math.random() * 4
          );
          idle.mesh.rotation.z = Math.atan2(idle.velocity.y, idle.velocity.x);
        }
      }
      for (const streak of streaks) {
        if (streak.born < 0) continue;
        const age = (t - streak.born) / 1.4;
        if (age >= 1) {
          streak.born = -1;
          (streak.mesh.material as THREE.MeshBasicMaterial).opacity = 0;
          continue;
        }
        streak.mesh.position.x += streak.velocity.x * dt;
        streak.mesh.position.y += streak.velocity.y * dt;
        (streak.mesh.material as THREE.MeshBasicMaterial).opacity = Math.sin(age * Math.PI) * 0.8 * lightMul;
      }

      // A slow cinematic dolly, easing out as the credits settle.
      const drift = Math.min(t, 24);
      camera.position.set(
        camBase.x + recipe.camDrift[0] * drift + Math.sin(t * 0.11) * 0.35,
        camBase.y + recipe.camDrift[1] * drift + Math.sin(t * 0.07 + 2) * 0.25,
        camBase.z + recipe.camDrift[2] * drift
      );
      camera.lookAt(0, 0, -4);
      camera.fov = 55 + Math.sin(t * 0.1) * 1.5;
      camera.updateProjectionMatrix();

      stars.rotation.z += dt * 0.004;

      themeLayer?.update(t, dt, fadeIn * Math.min(1, lightMul) * 0.85);

      renderer.render(scene, camera);
    };
    frame = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.dispose();
      starGeometry.dispose();
      starMaterial.dispose();
      vortexGeometry.dispose();
      vortexMaterial.dispose();
      sigilTexture.dispose();
      outerRing.geometry.dispose();
      outerRingMaterial.dispose();
      innerRing.geometry.dispose();
      innerRingMaterial.dispose();
      rayTexture.dispose();
      for (const ray of rays) {
        ray.mesh.geometry.dispose();
        (ray.mesh.material as THREE.Material).dispose();
      }
      shockTexture.dispose();
      for (const shock of shocks) {
        shock.mesh.geometry.dispose();
        (shock.mesh.material as THREE.Material).dispose();
      }
      streakTexture.dispose();
      for (const streak of streaks) {
        streak.mesh.geometry.dispose();
        (streak.mesh.material as THREE.Material).dispose();
      }
      coreTexture.dispose();
      coreMaterial.dispose();
      for (const item of extraDisposables) item.dispose();
      themeLayer?.dispose();
      if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement);
    };
    // Rebuild the whole finale when the ending kind or theme changes (debug gallery).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, visual.key]);

  /* ---------------- Staged credits sequence ---------------- */
  const highlights = ending.highlights || [];
  const stats: EndingStat[] = ending.stats || [];
  // Match each AI-authored cast line back to a live player (by id, else name)
  // so a card can pair the credit line with the character's real portrait/HP.
  const castByPlayer = useMemo(() => {
    const map = new Map<string, EndingCastMember>();
    for (const member of ending.cast || []) {
      const match = players.find(
        (p) =>
          (member.playerId && p.id === member.playerId) ||
          (member.name &&
            [p.characterName || "", p.name].some((n) => n && n.toLowerCase() === member.name!.toLowerCase()))
      );
      if (match && !map.has(match.id)) map.set(match.id, member);
    }
    return map;
  }, [ending.cast, players]);
  // Each block fades in after the previous one; delays accumulate down the reel.
  const delays = useMemo(() => {
    let at = 0.5;
    const next = (gap: number) => {
      const value = at;
      at += gap;
      return value;
    };
    return {
      kicker: next(0.5),
      kind: next(0.7),
      title: next(1.1),
      summary: next(1.1),
      highlights: next(highlights.length * 0.4 + (highlights.length ? 0.5 : 0)),
      stats: next(stats.length ? 1.1 : 0),
      cast: next(players.length ? players.length * 0.25 + 0.9 : 0),
      fin: next(0.8),
      leave: at
    };
  }, [highlights.length, stats.length, players.length]);

  const rise = (delay: number) => ({ animationDelay: `${delay}s` });

  return (
    <div
      className={`outro-theater outro-${kind}`}
      style={{ background: `radial-gradient(ellipse at 50% 42%, ${recipe.deep} 0%, #020306 100%)` }}
      onClick={(event) => event.stopPropagation()}
    >
      <div ref={mountRef} className="outro-canvas" aria-hidden />
      <div className="outro-scroll">
        <div className="outro-content">
          <span className="outro-kicker outro-rise" style={rise(delays.kicker)}>{campaignTitle}</span>
          <div className="outro-kind outro-rise" style={rise(delays.kind)}>{kindLabel}</div>
          <h1 className="outro-title outro-rise" style={rise(delays.title)}>{ending.title}</h1>
          <p className="outro-summary outro-rise" style={rise(delays.summary)}>{ending.summary}</p>
          {highlights.length ? (
            <ul className="outro-highlights">
              {highlights.map((highlight, index) => (
                <li key={index} className="outro-rise" style={rise(delays.highlights + index * 0.4)}>{highlight}</li>
              ))}
            </ul>
          ) : null}
          {stats.length ? (
            <div className="outro-stats">
              {stats.map((stat, index) => (
                <div key={index} className="outro-stat outro-rise" style={rise(delays.stats + index * 0.18)}>
                  <span className="outro-stat-value">{stat.value}</span>
                  <span className="outro-stat-label">{stat.label}</span>
                </div>
              ))}
            </div>
          ) : null}
          {players.length ? (
            <div className="outro-cast">
              <h3 className="outro-rise" style={rise(delays.cast)}>The Party</h3>
              {players.map((player, index) => {
                const member = castByPlayer.get(player.id);
                const pColor = accentColor(player.color);
                const hp = player.stats.find((stat) => stat.name.toUpperCase() === "HP");
                const personalStats = member?.stats || [];
                return (
                  <div
                    key={player.id}
                    className="outro-cast-card outro-rise"
                    style={{ ...rise(delays.cast + 0.35 + index * 0.25), borderColor: `${pColor}44` }}
                  >
                    <div className="outro-cast-face" style={{ borderColor: pColor }}>
                      {player.portraitUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={player.portraitUrl} alt={player.characterName || player.name} />
                      ) : (
                        <span className="outro-cast-glyph" aria-hidden>✦</span>
                      )}
                    </div>
                    <div className="outro-cast-body">
                      <div className="outro-cast-heading">
                        <span className="outro-cast-character" style={{ color: pColor }}>
                          {player.characterName || player.name}
                        </span>
                        {player.characterName ? <span className="outro-cast-player">{player.name}</span> : null}
                      </div>
                      {member?.title ? <span className="outro-cast-epithet">{member.title}</span> : null}
                      {member?.fate ? <p className="outro-cast-fate">{member.fate}</p> : null}
                      {personalStats.length || hp ? (
                        <div className="outro-cast-stats">
                          {hp ? (
                            <span className="outro-cast-stat">
                              <span className="outro-cast-stat-value">{hp.value}/{hp.maxValue}</span>
                              <span className="outro-cast-stat-label">HP</span>
                            </span>
                          ) : null}
                          {personalStats.map((stat, statIndex) => (
                            <span key={statIndex} className="outro-cast-stat">
                              <span className="outro-cast-stat-value">{stat.value}</span>
                              <span className="outro-cast-stat-label">{stat.label}</span>
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
          <div className="outro-fin outro-rise" style={rise(delays.fin)}>{recipe.fin}</div>
          {onExit ? (
            <button className="ghost-button outro-leave outro-rise" style={rise(delays.leave)} onClick={onExit}>
              Leave the table (keeps the saga)
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
