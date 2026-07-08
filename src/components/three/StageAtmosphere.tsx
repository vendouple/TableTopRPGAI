"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import type { AmbienceMood, StageEffectKind } from "@/lib/campaign/types";

export type AtmosphereHandle = {
  /** Fire a one-shot particle surge (embers burst, rain squall, fog roll…). */
  burst: (kind: StageEffectKind, strength: number) => void;
};

type MoodRecipe = {
  colors: [string, string];
  /** Base vertical drift per second; positive = rising. */
  drift: number;
  /** Horizontal wander amplitude. */
  wander: number;
  size: number;
  opacity: number;
  count: number;
  fogOpacity: number;
  fogColor: string;
};

const MOODS: Record<AmbienceMood, MoodRecipe> = {
  calm:    { colors: ["#e8c98a", "#c9a35c"], drift: 0.35,  wander: 0.5, size: 0.05,  opacity: 0.65, count: 240, fogOpacity: 0.10, fogColor: "#3a3222" },
  tense:   { colors: ["#8fa8b8", "#5d7683"], drift: 0.18,  wander: 1.4, size: 0.04,  opacity: 0.5,  count: 260, fogOpacity: 0.22, fogColor: "#1d2733" },
  battle:  { colors: ["#ffb35c", "#ff5c3c"], drift: 1.5,   wander: 2.0, size: 0.06,  opacity: 0.9,  count: 420, fogOpacity: 0.14, fogColor: "#3a1c12" },
  mystery: { colors: ["#a98cff", "#5f6cff"], drift: 0.28,  wander: 1.8, size: 0.05,  opacity: 0.6,  count: 300, fogOpacity: 0.30, fogColor: "#221c3d" },
  dread:   { colors: ["#6f7787", "#3d4351"], drift: -0.35, wander: 0.6, size: 0.045, opacity: 0.55, count: 300, fogOpacity: 0.38, fogColor: "#0d1017" },
  triumph: { colors: ["#ffe08a", "#ffc23c"], drift: 1.1,   wander: 0.8, size: 0.065, opacity: 1.0,  count: 380, fogOpacity: 0.08, fogColor: "#3a2f14" },
  wonder:  { colors: ["#8affd8", "#5cc9ff"], drift: 0.45,  wander: 1.2, size: 0.055, opacity: 0.8,  count: 320, fogOpacity: 0.16, fogColor: "#12343a" },
  somber:  { colors: ["#aebdd6", "#7385a3"], drift: -0.22, wander: 0.4, size: 0.04,  opacity: 0.5,  count: 220, fogOpacity: 0.26, fogColor: "#151c29" }
};

const MAX_PARTICLES = 900;

function makeFogTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(128, 128, 10, 128, 128, 128);
  gradient.addColorStop(0, "rgba(255,255,255,0.85)");
  gradient.addColorStop(0.55, "rgba(255,255,255,0.28)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(canvas);
}

/**
 * The living air of the host stage: a full-screen particle field whose
 * palette, density, and direction are directed by the AI DM through the
 * set_ambience tool, plus one-shot squalls from trigger_effect. Rendered
 * transparently above the painted scene backdrop.
 */
