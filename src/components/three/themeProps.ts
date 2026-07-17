"use client";

import * as THREE from "three";
import type { ThemeKey, ThemeVisual } from "./themeVisuals";

/**
 * Signature props — the one unmistakable 3D landmark each campaign theme
 * plants among the drifting dice. Where themeLayers.ts paints the weather
 * (auroras, rain, ash), this module builds the hero object that sells the
 * genre at a glance: an enchanted blade for fantasy, an orbital station with
 * a circling shuttle for scifi, a guttering candelabra for horror, a lone
 * streetlamp for noir, a patrol drone for modern, a rolling tumbleweed for
 * the frontier, and a snapped beacon mast for the wasteland. One prop per
 * scene, built from cheap primitives, driven by one `update(t, dt, drive)`.
 */

export type ThemeProp = {
  /** Advance the prop. `drive` is the scene's energy multiplier (~0.4..1.3). */
  update: (t: number, dt: number, drive: number) => void;
  dispose: () => void;
};

/** Which scene the prop dresses — the lobby cosmos or the Weaving loom. */
export type ThemePropContext = "cosmos" | "loom";

type Placement = { position: [number, number, number]; scale: number };

/**
 * Where each theme's landmark sits. The cosmos camera rests near (0, 0.4, 11)
 * looking a little past the origin, with the lobby UI owning the middle of
 * the frame, so props live in the right-hand third (the tumbleweed instead
 * rolls the whole width of the floor). The loom camera orbits (0,0,0) from
 * z≈14, so loom props stand further out, clear of the great rings.
 */
const PLACEMENTS: Record<ThemePropContext, Partial<Record<ThemeKey, Placement>>> = {
  cosmos: {
    fantasy: { position: [6.2, 1.4, -5], scale: 1.1 },
    scifi: { position: [6.9, 1.6, -6.5], scale: 1.15 },
    horror: { position: [5.9, -2.3, -4], scale: 1.25 },
    noir: { position: [6.3, -0.3, -5], scale: 1.3 },
    modern: { position: [6.1, 2.3, -5], scale: 1.2 },
    western: { position: [0, -5.2, -5], scale: 1.2 },
    postapoc: { position: [6.5, -0.9, -6], scale: 1.2 }
  },
  loom: {
    fantasy: { position: [7.4, 2.8, -3], scale: 0.8 },
    scifi: { position: [7.8, 3, -4], scale: 0.85 },
    horror: { position: [7.2, -3.2, -2], scale: 0.85 },
    noir: { position: [7.8, -0.2, -3], scale: 0.9 },
    modern: { position: [7.4, 3.2, -3], scale: 0.8 },
    western: { position: [0, -5, -2], scale: 0.9 },
    postapoc: { position: [7.9, -0.5, -4], scale: 0.85 }
  }
};

function hexToRgba(hex: string, alpha: number) {
  const color = new THREE.Color(hex);
  return `rgba(${Math.round(color.r * 255)},${Math.round(color.g * 255)},${Math.round(color.b * 255)},${alpha})`;
}

/** Soft radial glow — flames, beacons, engine wash, lamp halos. */
function makeGlowTexture(inner: string, outer: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
  gradient.addColorStop(0, inner);
  gradient.addColorStop(1, outer);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(canvas);
}

type BuiltProp = {
  group: THREE.Group;
  update: (t: number, dt: number, drive: number) => void;
  dispose: () => void;
};

/** Additive glow sprite that ignores fog so it punches through the murk. */
function makeGlowSprite(
  texture: THREE.CanvasTexture,
  color: string,
  disposables: Array<{ dispose: () => void }>
) {
  const material = new THREE.SpriteMaterial({
    map: texture,
    color: new THREE.Color(color),
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false
  });
  disposables.push(material);
  return { sprite: new THREE.Sprite(material), material };
}

