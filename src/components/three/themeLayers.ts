"use client";

import * as THREE from "three";
import type { ThemeVisual } from "./themeVisuals";

/**
 * Shared per-genre signature layers for the live stage and the outro finale.
 * Each campaign theme contributes one unmistakable motif — fantasy auroras,
 * scifi warp-lines, horror wisps, noir rain, modern bokeh, western dust,
 * post-apocalyptic ash — built once per scene and driven every frame with a
 * single `update(t, dt, envelope)` call. Everything is additive, depth-write
 * free, and deliberately low-count so it layers safely over the painted
 * backdrop, the mood particles, and the finale vortex alike.
 */

export type ThemeLayer = {
  /** Advance the layer. `envelope` is the host's master visibility (0..1). */
  update: (t: number, dt: number, envelope: number) => void;
  dispose: () => void;
};

export type ThemeLayerBounds = {
  /** Horizontal world span the layer should fill (centered on 0). */
  width: number;
  /** Vertical world span (centered on 0). */
  height: number;
  /** Base depth to build at (elements spread a little behind it). */
  z: number;
};

/**
 * Irregular light-gutter for a theme — horror candles, wasteland reactors,
 * noir neon buzz. Returns a multiplier around 1 that occasionally dips; a
 * theme with no flicker personality returns exactly 1. Drive lamps, god rays,
 * and ring glows with it so a horror stage breathes like candlelight while a
 * fantasy one holds steady.
 */
export function themeGutter(visual: ThemeVisual, t: number): number {
  const flicker = visual.loom.motion.flicker;
  if (!flicker) return 1;
  // Three incommensurate waves beat irregularly; only their coincident peaks
  // cross the threshold, so dips arrive like a draft catching the flame.
  const wave = Math.sin(t * 6.7) * Math.sin(t * 2.9 + 1.4) * (0.6 + 0.4 * Math.sin(t * 0.53));
  const threshold = 1 - flicker * 0.55;
  const dip = Math.max(0, wave - threshold) / Math.max(0.001, 1 - threshold);
  return 1 - Math.min(1, dip) * flicker * 0.6;
}

/* ------------------------------------------------------------------ */
/* Canvas textures (built per layer, disposed with it)                 */
/* ------------------------------------------------------------------ */

/** Soft radial glow — wisps, bokeh discs, ash motes. */
function makeGlowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
  gradient.addColorStop(0, "rgba(255,255,255,0.9)");
  gradient.addColorStop(0.4, "rgba(255,255,255,0.32)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(canvas);
}

/** Horizontal streak, hot leading edge trailing to nothing — warp lines, dust gusts. */
function makeStreakTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 16;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createLinearGradient(0, 0, 256, 0);
  gradient.addColorStop(0, "rgba(255,255,255,0)");
  gradient.addColorStop(0.7, "rgba(255,255,255,0.4)");
  gradient.addColorStop(0.95, "rgba(255,255,255,1)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 16);
  ctx.globalCompositeOperation = "destination-in";
  const vertical = ctx.createLinearGradient(0, 0, 0, 16);
  vertical.addColorStop(0, "rgba(255,255,255,0)");
  vertical.addColorStop(0.5, "rgba(255,255,255,1)");
  vertical.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = vertical;
  ctx.fillRect(0, 0, 256, 16);
  return new THREE.CanvasTexture(canvas);
}

/** Vertical aurora curtain — bright rippled crest dissolving into a sheer hem. */
function makeCurtainTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const vertical = ctx.createLinearGradient(0, 0, 0, 256);
  vertical.addColorStop(0, "rgba(255,255,255,0.55)");
  vertical.addColorStop(0.35, "rgba(255,255,255,0.22)");
  vertical.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = vertical;
  ctx.fillRect(0, 0, 512, 256);
  // Ripple the crest so the curtain reads as folded light, not a flat band.
  ctx.globalCompositeOperation = "destination-in";
  const ripple = ctx.createLinearGradient(0, 0, 512, 0);
  for (let i = 0; i <= 16; i += 1) {
    const alpha = 0.35 + 0.65 * Math.abs(Math.sin(i * 1.7));
    ripple.addColorStop(i / 16, `rgba(255,255,255,${alpha.toFixed(2)})`);
  }
  ctx.fillStyle = ripple;
  ctx.fillRect(0, 0, 512, 256);
  return new THREE.CanvasTexture(canvas);
}

/* ------------------------------------------------------------------ */
/* The layer factory                                                    */
/* ------------------------------------------------------------------ */

/**
 * Build the theme's signature layer into `scene`. Returns null for themes
 * with no extra layer ("none"). Callers own the frame loop: call `update`
 * each frame and `dispose` on teardown.
 */