const StageAtmosphere = forwardRef<AtmosphereHandle, { mood: AmbienceMood; intensity: number }>(
  function StageAtmosphere({ mood, intensity }, handle) {
    const mountRef = useRef<HTMLDivElement>(null);
    const moodRef = useRef<{ mood: AmbienceMood; intensity: number }>({ mood, intensity });
    moodRef.current = { mood, intensity };
    const burstRef = useRef<{ kind: StageEffectKind; strength: number; at: number } | null>(null);

    useImperativeHandle(handle, () => ({
      burst: (kind, strength) => {
        burstRef.current = { kind, strength, at: performance.now() };
      }
    }));

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
      const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 60);
      camera.position.set(0, 0, 10);

      // Particle pool — recycled between moods, capacity fixed.
      const positions = new Float32Array(MAX_PARTICLES * 3);
      const seeds = new Float32Array(MAX_PARTICLES * 2);
      const colors = new Float32Array(MAX_PARTICLES * 3);
      for (let i = 0; i < MAX_PARTICLES; i += 1) {
        positions[i * 3] = (Math.random() - 0.5) * 26;
        positions[i * 3 + 1] = (Math.random() - 0.5) * 16;
        positions[i * 3 + 2] = -Math.random() * 8;
        seeds[i * 2] = Math.random() * Math.PI * 2;
        seeds[i * 2 + 1] = 0.5 + Math.random();
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      const material = new THREE.PointsMaterial({
        size: 0.05,
        transparent: true,
        vertexColors: true,
        opacity: 0.7,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true
      });
      const points = new THREE.Points(geometry, material);
      scene.add(points);

      // Fog sheets that slide across the lower half of the stage.
      const fogTexture = makeFogTexture();
      const fogMaterial = new THREE.MeshBasicMaterial({
        map: fogTexture,
        transparent: true,
        opacity: 0.15,
        depthWrite: false
      });
      const fogSheets: THREE.Mesh[] = [];
      for (let i = 0; i < 3; i += 1) {
        const sheet = new THREE.Mesh(new THREE.PlaneGeometry(18, 9), fogMaterial.clone());
        sheet.position.set((i - 1) * 8, -4 + i * 1.2, -2 - i);
        fogSheets.push(sheet);
        scene.add(sheet);
      }

      const colorA = new THREE.Color();
      const colorB = new THREE.Color();
      const mixed = new THREE.Color();
      const fogColor = new THREE.Color();

      const applyMoodColors = () => {
        const recipe = MOODS[moodRef.current.mood] || MOODS.calm;
        colorA.set(recipe.colors[0]);
        colorB.set(recipe.colors[1]);
        for (let i = 0; i < MAX_PARTICLES; i += 1) {
          mixed.copy(colorA).lerp(colorB, (i % 7) / 6);
          colors[i * 3] = mixed.r;
          colors[i * 3 + 1] = mixed.g;
          colors[i * 3 + 2] = mixed.b;
        }
        geometry.attributes.color.needsUpdate = true;
        fogColor.set(recipe.fogColor);
        for (const sheet of fogSheets) {
          (sheet.material as THREE.MeshBasicMaterial).color.copy(fogColor);
        }
      };
      let lastMood: AmbienceMood | null = null;

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

      const loop = () => {
        frame = requestAnimationFrame(loop);
        const dt = Math.min(clock.getDelta(), 0.05);
        const t = clock.elapsedTime;
        const { mood: activeMood, intensity: rawIntensity } = moodRef.current;
        const recipe = MOODS[activeMood] || MOODS.calm;
        const level = 0.35 + Math.max(0, Math.min(1, rawIntensity)) * 0.85;

        if (activeMood !== lastMood) {
          lastMood = activeMood;
          applyMoodColors();
        }

        // One-shot squalls raise density/speed briefly.
        let surge = 0;
        let surgeKind: StageEffectKind | null = null;
        const burst = burstRef.current;
        if (burst) {
          const age = (performance.now() - burst.at) / 1000;
          if (age < 3.2) {
            surge = Math.sin(Math.min(age / 3.2, 1) * Math.PI) * burst.strength;
            surgeKind = burst.kind;
          } else {
            burstRef.current = null;
          }
        }

        const isRain = surgeKind === "rain";
        const isSnow = surgeKind === "snow";
        const drift = isRain ? -9 : isSnow ? -0.8 : recipe.drift * level * (1 + surge * 2.5);
        const wander = (isRain ? 0.2 : recipe.wander) * level;
        const visible = Math.min(
          MAX_PARTICLES,
          Math.floor(recipe.count * level + surge * 350)
        );

        for (let i = 0; i < MAX_PARTICLES; i += 1) {
          const px = i * 3;
          if (i >= visible) {
            positions[px + 1] = -40; // park off-stage
            continue;
          }
          if (positions[px + 1] <= -39) {
            positions[px] = (Math.random() - 0.5) * 26;
            positions[px + 1] = (Math.random() - 0.5) * 16;
          }
          const speed = seeds[i * 2 + 1];
          positions[px + 1] += drift * speed * dt;
          positions[px] += Math.sin(t * speed + seeds[i * 2]) * wander * dt;
          if (positions[px + 1] > 9) positions[px + 1] = -9;
          if (positions[px + 1] < -9) positions[px + 1] = 9;
        }
        geometry.attributes.position.needsUpdate = true;

        material.size = recipe.size * (isRain ? 1.6 : 1) + surge * 0.02;
        material.opacity = recipe.opacity * (0.5 + level * 0.5) + surge * 0.25;

        const fogBoost = surgeKind === "fog" ? surge * 0.5 : 0;
        fogSheets.forEach((sheet, index) => {
          sheet.position.x += dt * (0.25 + index * 0.12) * (index % 2 === 0 ? 1 : -1);
          if (sheet.position.x > 14) sheet.position.x = -14;
          if (sheet.position.x < -14) sheet.position.x = 14;
          (sheet.material as THREE.MeshBasicMaterial).opacity = recipe.fogOpacity * level + fogBoost;
        });

        renderer.render(scene, camera);
      };
      frame = requestAnimationFrame(loop);

      return () => {
        cancelAnimationFrame(frame);
        observer.disconnect();
        renderer.dispose();
        geometry.dispose();
        material.dispose();
        fogTexture.dispose();
        fogMaterial.dispose();
        for (const sheet of fogSheets) {
          sheet.geometry.dispose();
          (sheet.material as THREE.Material).dispose();
        }
        if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement);
      };
    }, []);

    return <div ref={mountRef} className="atmosphere-canvas" aria-hidden />;
  }
);

export default StageAtmosphere;