/* ------------------------------------------------------------------ */
/* Fantasy — an enchanted blade hangs point-down, turning slowly,      */
/* wrapped in a lazy spiral of sparks.                                 */
/* ------------------------------------------------------------------ */
function swordProp(visual: ThemeVisual): BuiltProp {
  const group = new THREE.Group();
  const content = new THREE.Group();
  group.add(content);
  const disposables: Array<{ dispose: () => void }> = [];

  const steel = new THREE.MeshStandardMaterial({
    color: 0xd9dfef,
    roughness: 0.22,
    metalness: 0.9,
    emissive: new THREE.Color(visual.accent),
    emissiveIntensity: 0.14
  });
  const gold = new THREE.MeshStandardMaterial({
    color: new THREE.Color(visual.accent),
    roughness: 0.35,
    metalness: 0.85,
    emissive: new THREE.Color(visual.accent),
    emissiveIntensity: 0.25
  });
  const leather = new THREE.MeshStandardMaterial({ color: 0x2a1c30, roughness: 0.75, metalness: 0.2 });
  disposables.push(steel, gold, leather);

  // A stretched octahedron reads as a double-edged blade with a clean point.
  const bladeGeometry = new THREE.OctahedronGeometry(1, 0);
  const blade = new THREE.Mesh(bladeGeometry, steel);
  blade.scale.set(0.17, 1.05, 0.055);
  blade.position.y = -0.35;
  content.add(blade);
  const guardGeometry = new THREE.BoxGeometry(0.72, 0.1, 0.15);
  const guard = new THREE.Mesh(guardGeometry, gold);
  guard.position.y = 0.72;
  content.add(guard);
  const gripGeometry = new THREE.CylinderGeometry(0.055, 0.05, 0.5, 10);
  const grip = new THREE.Mesh(gripGeometry, leather);
  grip.position.y = 1.02;
  content.add(grip);
  const pommelGeometry = new THREE.SphereGeometry(0.1, 12, 10);
  const pommel = new THREE.Mesh(pommelGeometry, gold);
  pommel.position.y = 1.32;
  content.add(pommel);
  disposables.push(bladeGeometry, guardGeometry, gripGeometry, pommelGeometry);

  const glowTexture = makeGlowTexture(hexToRgba(visual.accentBright, 0.7), hexToRgba(visual.accent, 0));
  disposables.push(glowTexture);
  const { sprite: glow, material: glowMaterial } = makeGlowSprite(glowTexture, visual.accentBright, disposables);
  glow.position.y = -0.35;
  glow.scale.setScalar(2);
  content.add(glow);

  // Sparks spiral the blade on a fixed lattice; spinning the whole cloud is
  // far cheaper than re-writing positions and reads identically from afar.
  const SPARKS = 26;
  const sparkPositions = new Float32Array(SPARKS * 3);
  for (let i = 0; i < SPARKS; i += 1) {
    const angle = (i / SPARKS) * Math.PI * 6;
    const radius = 0.45 + (i % 5) * 0.12;
    sparkPositions[i * 3] = Math.cos(angle) * radius;
    sparkPositions[i * 3 + 1] = -1.25 + (i / SPARKS) * 2.5;
    sparkPositions[i * 3 + 2] = Math.sin(angle) * radius;
  }
  const sparkGeometry = new THREE.BufferGeometry();
  sparkGeometry.setAttribute("position", new THREE.BufferAttribute(sparkPositions, 3));
  const sparkMaterial = new THREE.PointsMaterial({
    color: new THREE.Color(visual.accentBright),
    size: 0.06,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
    fog: false
  });
  const sparks = new THREE.Points(sparkGeometry, sparkMaterial);
  content.add(sparks);
  disposables.push(sparkGeometry, sparkMaterial);

  return {
    group,
    update: (t) => {
      content.rotation.y = t * 0.45;
      content.rotation.z = Math.sin(t * 0.4) * 0.06;
      content.position.y = Math.sin(t * 0.8) * 0.22;
      sparks.rotation.y = -t * 0.9;
      sparkMaterial.opacity = 0.55 + Math.sin(t * 2.6) * 0.25;
      glowMaterial.opacity = 0.3 + Math.sin(t * 1.4) * 0.12;
    },
    dispose: () => {
      for (const item of disposables) item.dispose();
    }
  };
}

