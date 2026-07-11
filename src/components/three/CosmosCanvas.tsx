"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { themeVisual, ThemeKey } from "@/components/three/themeVisuals";

/** Soft radial glow used for nebulae, bokeh, suns, and shooting-star heads. */
function makeGlowTexture(inner: string, outer: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(128, 128, 8, 128, 128, 128);
  gradient.addColorStop(0, inner);
  gradient.addColorStop(1, outer);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(canvas);
}

/** Horizontal streak texture for shooting stars (bright head, long tail). */
function makeStreakTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 32;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createLinearGradient(0, 0, 256, 0);
  gradient.addColorStop(0, "rgba(255,255,255,0)");
  gradient.addColorStop(0.75, "rgba(244,228,189,0.55)");
  gradient.addColorStop(1, "rgba(255,255,255,0.95)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 32);
  return new THREE.CanvasTexture(canvas);
}

/** Vertical curtain gradient for aurora ribbons — bright crest, sheer hem. */
function makeAuroraTexture(top: string, bottom: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createLinearGradient(0, 0, 0, 256);
  gradient.addColorStop(0, top);
  gradient.addColorStop(0.45, bottom);
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 256);
  return new THREE.CanvasTexture(canvas);
}

/** Tall feathered shaft for noir venetian light. */
function makeShaftTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 512;
  const ctx = canvas.getContext("2d")!;
  const vertical = ctx.createLinearGradient(0, 0, 0, 512);
  vertical.addColorStop(0, "rgba(255,255,255,0.65)");
  vertical.addColorStop(0.7, "rgba(255,255,255,0.14)");
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

function hexToRgba(hex: string, alpha: number) {
  const color = new THREE.Color(hex);
  return `rgba(${Math.round(color.r * 255)},${Math.round(color.g * 255)},${Math.round(color.b * 255)},${alpha})`;
}

/**
 * The Astral Table — the ambient scene behind the portal, creation wizard,
 * lobby, and join flow. Great polyhedral dice drift like slow moons through
 * star-dust over sleeping nebulae. When a campaign theme is known the whole
 * sky commits to it: auroras crown a fantasy tale, star-lines streak past a
 * scifi one, rain falls through a noir streetlamp, a low sun burns over the
 * frontier. Pointer movement gives a gentle parallax so the menu floats.
 */