export function createThemeLayer(
  scene: THREE.Scene,
  visual: ThemeVisual,
  bounds: ThemeLayerBounds
): ThemeLayer | null {
  switch (visual.effect) {
    case "aurora":
      return auroraLayer(scene, visual, bounds);
    case "warp":
      return warpLayer(scene, visual, bounds);
    case "haunt":
      return hauntLayer(scene, visual, bounds);
    case "rain":
      return rainLayer(scene, visual, bounds);
    case "bokeh":
      return bokehLayer(scene, visual, bounds);
    case "frontier":
      // Western and post-apoc share the shelf key but not the weather:
      // hot horizontal dust gusts vs. ash sifting down through dead air.
      return visual.key === "postapoc" ? ashLayer(scene, visual, bounds) : dustLayer(scene, visual, bounds);
    default:
      return null;
  }
}

/** Fantasy — two aurora curtains crest the sky, folding and drifting. */
function auroraLayer(scene: THREE.Scene, visual: ThemeVisual, bounds: ThemeLayerBounds): ThemeLayer {
  const texture = makeCurtainTexture();
  const curtains: Array<{ mesh: THREE.Mesh; material: THREE.MeshBasicMaterial; seed: number }> = [];
  const colors = [visual.accent, visual.secondary];
  for (let i = 0; i < 2; i += 1) {
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0,
      color: new THREE.Color(colors[i]),
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(bounds.width * (0.62 + i * 0.2), bounds.height * 0.36), material);
    mesh.position.set((i - 0.5) * bounds.width * 0.2, bounds.height * (0.3 - i * 0.06), bounds.z - 1.5 - i);
    mesh.rotation.z = 0.06 - i * 0.12;
    scene.add(mesh);
    curtains.push({ mesh, material, seed: i * 2.4 + 0.7 });
  }
  return {
    update: (t, _dt, envelope) => {
      curtains.forEach((curtain, index) => {
        curtain.material.opacity = (0.16 + 0.08 * Math.sin(t * 0.21 + curtain.seed)) * envelope;
        curtain.mesh.position.x = (index - 0.5) * bounds.width * 0.2 + Math.sin(t * 0.05 + curtain.seed) * bounds.width * 0.06;
        curtain.mesh.rotation.z = 0.06 - index * 0.12 + Math.sin(t * 0.07 + curtain.seed) * 0.05;
        // The crest slowly folds — scaling x reads as the curtain rippling.
        curtain.mesh.scale.x = 1 + Math.sin(t * 0.13 + curtain.seed * 3) * 0.08;
      });
    },
    dispose: () => {
      texture.dispose();
      for (const curtain of curtains) {
        curtain.mesh.geometry.dispose();
        curtain.material.dispose();
        scene.remove(curtain.mesh);
      }
    }
  };
}

/** Scifi — thin warp-lines whip across the frame in brief pulses. */
function warpLayer(scene: THREE.Scene, visual: ThemeVisual, bounds: ThemeLayerBounds): ThemeLayer {
  const texture = makeStreakTexture();
  const half = bounds.width * 0.5 + 6;
  const lines: Array<{ mesh: THREE.Mesh; material: THREE.MeshBasicMaterial; y: number; z: number; speed: number; seed: number }> = [];
  for (let i = 0; i < 12; i += 1) {
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0,
      color: new THREE.Color(i % 3 ? visual.accent : visual.secondary),
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(3.4 + Math.random() * 2.4, 0.05 + Math.random() * 0.05), material);
    lines.push({
      mesh,
      material,
      y: (Math.random() - 0.5) * bounds.height,
      z: bounds.z - Math.random() * 3,
      speed: 14 + Math.random() * 14,
      seed: Math.random() * 200
    });
    scene.add(mesh);
  }
  return {
    update: (t, _dt, envelope) => {
      // The field travels in pulses — a swell every few seconds, like the
      // engine catching, instead of a constant featureless stream.
      const pulse = 0.35 + 0.65 * Math.pow(Math.max(0, Math.sin(t * 0.45)), 2);
      for (const line of lines) {
        const x = ((line.seed + t * line.speed) % (half * 2)) - half;
        line.mesh.position.set(x, line.y + Math.sin(t * 0.3 + line.seed) * 0.4, line.z);
        line.material.opacity = 0.3 * pulse * envelope;
      }
    },
    dispose: () => {
      texture.dispose();
      for (const line of lines) {
        line.mesh.geometry.dispose();
        line.material.dispose();
        scene.remove(line.mesh);
      }
    }
  };
}