/* ------------------------------------------------------------------ */
/* Scifi — an orbital ring station turns over the table while a tiny   */
/* shuttle runs its patrol lap, running lights chasing round the hull. */
/* ------------------------------------------------------------------ */
function stationProp(visual: ThemeVisual): BuiltProp {
  const group = new THREE.Group();
  const content = new THREE.Group();
  content.rotation.x = 0.5;
  group.add(content);
  const disposables: Array<{ dispose: () => void }> = [];

  const hull = new THREE.MeshStandardMaterial({
    color: 0x22384e,
    roughness: 0.3,
    metalness: 0.9,
    emissive: new THREE.Color(visual.accent),
    emissiveIntensity: 0.18
  });
  disposables.push(hull);

  const ringGroup = new THREE.Group();
  content.add(ringGroup);
  const ringGeometry = new THREE.TorusGeometry(1.35, 0.085, 10, 48);
  ringGroup.add(new THREE.Mesh(ringGeometry, hull));
  disposables.push(ringGeometry);
  const spokeGeometry = new THREE.CylinderGeometry(0.03, 0.03, 2.62, 6);
  for (let i = 0; i < 4; i += 1) {
    const spoke = new THREE.Mesh(spokeGeometry, hull);
    spoke.rotation.z = (i / 4) * Math.PI;
    ringGroup.add(spoke);
  }
  disposables.push(spokeGeometry);
  const hubGeometry = new THREE.SphereGeometry(0.34, 16, 12);
  ringGroup.add(new THREE.Mesh(hubGeometry, hull));
  disposables.push(hubGeometry);

  // Outer halo ring on its own tilt, counter-rotating.
  const haloGeometry = new THREE.TorusGeometry(1.8, 0.035, 8, 56);
  const halo = new THREE.Mesh(haloGeometry, hull);
  halo.rotation.x = 1.1;
  content.add(halo);
  disposables.push(haloGeometry);

  // Running lights chase each other around the main ring.
  const beaconTexture = makeGlowTexture(hexToRgba(visual.accentBright, 0.95), hexToRgba(visual.accent, 0));
  disposables.push(beaconTexture);
  const beacons: THREE.SpriteMaterial[] = [];
  for (let i = 0; i < 8; i += 1) {
    const { sprite, material } = makeGlowSprite(beaconTexture, visual.accentBright, disposables);
    const angle = (i / 8) * Math.PI * 2;
    sprite.position.set(Math.cos(angle) * 1.35, Math.sin(angle) * 1.35, 0);
    sprite.scale.setScalar(0.22);
    ringGroup.add(sprite);
    beacons.push(material);
  }

  // The patrol shuttle: a cone nosing along its orbit, engine wash behind.
  const shuttleOrbit = new THREE.Group();
  content.add(shuttleOrbit);
  const shuttleGeometry = new THREE.ConeGeometry(0.07, 0.28, 8);
  const shuttle = new THREE.Mesh(shuttleGeometry, hull);
  shuttle.position.set(2.3, 0, 0);
  shuttleOrbit.add(shuttle);
  disposables.push(shuttleGeometry);
  const { sprite: engine, material: engineMaterial } = makeGlowSprite(beaconTexture, visual.secondary, disposables);
  engine.position.set(2.3, -0.2, 0);
  engine.scale.setScalar(0.3);
  shuttleOrbit.add(engine);

  return {
    group,
    update: (t, dt, drive) => {
      ringGroup.rotation.z += dt * 0.5 * (0.7 + drive * 0.3);
      halo.rotation.z -= dt * 0.3;
      shuttleOrbit.rotation.z += dt * 0.85;
      content.rotation.y = Math.sin(t * 0.12) * 0.35;
      content.position.y = Math.sin(t * 0.5) * 0.15;
      beacons.forEach((material, index) => {
        material.opacity = 0.12 + Math.pow(Math.max(0, Math.sin(t * 2.4 - index * (Math.PI / 4))), 6) * 0.85;
      });
      engineMaterial.opacity = 0.5 + Math.sin(t * 9) * 0.2;
    },
    dispose: () => {
      for (const item of disposables) item.dispose();
    }
  };
}