export default function CosmosCanvas({
  accent,
  drama = 0.6,
  theme = "none"
}: {
  accent?: string;
  drama?: number;
  theme?: ThemeKey | string | null;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const dramaRef = useRef(drama);
  dramaRef.current = drama;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const visual = themeVisual(theme);
    // An explicitly passed accent (e.g. a player's color) outranks the theme's.
    const accentHex = accent || visual.accent;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(new THREE.Color(visual.fog), visual.fogDensity);

    const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 100);
    camera.position.set(0, 0.4, 11);

    const accentColor = new THREE.Color(accentHex);
    const secondaryColor = new THREE.Color(visual.secondary);
    const disposables: Array<{ dispose: () => void }> = [];

    // -- lighting --------------------------------------------------------
    scene.add(new THREE.AmbientLight(new THREE.Color(visual.ambient), 1.1));
    const keyLight = new THREE.PointLight(accentColor, 42, 60, 1.9);
    keyLight.position.set(-6, 6, 6);
    scene.add(keyLight);
    const rimLight = new THREE.PointLight(secondaryColor, 16, 50, 2);
    rimLight.position.set(8, -4, -4);
    scene.add(rimLight);

    // -- the drifting dice moons ----------------------------------------
    const solids: Array<{
      group: THREE.Group;
      spin: THREE.Vector3;
      bobPhase: number;
      bobSpeed: number;
      base: THREE.Vector3;
    }> = [];

    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color(visual.dice.body),
      roughness: visual.dice.roughness,
      metalness: visual.dice.metalness,
      flatShading: true,
      transparent: visual.dice.opacity < 1,
      opacity: visual.dice.opacity
    });
    const edgeMaterial = new THREE.LineBasicMaterial({
      color: new THREE.Color(visual.dice.edge),
      transparent: true,
      opacity: visual.dice.edgeOpacity
    });
    disposables.push(bodyMaterial, edgeMaterial);

    const shapes: Array<[THREE.BufferGeometry, number, THREE.Vector3]> = [
      [new THREE.IcosahedronGeometry(1.9, 0), 1, new THREE.Vector3(-4.6, 1.6, -3)],
      [new THREE.DodecahedronGeometry(1.25, 0), 0.8, new THREE.Vector3(4.9, 2.3, -5)],
      [new THREE.OctahedronGeometry(0.95, 0), 0.7, new THREE.Vector3(3.6, -2.2, -2)],
      [new THREE.TetrahedronGeometry(0.85, 0), 0.6, new THREE.Vector3(-3.4, -2.6, -4.5)],
      [new THREE.IcosahedronGeometry(0.7, 0), 0.5, new THREE.Vector3(0.4, 3.4, -7)],
      [new THREE.BoxGeometry(1.05, 1.05, 1.05), 0.6, new THREE.Vector3(-6.4, -0.6, -8)]
    ];

    for (const [geometry, , base] of shapes) {
      const group = new THREE.Group();
      const mesh = new THREE.Mesh(geometry, bodyMaterial);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), edgeMaterial);
      group.add(mesh);
      group.add(edges);
      group.position.copy(base);
      group.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      scene.add(group);
      solids.push({
        group,
        spin: new THREE.Vector3(
          (Math.random() - 0.5) * 0.24,
          (Math.random() - 0.5) * 0.24,
          (Math.random() - 0.5) * 0.18
        ),
        bobPhase: Math.random() * Math.PI * 2,
        bobSpeed: 0.25 + Math.random() * 0.3,
        base: base.clone()
      });
    }

    // -- sleeping nebulae --------------------------------------------------
    const nebulaTextures = visual.nebulae.map((hex, index) =>
      makeGlowTexture(hexToRgba(hex, 0.22 + (index === 0 ? 0.1 : 0.04)), hexToRgba(hex, 0))
    );
    disposables.push(...nebulaTextures);
    const nebulae: THREE.Sprite[] = [];
    const nebulaSeeds: number[] = [];
    const nebulaSpots: Array<[number, number, number, number]> = [
      [-9, 4.5, -16, 22],
      [10, -3, -18, 26],
      [2, 6, -20, 18]
    ];
    nebulaSpots.forEach(([x, y, z, size], index) => {
      const material = new THREE.SpriteMaterial({
        map: nebulaTextures[index % nebulaTextures.length],
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      });
      const sprite = new THREE.Sprite(material);
      sprite.position.set(x, y, z);
      sprite.scale.setScalar(size);
      scene.add(sprite);
      nebulae.push(sprite);
      nebulaSeeds.push(Math.random() * Math.PI * 2);
      disposables.push(material);
    });

    // -- shooting stars ----------------------------------------------------
    const streakTexture = makeStreakTexture();
    disposables.push(streakTexture);
    type Meteor = { mesh: THREE.Mesh; material: THREE.MeshBasicMaterial; life: number; velocity: THREE.Vector3 };
    const meteors: Meteor[] = [];
    for (let i = 0; i < 3; i += 1) {
      const material = new THREE.MeshBasicMaterial({
        map: streakTexture,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 0.07), material);
      mesh.visible = false;
      scene.add(mesh);
      meteors.push({ mesh, material, life: 0, velocity: new THREE.Vector3() });
      disposables.push(mesh.geometry, material);
    }
    let nextMeteorAt = 2 + Math.random() * 4;

    const launchMeteor = () => {
      const meteor = meteors.find((m) => !m.mesh.visible);
      if (!meteor) return;
      const fromLeft = Math.random() < 0.5;
      meteor.mesh.position.set(fromLeft ? -14 : 14, 4 + Math.random() * 5, -10 - Math.random() * 8);
      meteor.velocity.set((fromLeft ? 1 : -1) * (9 + Math.random() * 5), -(2.5 + Math.random() * 2.5), 0);
      // Aligning the plane's +X with the velocity puts the bright head in front.
      meteor.mesh.rotation.z = Math.atan2(meteor.velocity.y, meteor.velocity.x);
      meteor.life = 1.4;
      meteor.mesh.visible = true;
    };

    // -- star dust --------------------------------------------------------
    const DUST_COUNT = 950;
    const dustPositions = new Float32Array(DUST_COUNT * 3);
    const dustSeeds = new Float32Array(DUST_COUNT);
    for (let i = 0; i < DUST_COUNT; i += 1) {
      dustPositions[i * 3] = (Math.random() - 0.5) * 34;
      dustPositions[i * 3 + 1] = (Math.random() - 0.5) * 20;
      dustPositions[i * 3 + 2] = -Math.random() * 22;
      dustSeeds[i] = Math.random() * Math.PI * 2;
    }
    const dustGeometry = new THREE.BufferGeometry();
    dustGeometry.setAttribute("position", new THREE.BufferAttribute(dustPositions, 3));
    const dustMaterial = new THREE.PointsMaterial({
      color: new THREE.Color(visual.dust.color),
      size: visual.dust.size,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true
    });
    const dust = new THREE.Points(dustGeometry, dustMaterial);
    scene.add(dust);
    disposables.push(dustGeometry, dustMaterial);
    const [windX, windY] = visual.dust.flow;
    const dustHasWind = windX !== 0 || windY !== 0;

    /* ====================================================================
       Signature layer — each theme owns one scene-defining element.
       ==================================================================== */
    type FrameHook = (dt: number, t: number, drive: number) => void;
    const frameHooks: FrameHook[] = [];

    if (visual.effect === "aurora") {
      // Fantasy: aurora curtains crest the sky and fireflies wander low.
      const auroraColors: Array<[string, string]> = [
        [hexToRgba("#4fd8a8", 0.5), hexToRgba(visual.secondary, 0.16)],
        [hexToRgba(visual.secondary, 0.4), hexToRgba("#4fd8a8", 0.12)]
      ];
      const ribbons: Array<{ mesh: THREE.Mesh; base: Float32Array; seed: number; material: THREE.MeshBasicMaterial }> = [];
      auroraColors.forEach(([top, bottom], index) => {
        const texture = makeAuroraTexture(top, bottom);
        const geometry = new THREE.PlaneGeometry(38, 6.5 - index, 96, 1);
        const material = new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
          opacity: 0.42 - index * 0.1,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(index * 4 - 2, 6.2 + index * 2.1, -17 - index * 4);
        mesh.rotation.x = -0.14;
        scene.add(mesh);
        const base = new Float32Array(geometry.getAttribute("position").array);
        ribbons.push({ mesh, base, seed: index * 2.7, material });
        disposables.push(geometry, material, texture);
      });
      frameHooks.push((dt, t) => {
        for (const ribbon of ribbons) {
          const attr = ribbon.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
          for (let i = 0; i < attr.count; i += 1) {
            const x = ribbon.base[i * 3];
            const y = ribbon.base[i * 3 + 1];
            attr.setY(i, y + Math.sin(x * 0.42 + t * 0.5 + ribbon.seed) * 0.55 + Math.sin(x * 0.13 - t * 0.22) * 0.9);
            attr.setZ(i, ribbon.base[i * 3 + 2] + Math.sin(x * 0.2 + t * 0.3 + ribbon.seed) * 0.8);
          }
          attr.needsUpdate = true;
          ribbon.material.opacity = (0.34 + Math.sin(t * 0.24 + ribbon.seed) * 0.12) * (ribbon.seed ? 0.8 : 1);
        }
      });

      const FIREFLIES = 70;
      const flyPositions = new Float32Array(FIREFLIES * 3);
      const flyBase = new Float32Array(FIREFLIES * 3);
      const flySeeds = new Float32Array(FIREFLIES);
      for (let i = 0; i < FIREFLIES; i += 1) {
        flyBase[i * 3] = (Math.random() - 0.5) * 24;
        flyBase[i * 3 + 1] = -5 + Math.random() * 6;
        flyBase[i * 3 + 2] = -2 - Math.random() * 10;
        flySeeds[i] = Math.random() * Math.PI * 2;
      }
      const flyGeometry = new THREE.BufferGeometry();
      flyGeometry.setAttribute("position", new THREE.BufferAttribute(flyPositions, 3));
      const flyMaterial = new THREE.PointsMaterial({
        color: new THREE.Color(visual.accentBright),
        size: 0.09,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true
      });
      scene.add(new THREE.Points(flyGeometry, flyMaterial));
      disposables.push(flyGeometry, flyMaterial);
      frameHooks.push((dt, t) => {
        const attr = flyGeometry.getAttribute("position") as THREE.BufferAttribute;
        for (let i = 0; i < FIREFLIES; i += 1) {
          const s = flySeeds[i];
          attr.setXYZ(
            i,
            flyBase[i * 3] + Math.sin(t * 0.4 + s * 3) * 1.6,
            flyBase[i * 3 + 1] + Math.sin(t * 0.7 + s * 5) * 0.8,
            flyBase[i * 3 + 2] + Math.cos(t * 0.3 + s * 2) * 1.2
          );
        }
        attr.needsUpdate = true;
        flyMaterial.opacity = 0.55 + Math.sin(t * 2.2) * 0.3;
      });
    }

    if (visual.effect === "warp") {
      // Scifi: star-lines streaming past the table at cruise velocity.
      const STREAKS = 150;
      const streakPositions = new Float32Array(STREAKS * 6);
      const streakData: Array<{ x: number; y: number; z: number; speed: number; len: number }> = [];
      for (let i = 0; i < STREAKS; i += 1) {
        streakData.push({
          x: (Math.random() - 0.5) * 40,
          y: (Math.random() - 0.5) * 24,
          z: -30 - Math.random() * 30,
          speed: 7 + Math.random() * 14,
          len: 0.8 + Math.random() * 2.2
        });
      }
      const streakGeometry = new THREE.BufferGeometry();
      streakGeometry.setAttribute("position", new THREE.BufferAttribute(streakPositions, 3));
      const streakMaterial = new THREE.LineBasicMaterial({
        color: accentColor,
        transparent: true,
        opacity: 0.4,
        blending: THREE.AdditiveBlending
      });
      scene.add(new THREE.LineSegments(streakGeometry, streakMaterial));
      disposables.push(streakGeometry, streakMaterial);
      frameHooks.push((dt, t, drive) => {
        const attr = streakGeometry.getAttribute("position") as THREE.BufferAttribute;
        for (let i = 0; i < STREAKS; i += 1) {
          const s = streakData[i];
          s.z += s.speed * dt * (0.6 + drive * 0.6);
          if (s.z > 8) {
            s.z = -55 - Math.random() * 10;
            s.x = (Math.random() - 0.5) * 40;
            s.y = (Math.random() - 0.5) * 24;
          }
          attr.setXYZ(i * 2, s.x, s.y, s.z);
          attr.setXYZ(i * 2 + 1, s.x, s.y, s.z - s.len);
        }
        attr.needsUpdate = true;
        streakMaterial.opacity = 0.28 + Math.sin(t * 0.6) * 0.08 + drive * 0.12;
      });
    }

    if (visual.effect === "haunt") {
      // Horror: the one light in the room is not reliable, and something
      // pale crawls along the floor.
      const crawlTexture = makeGlowTexture(hexToRgba("#41501f", 0.4), hexToRgba("#41501f", 0));
      disposables.push(crawlTexture);
      const crawlers: Array<{ sprite: THREE.Sprite; seed: number }> = [];
      for (let i = 0; i < 3; i += 1) {
        const material = new THREE.SpriteMaterial({
          map: crawlTexture,
          transparent: true,
          opacity: 0.4,
          depthWrite: false
        });
        const sprite = new THREE.Sprite(material);
        sprite.position.set((i - 1) * 9, -6.5 + i * 0.6, -4 - i * 2);
        sprite.scale.set(16, 6, 1);
        scene.add(sprite);
        crawlers.push({ sprite, seed: Math.random() * Math.PI * 2 });
        disposables.push(material);
      }
      let flicker = 1;
      frameHooks.push((dt, t) => {
        // Random-walk flicker with occasional near-blackout stutters.
        flicker += ((Math.random() > 0.985 ? 0.15 : 1) - flicker) * Math.min(1, dt * 9);
        keyLight.intensity = 42 * flicker * (0.85 + Math.sin(t * 13.7) * 0.07);
        rimLight.intensity = 16 * (0.7 + Math.sin(t * 0.4) * 0.3);
        for (const crawler of crawlers) {
          crawler.sprite.position.x += Math.sin(t * 0.11 + crawler.seed) * dt * 0.7;
          (crawler.sprite.material as THREE.SpriteMaterial).opacity = 0.3 + Math.sin(t * 0.23 + crawler.seed) * 0.12;
        }
      });
    }

    if (visual.effect === "rain") {
      // Noir: rain through a streetlamp, venetian shafts cutting the dark.
      const DROPS = 420;
      const dropPositions = new Float32Array(DROPS * 6);
      const dropSpeed = new Float32Array(DROPS);
      const dropX = new Float32Array(DROPS);
      const dropY = new Float32Array(DROPS);
      const dropZ = new Float32Array(DROPS);
      for (let i = 0; i < DROPS; i += 1) {
        dropX[i] = (Math.random() - 0.5) * 34;
        dropY[i] = (Math.random() - 0.5) * 24;
        dropZ[i] = -2 - Math.random() * 18;
        dropSpeed[i] = 13 + Math.random() * 9;
      }
      const rainGeometry = new THREE.BufferGeometry();
      rainGeometry.setAttribute("position", new THREE.BufferAttribute(dropPositions, 3));
      const rainMaterial = new THREE.LineBasicMaterial({
        color: new THREE.Color("#8fa3bd"),
        transparent: true,
        opacity: 0.32,
        blending: THREE.AdditiveBlending
      });
      scene.add(new THREE.LineSegments(rainGeometry, rainMaterial));
      disposables.push(rainGeometry, rainMaterial);
      frameHooks.push((dt) => {
        const attr = rainGeometry.getAttribute("position") as THREE.BufferAttribute;
        for (let i = 0; i < DROPS; i += 1) {
          dropY[i] -= dropSpeed[i] * dt;
          dropX[i] -= dropSpeed[i] * dt * 0.12;
          if (dropY[i] < -12) {
            dropY[i] = 12;
            dropX[i] = (Math.random() - 0.5) * 34;
          }
          attr.setXYZ(i * 2, dropX[i], dropY[i], dropZ[i]);
          attr.setXYZ(i * 2 + 1, dropX[i] + 0.06, dropY[i] + 0.55, dropZ[i]);
        }
        attr.needsUpdate = true;
      });

      const shaftTexture = makeShaftTexture();
      disposables.push(shaftTexture);
      const shafts: Array<{ mesh: THREE.Mesh; seed: number }> = [];
      for (let i = 0; i < 4; i += 1) {
        const material = new THREE.MeshBasicMaterial({
          map: shaftTexture,
          color: new THREE.Color(visual.accent),
          transparent: true,
          opacity: 0.1,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide
        });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.1 + (i % 2) * 0.6, 22), material);
        mesh.position.set(-7 + i * 4.6, 3.5, -6 - i);
        mesh.rotation.z = -0.42;
        scene.add(mesh);
        shafts.push({ mesh, seed: Math.random() * Math.PI * 2 });
        disposables.push(mesh.geometry, material);
      }
      frameHooks.push((dt, t) => {
        for (const shaft of shafts) {
          (shaft.mesh.material as THREE.MeshBasicMaterial).opacity = 0.07 + Math.max(0, Math.sin(t * 0.3 + shaft.seed)) * 0.09;
        }
      });
    }

    if (visual.effect === "bokeh") {
      // Modern: out-of-focus city lights sliding past a night window.
      const bokehTexture = makeGlowTexture("rgba(255,255,255,0.5)", "rgba(255,255,255,0)");
      disposables.push(bokehTexture);
      const bokehColors = [visual.accent, visual.secondary, "#ffffff", "#ff6a8a"];
      const orbs: Array<{ sprite: THREE.Sprite; seed: number; speed: number }> = [];
      for (let i = 0; i < 26; i += 1) {
        const material = new THREE.SpriteMaterial({
          map: bokehTexture,
          color: new THREE.Color(bokehColors[i % bokehColors.length]),
          transparent: true,
          opacity: 0.16,
          depthWrite: false,
          blending: THREE.AdditiveBlending
        });
        const sprite = new THREE.Sprite(material);
        sprite.position.set((Math.random() - 0.5) * 36, (Math.random() - 0.5) * 20, -6 - Math.random() * 14);
        sprite.scale.setScalar(1.2 + Math.random() * 3.6);
        scene.add(sprite);
        orbs.push({ sprite, seed: Math.random() * Math.PI * 2, speed: 0.3 + Math.random() * 0.6 });
        disposables.push(material);
      }
      frameHooks.push((dt, t) => {
        for (const orb of orbs) {
          orb.sprite.position.x += dt * orb.speed;
          if (orb.sprite.position.x > 20) orb.sprite.position.x = -20;
          (orb.sprite.material as THREE.SpriteMaterial).opacity = 0.1 + Math.sin(t * 0.5 + orb.seed) * 0.07 + 0.07;
        }
      });
    }

    if (visual.effect === "frontier") {
      // Western: a huge low sun smolders on the horizon; dust rides the wind.
      const sunTexture = makeGlowTexture(hexToRgba("#ffd9a0", 0.85), hexToRgba("#c4573a", 0));
      const sunMaterial = new THREE.SpriteMaterial({
        map: sunTexture,
        transparent: true,
        opacity: 0.65,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      });
      const sun = new THREE.Sprite(sunMaterial);
      sun.position.set(2, -4.5, -26);
      sun.scale.setScalar(30);
      scene.add(sun);
      disposables.push(sunTexture, sunMaterial);

      const hazeTexture = makeGlowTexture(hexToRgba("#c4573a", 0.3), hexToRgba("#c4573a", 0));
      const hazeMaterial = new THREE.SpriteMaterial({ map: hazeTexture, transparent: true, opacity: 0.4, depthWrite: false });
      const haze = new THREE.Sprite(hazeMaterial);
      haze.position.set(0, -7, -20);
      haze.scale.set(60, 14, 1);
      scene.add(haze);
      disposables.push(hazeTexture, hazeMaterial);

      frameHooks.push((dt, t) => {
        sunMaterial.opacity = 0.55 + Math.sin(t * 0.17) * 0.1;
        sun.scale.setScalar(30 + Math.sin(t * 0.23) * 1.4);
        hazeMaterial.opacity = 0.32 + Math.sin(t * 0.13) * 0.08;
      });
    }

    // -- pointer parallax --------------------------------------------------
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

    const clock = new THREE.Clock();
    let frame = 0;
    const renderFrame = () => {
      const dt = Math.min(clock.getDelta(), 0.05);
      const t = clock.elapsedTime;
      const drive = 0.4 + dramaRef.current * 0.9;

      for (const solid of solids) {
        solid.group.rotation.x += solid.spin.x * dt * drive;
        solid.group.rotation.y += solid.spin.y * dt * drive;
        solid.group.rotation.z += solid.spin.z * dt * drive;
        solid.group.position.y = solid.base.y + Math.sin(t * solid.bobSpeed + solid.bobPhase) * 0.35;
      }

      if (dustHasWind) {
        const attr = dustGeometry.getAttribute("position") as THREE.BufferAttribute;
        for (let i = 0; i < DUST_COUNT; i += 1) {
          let x = dustPositions[i * 3] + windX * dt * (0.6 + dustSeeds[i] * 0.2);
          let y = dustPositions[i * 3 + 1] + windY * dt * (0.6 + dustSeeds[i] * 0.2);
          if (x > 17) x = -17;
          if (x < -17) x = 17;
          if (y > 10) y = -10;
          if (y < -10) y = 10;
          dustPositions[i * 3] = x;
          dustPositions[i * 3 + 1] = y;
        }
        attr.needsUpdate = true;
      } else {
        dust.rotation.y = t * 0.008 * drive;
      }
      dustMaterial.opacity = 0.55 + Math.sin(t * 0.6) * 0.15;
      dustMaterial.size = visual.dust.size + Math.sin(t * 1.7) * 0.008;

      nebulae.forEach((sprite, index) => {
        const material = sprite.material as THREE.SpriteMaterial;
        material.opacity = 0.34 + Math.sin(t * 0.14 + nebulaSeeds[index]) * 0.16;
        sprite.position.y += Math.sin(t * 0.05 + nebulaSeeds[index]) * dt * 0.12;
      });

      nextMeteorAt -= dt * drive;
      if (nextMeteorAt <= 0) {
        launchMeteor();
        nextMeteorAt = 5 + Math.random() * 11;
      }
      for (const meteor of meteors) {
        if (!meteor.mesh.visible) continue;
        meteor.life -= dt;
        meteor.mesh.position.addScaledVector(meteor.velocity, dt);
        const fade = Math.max(0, Math.min(1, meteor.life / 1.4));
        meteor.material.opacity = Math.sin(fade * Math.PI) * 0.9;
        if (meteor.life <= 0) meteor.mesh.visible = false;
      }

      for (const hook of frameHooks) hook(dt, t, drive);

      camera.position.x += (pointer.x * 0.9 - camera.position.x) * 0.02;
      camera.position.y += (0.4 - pointer.y * 0.6 - camera.position.y) * 0.02;
      camera.lookAt(0, 0, -3);

      renderer.render(scene, camera);
    };

    if (reducedMotion) {
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
      for (const [geometry] of shapes) geometry.dispose();
      for (const solid of solids) {
        solid.group.children.forEach((child) => {
          if (child instanceof THREE.LineSegments) child.geometry.dispose();
        });
      }
      for (const item of disposables) item.dispose();
      if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement);
    };
  }, [accent, theme]);

  return <div ref={mountRef} className="cosmos-canvas" aria-hidden />;
}