/** Horror — spectral wisps rise, wander, and breathe in and out of sight. */
function hauntLayer(scene: THREE.Scene, visual: ThemeVisual, bounds: ThemeLayerBounds): ThemeLayer {
  const texture = makeGlowTexture();
  const wisps: Array<{ sprite: THREE.Sprite; material: THREE.SpriteMaterial; x: number; speed: number; seed: number }> = [];
  for (let i = 0; i < 6; i += 1) {
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 0,
      color: new THREE.Color(i % 3 === 2 ? visual.secondary : visual.accent),
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    const sprite = new THREE.Sprite(material);
    const scale = 1.6 + Math.random() * 2.2;
    sprite.scale.set(scale * 0.7, scale, 1);
    scene.add(sprite);
    wisps.push({
      sprite,
      material,
      x: (Math.random() - 0.5) * bounds.width,
      speed: 0.05 + Math.random() * 0.08,
      seed: Math.random() * Math.PI * 2
    });
  }
  return {
    update: (t, _dt, envelope) => {
      wisps.forEach((wisp, index) => {
        const path = ((t * wisp.speed + index / wisps.length) % 1 + 1) % 1;
        wisp.sprite.position.set(
          wisp.x + Math.sin(t * 0.17 + wisp.seed) * bounds.width * 0.08,
          -bounds.height * 0.5 + path * bounds.height,
          bounds.z - 1 - (index % 3)
        );
        // A wisp only half-exists: long dark stretches, brief pale surfacing.
        const breath = Math.pow(Math.max(0, Math.sin(path * Math.PI)), 1.6);
        const pulse = 0.5 + 0.5 * Math.sin(t * 0.9 * (1 + wisp.seed * 0.1) + wisp.seed * 7);
        wisp.material.opacity = breath * (0.1 + pulse * 0.14) * envelope;
        wisp.sprite.material.rotation = Math.sin(t * 0.11 + wisp.seed) * 0.4;
      });
    },
    dispose: () => {
      texture.dispose();
      for (const wisp of wisps) {
        wisp.material.dispose();
        scene.remove(wisp.sprite);
      }
    }
  };
}