/* ------------------------------------------------------------------ */
/* Horror — a tarnished candelabra whose three flames burn the theme's */
/* sickly green and gutter independently, throwing real light.         */
/* ------------------------------------------------------------------ */
function candelabraProp(visual: ThemeVisual): BuiltProp {
  const group = new THREE.Group();
  const content = new THREE.Group();
  group.add(content);
  const disposables: Array<{ dispose: () => void }> = [];

  const metal = new THREE.MeshStandardMaterial({
    color: 0x241a12,
    roughness: 0.55,
    metalness: 0.75,
    emissive: new THREE.Color(visual.accent),
    emissiveIntensity: 0.05
  });
  const wax = new THREE.MeshStandardMaterial({ color: 0xd9d2ba, roughness: 0.9, metalness: 0 });
  disposables.push(metal, wax);

  const baseGeometry = new THREE.CylinderGeometry(0.32, 0.44, 0.08, 16);
  const base = new THREE.Mesh(baseGeometry, metal);
  base.position.y = -0.85;
  content.add(base);
  const stemGeometry = new THREE.CylinderGeometry(0.045, 0.055, 1.2, 10);
  const stem = new THREE.Mesh(stemGeometry, metal);
  stem.position.y = -0.2;
  content.add(stem);
  // Half-torus rotated to open upward — both arms in one sweep.
  const armGeometry = new THREE.TorusGeometry(0.42, 0.03, 8, 24, Math.PI);
  const arms = new THREE.Mesh(armGeometry, metal);
  arms.rotation.z = Math.PI;
  arms.position.y = 0.34;
  content.add(arms);
  disposables.push(baseGeometry, stemGeometry, armGeometry);

  const cupGeometry = new THREE.CylinderGeometry(0.08, 0.06, 0.06, 10);
  const candleTallGeometry = new THREE.CylinderGeometry(0.055, 0.065, 0.55, 10);
  const candleShortGeometry = new THREE.CylinderGeometry(0.05, 0.06, 0.38, 10);
  disposables.push(cupGeometry, candleTallGeometry, candleShortGeometry);
  const flameTexture = makeGlowTexture(hexToRgba(visual.accentBright, 0.95), hexToRgba(visual.accent, 0));
  disposables.push(flameTexture);

  const flames: Array<{ inner: THREE.Sprite; innerMaterial: THREE.SpriteMaterial; haloMaterial: THREE.SpriteMaterial; seed: number }> = [];
  const seats: Array<[number, number, boolean]> = [
    [-0.42, 0.38, false],
    [0, 0.62, true],
    [0.42, 0.38, false]
  ];
  for (const [x, y, tall] of seats) {
    const cup = new THREE.Mesh(cupGeometry, metal);
    cup.position.set(x, y, 0);
    content.add(cup);
    const candle = new THREE.Mesh(tall ? candleTallGeometry : candleShortGeometry, wax);
    const height = tall ? 0.55 : 0.38;
    candle.position.set(x, y + 0.03 + height / 2, 0);
    content.add(candle);
    const tip = y + 0.03 + height + 0.06;
    const { sprite: inner, material: innerMaterial } = makeGlowSprite(flameTexture, visual.accentBright, disposables);
    inner.position.set(x, tip, 0);
    inner.scale.set(0.12, 0.2, 1);
    content.add(inner);
    const { sprite: halo, material: haloMaterial } = makeGlowSprite(flameTexture, visual.accent, disposables);
    halo.position.set(x, tip + 0.04, 0);
    halo.scale.setScalar(0.55);
    content.add(halo);
    flames.push({ inner, innerMaterial, haloMaterial, seed: x * 7.3 + y });
  }

  const light = new THREE.PointLight(new THREE.Color(visual.accent), 8, 8, 2);
  light.position.set(0, 1.1, 0.4);
  content.add(light);

  return {
    group,
    update: (t) => {
      let glowSum = 0;
      for (const flame of flames) {
        // Two incommensurate sines per flame — each candle gutters alone.
        const flick = 0.62 + 0.38 * Math.sin(t * 11 + flame.seed * 2.4) * Math.sin(t * 3.7 + flame.seed);
        glowSum += flick;
        flame.innerMaterial.opacity = 0.15 + flick * 0.75;
        flame.inner.scale.set(0.12, 0.15 + flick * 0.1, 1);
        flame.haloMaterial.opacity = 0.06 + flick * 0.26;
      }
      light.intensity = 3 + (glowSum / flames.length) * 7;
      content.rotation.z = Math.sin(t * 0.3) * 0.03;
      content.position.y = Math.sin(t * 0.5) * 0.1;
    },
    dispose: () => {
      for (const item of disposables) item.dispose();
    }
  };
}

/* ------------------------------------------------------------------ */
/* Noir — a lone streetlamp buzzing in the rain, its cone of light     */
/* the only warm thing on the block.                                   */
/* ------------------------------------------------------------------ */
function streetlampProp(visual: ThemeVisual): BuiltProp {
  const group = new THREE.Group();
  const content = new THREE.Group();
  group.add(content);
  const disposables: Array<{ dispose: () => void }> = [];

  const iron = new THREE.MeshStandardMaterial({ color: 0x11151c, roughness: 0.45, metalness: 0.85 });
  disposables.push(iron);

  const poleGeometry = new THREE.CylinderGeometry(0.045, 0.065, 3.5, 10);
  content.add(new THREE.Mesh(poleGeometry, iron));
  const plinthGeometry = new THREE.CylinderGeometry(0.1, 0.14, 0.22, 12);
  const plinth = new THREE.Mesh(plinthGeometry, iron);
  plinth.position.y = -1.72;
  content.add(plinth);
  const armGeometry = new THREE.CylinderGeometry(0.032, 0.032, 0.66, 8);
  const arm = new THREE.Mesh(armGeometry, iron);
  arm.rotation.z = Math.PI / 2;
  arm.position.set(0.3, 1.72, 0);
  content.add(arm);
  const shadeGeometry = new THREE.CylinderGeometry(0.03, 0.24, 0.16, 12);
  const shade = new THREE.Mesh(shadeGeometry, iron);
  shade.position.set(0.62, 1.64, 0);
  content.add(shade);
  disposables.push(poleGeometry, plinthGeometry, armGeometry, shadeGeometry);

  const bulbGeometry = new THREE.SphereGeometry(0.055, 10, 8);
  const bulbMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color(visual.accentBright),
    transparent: true,
    opacity: 0.9,
    fog: false
  });
  const bulb = new THREE.Mesh(bulbGeometry, bulbMaterial);
  bulb.position.set(0.62, 1.54, 0);
  content.add(bulb);
  disposables.push(bulbGeometry, bulbMaterial);

  const glowTexture = makeGlowTexture(hexToRgba(visual.accentBright, 0.85), hexToRgba(visual.accent, 0));
  disposables.push(glowTexture);
  const { sprite: halo, material: haloMaterial } = makeGlowSprite(glowTexture, visual.accentBright, disposables);
  halo.position.copy(bulb.position);
  halo.scale.setScalar(1.1);
  content.add(halo);

  const coneGeometry = new THREE.ConeGeometry(0.8, 2.4, 20, 1, true);
  const coneMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color(visual.accent),
    transparent: true,
    opacity: 0.06,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false
  });
  const cone = new THREE.Mesh(coneGeometry, coneMaterial);
  cone.position.set(0.62, 0.34, 0);
  content.add(cone);
  disposables.push(coneGeometry, coneMaterial);

  return {
    group,
    update: (t) => {
      // High-frequency interference = the electric buzz; the beat of two
      // slow sines occasionally crosses the threshold and the lamp browns out.
      const buzz = 0.78 + 0.22 * Math.sin(t * 31) * Math.sin(t * 7.1);
      const dip = Math.max(0, Math.sin(t * 0.83) * Math.sin(t * 1.7 + 2) - 0.93) / 0.07;
      const level = buzz * (1 - dip * 0.7);
      haloMaterial.opacity = 0.55 * level;
      coneMaterial.opacity = 0.07 * level;
      bulbMaterial.opacity = 0.9 * level;
      cone.rotation.z = Math.sin(t * 0.5) * 0.02;
      content.position.y = Math.sin(t * 0.6) * 0.08;
    },
    dispose: () => {
      for (const item of disposables) item.dispose();
    }
  };
}