/** Noir — rain falls steady and slanted through the scene's lamplight. */
function rainLayer(scene: THREE.Scene, visual: ThemeVisual, bounds: ThemeLayerBounds): ThemeLayer {
  const DROPS = 140;
  const positions = new Float32Array(DROPS * 2 * 3);
  const speeds = new Float32Array(DROPS);
  const slant = 0.16; // world x per world y of fall — a wind-driven angle
  const streak = 0.55; // drop length in world units
  for (let i = 0; i < DROPS; i += 1) {
    const x = (Math.random() - 0.5) * bounds.width * 1.2;
    const y = (Math.random() - 0.5) * bounds.height * 1.3;
    const z = bounds.z - Math.random() * 4;
    positions[i * 6] = x;
    positions[i * 6 + 1] = y;
    positions[i * 6 + 2] = z;
    positions[i * 6 + 3] = x + slant * streak;
    positions[i * 6 + 4] = y + streak;
    positions[i * 6 + 5] = z;
    speeds[i] = 9 + Math.random() * 7;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({
    color: new THREE.Color(visual.dust.color),
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  const rain = new THREE.LineSegments(geometry, material);
  scene.add(rain);
  const attr = geometry.getAttribute("position") as THREE.BufferAttribute;
  const top = bounds.height * 0.65;
  return {
    update: (_t, dt, envelope) => {
      for (let i = 0; i < DROPS; i += 1) {
        const fall = speeds[i] * dt;
        positions[i * 6 + 1] -= fall;
        positions[i * 6 + 4] -= fall;
        positions[i * 6] -= fall * slant;
        positions[i * 6 + 3] -= fall * slant;
        if (positions[i * 6 + 1] < -top) {
          const x = (Math.random() - 0.5) * bounds.width * 1.2;
          positions[i * 6] = x;
          positions[i * 6 + 1] = top;
          positions[i * 6 + 3] = x + slant * streak;
          positions[i * 6 + 4] = top + streak;
        }
      }
      attr.needsUpdate = true;
      material.opacity = 0.26 * envelope;
    },
    dispose: () => {
      geometry.dispose();
      material.dispose();
      scene.remove(rain);
    }
  };
}

/** Modern — out-of-focus city bokeh drifting like lights past a window. */
function bokehLayer(scene: THREE.Scene, visual: ThemeVisual, bounds: ThemeLayerBounds): ThemeLayer {
  const texture = makeGlowTexture();
  const palette = [visual.accent, visual.secondary, "#ffffff"];
  const discs: Array<{ sprite: THREE.Sprite; material: THREE.SpriteMaterial; y: number; z: number; speed: number; seed: number; base: number }> = [];
  for (let i = 0; i < 9; i += 1) {
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 0,
      color: new THREE.Color(palette[i % palette.length]),
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.setScalar(0.7 + Math.random() * 1.7);
    scene.add(sprite);
    discs.push({
      sprite,
      material,
      y: (Math.random() - 0.5) * bounds.height * 0.9,
      z: bounds.z - Math.random() * 3,
      speed: 0.35 + Math.random() * 0.6,
      seed: Math.random() * 120,
      base: 0.1 + Math.random() * 0.12
    });
  }
  const half = bounds.width * 0.5 + 2;
  return {
    update: (t, _dt, envelope) => {
      for (const disc of discs) {
        const x = ((disc.seed + t * disc.speed) % (half * 2)) - half;
        disc.sprite.position.set(x, disc.y + Math.sin(t * 0.2 + disc.seed) * 0.7, disc.z);
        disc.material.opacity = disc.base * (0.7 + 0.3 * Math.sin(t * 0.5 + disc.seed)) * envelope;
      }
    },
    dispose: () => {
      texture.dispose();
      for (const disc of discs) {
        disc.material.dispose();
        scene.remove(disc.sprite);
      }
    }
  };
}

/** Western — dust gusts ride a hot lateral wind in waves. */
function dustLayer(scene: THREE.Scene, visual: ThemeVisual, bounds: ThemeLayerBounds): ThemeLayer {
  const texture = makeStreakTexture();
  const gusts: Array<{ mesh: THREE.Mesh; material: THREE.MeshBasicMaterial; y: number; z: number; speed: number; seed: number }> = [];
  for (let i = 0; i < 10; i += 1) {
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0,
      color: new THREE.Color(visual.dust.color),
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(4.5 + Math.random() * 4, 0.5 + Math.random() * 0.7), material);
    gusts.push({
      mesh,
      material,
      y: -bounds.height * 0.42 + Math.random() * bounds.height * 0.7,
      z: bounds.z - Math.random() * 3,
      speed: 2.4 + Math.random() * 2.6,
      seed: Math.random() * 150
    });
    scene.add(mesh);
  }
  const half = bounds.width * 0.5 + 5;
  return {
    update: (t, _dt, envelope) => {
      // Gusts arrive in waves — the prairie wind picks up, carries, and dies.
      const wind = 0.45 + 0.55 * Math.pow(Math.max(0, Math.sin(t * 0.17 + 1)), 2);
      for (const gust of gusts) {
        const x = ((gust.seed + t * gust.speed * (0.6 + wind * 0.8)) % (half * 2)) - half;
        gust.mesh.position.set(x, gust.y + Math.sin(t * 0.4 + gust.seed) * 0.5, gust.z);
        gust.mesh.rotation.z = Math.sin(t * 0.23 + gust.seed) * 0.05;
        gust.material.opacity = 0.14 * wind * envelope;
      }
    },
    dispose: () => {
      texture.dispose();
      for (const gust of gusts) {
        gust.mesh.geometry.dispose();
        gust.material.dispose();
        scene.remove(gust.mesh);
      }
    }
  };
}

/** Post-apocalypse — ash sifts down through dead air; a faint haze hangs low. */
function ashLayer(scene: THREE.Scene, visual: ThemeVisual, bounds: ThemeLayerBounds): ThemeLayer {
  const texture = makeGlowTexture();
  const flakes: Array<{ sprite: THREE.Sprite; material: THREE.SpriteMaterial; x: number; speed: number; seed: number }> = [];
  for (let i = 0; i < 26; i += 1) {
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 0,
      // Ash is unlit debris, not lightning bugs — normal blending, muted grey-brown.
      color: new THREE.Color(visual.dust.color).multiplyScalar(0.55),
      depthWrite: false
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.setScalar(0.05 + Math.random() * 0.09);
    scene.add(sprite);
    flakes.push({
      sprite,
      material,
      x: (Math.random() - 0.5) * bounds.width * 1.1,
      speed: 0.05 + Math.random() * 0.07,
      seed: Math.random() * Math.PI * 2
    });
  }
  return {
    update: (t, _dt, envelope) => {
      flakes.forEach((flake, index) => {
        const path = ((t * flake.speed + index / flakes.length) % 1 + 1) % 1;
        flake.sprite.position.set(
          // Ash falls the way paper does — sway widening as it descends.
          flake.x + Math.sin(t * 0.5 + flake.seed) * (0.4 + path * 1.1),
          bounds.height * 0.55 - path * bounds.height * 1.1,
          bounds.z - 1 - (index % 4)
        );
        flake.material.opacity = Math.sin(path * Math.PI) * 0.5 * envelope;
      });
    },
    dispose: () => {
      texture.dispose();
      for (const flake of flakes) {
        flake.material.dispose();
        scene.remove(flake.sprite);
      }
    }
  };
}