/* ------------------------------------------------------------------ */
/* Modern — a surveillance drone holds a hover: rotors blurring, nav   */
/* lights blinking, a faint scan cone sweeping the ground below.       */
/* ------------------------------------------------------------------ */
function droneProp(visual: ThemeVisual): BuiltProp {
  const group = new THREE.Group();
  const content = new THREE.Group();
  group.add(content);
  const disposables: Array<{ dispose: () => void }> = [];

  const shell = new THREE.MeshStandardMaterial({
    color: 0x0d1418,
    roughness: 0.35,
    metalness: 0.7,
    emissive: new THREE.Color(visual.accent),
    emissiveIntensity: 0.12
  });
  disposables.push(shell);

  const bodyGeometry = new THREE.SphereGeometry(0.26, 16, 12);
  const body = new THREE.Mesh(bodyGeometry, shell);
  body.scale.y = 0.55;
  content.add(body);
  const lensGeometry = new THREE.SphereGeometry(0.07, 10, 8);
  const lensMaterial = new THREE.MeshStandardMaterial({
    color: 0x061a20,
    roughness: 0.1,
    metalness: 0.4,
    emissive: new THREE.Color(visual.secondary),
    emissiveIntensity: 0.3
  });
  const lens = new THREE.Mesh(lensGeometry, lensMaterial);
  lens.position.set(0, -0.03, 0.24);
  content.add(lens);
  disposables.push(bodyGeometry, lensGeometry, lensMaterial);

  const armGeometry = new THREE.BoxGeometry(0.78, 0.028, 0.05);
  for (const angle of [Math.PI / 4, -Math.PI / 4]) {
    const arm = new THREE.Mesh(armGeometry, shell);
    arm.rotation.y = angle;
    arm.position.y = 0.06;
    content.add(arm);
  }
  disposables.push(armGeometry);

  // Rotor = translucent blur disc + one visible blade whipping around in it.
  const discGeometry = new THREE.CylinderGeometry(0.15, 0.15, 0.014, 18);
  const bladeGeometry = new THREE.BoxGeometry(0.28, 0.012, 0.03);
  disposables.push(discGeometry, bladeGeometry);
  const rotors: Array<{ blade: THREE.Mesh; disc: THREE.MeshBasicMaterial; seed: number }> = [];
  const corners: Array<[number, number]> = [
    [0.28, 0.28],
    [0.28, -0.28],
    [-0.28, 0.28],
    [-0.28, -0.28]
  ];
  corners.forEach(([x, z], index) => {
    const discMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(visual.accent),
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false
    });
    const disc = new THREE.Mesh(discGeometry, discMaterial);
    disc.position.set(x, 0.11, z);
    content.add(disc);
    const blade = new THREE.Mesh(bladeGeometry, shell);
    blade.position.set(x, 0.12, z);
    content.add(blade);
    rotors.push({ blade, disc: discMaterial, seed: index * 1.7 });
    disposables.push(discMaterial);
  });

  const ledTexture = makeGlowTexture("rgba(255,255,255,0.95)", "rgba(255,255,255,0)");
  disposables.push(ledTexture);
  const { sprite: ledFront, material: ledFrontMaterial } = makeGlowSprite(ledTexture, visual.accent, disposables);
  ledFront.position.set(0, 0.02, 0.3);
  ledFront.scale.setScalar(0.12);
  content.add(ledFront);
  const { sprite: ledRear, material: ledRearMaterial } = makeGlowSprite(ledTexture, visual.secondary, disposables);
  ledRear.position.set(0, 0.02, -0.3);
  ledRear.scale.setScalar(0.12);
  content.add(ledRear);

  const scanPivot = new THREE.Group();
  content.add(scanPivot);
  const scanGeometry = new THREE.ConeGeometry(0.55, 1.7, 16, 1, true);
  const scanMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color(visual.accent),
    transparent: true,
    opacity: 0.05,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false
  });
  const scan = new THREE.Mesh(scanGeometry, scanMaterial);
  scan.position.y = -0.95;
  scanPivot.add(scan);
  disposables.push(scanGeometry, scanMaterial);

  return {
    group,
    update: (t, dt) => {
      content.position.y = Math.sin(t * 1.3) * 0.16;
      content.rotation.z = Math.sin(t * 0.7) * 0.08;
      content.rotation.x = Math.cos(t * 0.9) * 0.06;
      content.rotation.y = Math.sin(t * 0.21) * 0.7;
      for (const rotor of rotors) {
        rotor.blade.rotation.y += dt * (26 + rotor.seed);
        rotor.disc.opacity = 0.18 + 0.1 * Math.sin(t * 40 + rotor.seed * 9);
      }
      ledFrontMaterial.opacity = Math.pow(Math.max(0, Math.sin(t * 3)), 8);
      ledRearMaterial.opacity = Math.pow(Math.max(0, Math.sin(t * 3 + Math.PI)), 8);
      scanPivot.rotation.z = Math.sin(t * 0.45) * 0.3;
      scanPivot.rotation.x = Math.cos(t * 0.32) * 0.2;
      scanMaterial.opacity = 0.05 + 0.02 * Math.sin(t * 1.1);
    },
    dispose: () => {
      for (const item of disposables) item.dispose();
    }
  };
}

/* ------------------------------------------------------------------ */
/* Western — a tumbleweed rolls the width of the scene on the gusting  */
/* prairie wind, hopping when the wind picks up, then rolls in again.  */
/* ------------------------------------------------------------------ */
function tumbleweedProp(visual: ThemeVisual, context: ThemePropContext): BuiltProp {
  const group = new THREE.Group();
  const content = new THREE.Group();
  group.add(content);
  const disposables: Array<{ dispose: () => void }> = [];
  const half = context === "cosmos" ? 9 : 10;

  const weed = new THREE.Group();
  content.add(weed);
  const outerSource = new THREE.IcosahedronGeometry(0.5, 1);
  const outerGeometry = new THREE.EdgesGeometry(outerSource);
  outerSource.dispose();
  const outerMaterial = new THREE.LineBasicMaterial({
    color: new THREE.Color(visual.dust.color),
    transparent: true,
    opacity: 0.85
  });
  weed.add(new THREE.LineSegments(outerGeometry, outerMaterial));
  const innerSource = new THREE.IcosahedronGeometry(0.32, 0);
  const innerGeometry = new THREE.EdgesGeometry(innerSource);
  innerSource.dispose();
  const innerMaterial = new THREE.LineBasicMaterial({ color: 0x8a6242, transparent: true, opacity: 0.6 });
  const inner = new THREE.LineSegments(innerGeometry, innerMaterial);
  inner.rotation.set(0.7, 1.9, 0.4);
  weed.add(inner);
  disposables.push(outerGeometry, outerMaterial, innerGeometry, innerMaterial);

  let x = -half;
  let hop = 0;

  return {
    group,
    update: (t, dt, drive) => {
      // The same wind-wave the western dust layer rides.
      const gust = 0.55 + 0.45 * Math.pow(Math.max(0, Math.sin(t * 0.17 + 1)), 2);
      const speed = (1.6 + gust * 2.6) * (0.6 + drive * 0.5);
      x += speed * dt;
      if (x > half) x = -half - 1;
      hop += dt * speed * 1.1;
      weed.position.x = x;
      weed.position.y = 0.5 + Math.abs(Math.sin(hop)) * 0.22 * gust;
      weed.rotation.z -= (speed * dt) / 0.5 * 0.8;
      weed.rotation.x = Math.sin(t * 1.7) * 0.18;
    },
    dispose: () => {
      for (const item of disposables) item.dispose();
    }
  };
}

/* ------------------------------------------------------------------ */
/* Post-apocalypse — a snapped transmission mast leans into the ash,   */
/* hazard beacon still pulsing, a loose wire arcing now and then.      */
/* ------------------------------------------------------------------ */
function towerProp(visual: ThemeVisual): BuiltProp {
  const group = new THREE.Group();
  const content = new THREE.Group();
  content.rotation.z = 0.14;
  group.add(content);
  const disposables: Array<{ dispose: () => void }> = [];

  const rust = new THREE.MeshStandardMaterial({
    color: 0x38291c,
    roughness: 0.9,
    metalness: 0.45,
    emissive: new THREE.Color(visual.accent),
    emissiveIntensity: 0.06
  });
  disposables.push(rust);

  const mastGeometry = new THREE.CylinderGeometry(0.05, 0.1, 3.1, 8);
  content.add(new THREE.Mesh(mastGeometry, rust));
  disposables.push(mastGeometry);
  for (let i = 0; i < 3; i += 1) {
    const barGeometry = new THREE.BoxGeometry(0.72 - i * 0.14, 0.04, 0.04);
    const bar = new THREE.Mesh(barGeometry, rust);
    bar.position.y = -0.8 + i * 0.85;
    bar.rotation.y = i * 0.7;
    content.add(bar);
    disposables.push(barGeometry);
  }
  // The snapped top section dangles off-axis where the mast gave way.
  const tipGeometry = new THREE.CylinderGeometry(0.03, 0.045, 0.75, 8);
  const tip = new THREE.Mesh(tipGeometry, rust);
  tip.position.set(0.18, 1.75, 0);
  tip.rotation.z = 0.85;
  content.add(tip);
  disposables.push(tipGeometry);

  const beaconTexture = makeGlowTexture("rgba(255,110,70,0.95)", "rgba(255,80,40,0)");
  disposables.push(beaconTexture);
  const { sprite: beacon, material: beaconMaterial } = makeGlowSprite(beaconTexture, "#ff6a3c", disposables);
  beacon.position.set(0.02, 1.58, 0);
  content.add(beacon);
  const beaconLight = new THREE.PointLight(0xff5a30, 0, 6, 2);
  beaconLight.position.set(0, 1.6, 0.3);
  content.add(beaconLight);

  const { sprite: spark, material: sparkMaterial } = makeGlowSprite(beaconTexture, "#ffe9c9", disposables);
  spark.position.set(0.14, 1.5, 0);
  spark.scale.setScalar(0.16);
  content.add(spark);

  return {
    group,
    update: (t) => {
      const pulse = Math.pow(Math.max(0, Math.sin(t * 1.5)), 4);
      beaconMaterial.opacity = 0.08 + pulse * 0.85;
      beacon.scale.setScalar(0.5 + pulse * 0.25);
      beaconLight.intensity = pulse * 8;
      // Three incommensurate sines only align rarely — a stray arc of current.
      const arc = Math.sin(t * 7.3) * Math.sin(t * 3.1 + 2) * Math.sin(t * 0.9 + 5);
      sparkMaterial.opacity = (Math.max(0, arc - 0.82) / 0.18) * 0.9;
      content.rotation.z = 0.14 + Math.sin(t * 0.26) * 0.012;
    },
    dispose: () => {
      for (const item of disposables) item.dispose();
    }
  };
}

/**
 * Build the theme's signature prop into `scene`, placed for the given
 * context. Returns null for themes with no landmark ("none"). Callers own
 * the frame loop: call `update` each frame and `dispose` on teardown.
 */
export function createThemeProp(
  scene: THREE.Scene,
  visual: ThemeVisual,
  context: ThemePropContext
): ThemeProp | null {
  const placement = PLACEMENTS[context][visual.key];
  if (!placement) return null;
  let built: BuiltProp | null = null;
  switch (visual.key) {
    case "fantasy":
      built = swordProp(visual);
      break;
    case "scifi":
      built = stationProp(visual);
      break;
    case "horror":
      built = candelabraProp(visual);
      break;
    case "noir":
      built = streetlampProp(visual);
      break;
    case "modern":
      built = droneProp(visual);
      break;
    case "western":
      built = tumbleweedProp(visual, context);
      break;
    case "postapoc":
      built = towerProp(visual);
      break;
    default:
      built = null;
  }
  if (!built) return null;
  const { group, update, dispose } = built;
  group.position.set(...placement.position);
  group.scale.setScalar(placement.scale);
  scene.add(group);
  return {
    update,
    dispose: () => {
      dispose();
      scene.remove(group);
    }
  };
}
