"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

export type DiceRollData = {
  id: string;
  notation: string;
  reason: string;
  rolls: number[];
  modifier: number;
  total: number;
  d20Mode?: "normal" | "advantage" | "disadvantage";
  speaker?: string;
  color?: string;
};

type Phase = "tumble" | "settle" | "reveal";

const TUMBLE_SECONDS = 2.1;
const SETTLE_SECONDS = 0.65;

/* ------------------------------------------------------------------ */
/* Textures                                                            */
/* ------------------------------------------------------------------ */

/** 5x4 atlas of engraved gold numerals, one cell per d20 face. */
function makeD20Atlas(accent: string) {
  const size = 1024;
  const cell = size / 5;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = Math.ceil(size * 4 / 5);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#10141f";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let value = 1; value <= 20; value += 1) {
    const col = (value - 1) % 5;
    const row = Math.floor((value - 1) / 5);
    const cx = col * cell + cell / 2;
    const cy = row * cell + cell * 0.56;

    const glow = ctx.createRadialGradient(cx, cy, 4, cx, cy, cell * 0.42);
    glow.addColorStop(0, "rgba(230, 195, 120, 0.28)");
    glow.addColorStop(1, "rgba(230, 195, 120, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(col * cell, row * cell, cell, cell);

    ctx.font = `700 ${Math.round(cell * 0.46)}px Cinzel, 'Times New Roman', serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = accent;
    ctx.shadowBlur = 18;
    ctx.fillStyle = accent;
    ctx.fillText(String(value), cx, cy);
    ctx.shadowBlur = 0;

    if (value === 6 || value === 9) {
      ctx.fillRect(cx - cell * 0.09, cy + cell * 0.27, cell * 0.18, cell * 0.024);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** Single-value texture used on every face of a non-d20 die cube. */
function makeValueTexture(value: number, accent: string) {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#10141f";
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = "rgba(230,195,120,0.35)";
  ctx.lineWidth = 6;
  ctx.strokeRect(14, 14, size - 28, size - 28);
  ctx.font = `700 ${Math.round(size * 0.5)}px Cinzel, 'Times New Roman', serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = accent;
  ctx.shadowBlur = 14;
  ctx.fillStyle = accent;
  ctx.fillText(String(value), size / 2, size / 2 + 8);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

type D20Build = {
  geometry: THREE.BufferGeometry;
  /** Quaternion that presents face `value` upright toward +Z. */
  presentation: THREE.Quaternion[];
};

/** Icosahedron with per-face atlas UVs and precomputed landing rotations. */
function buildD20(): D20Build {
  const geometry = new THREE.IcosahedronGeometry(1, 0).toNonIndexed();
  const position = geometry.getAttribute("position");
  const faceCount = position.count / 3; // 20
  const uvs = new Float32Array(position.count * 2);
  const presentation: THREE.Quaternion[] = [];

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const mid = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const upish = new THREE.Vector3();
  const xAxis = new THREE.Vector3();
  const basis = new THREE.Matrix4();

  for (let face = 0; face < faceCount; face += 1) {
    const col = face % 5;
    const row = Math.floor(face / 5);
    const u0 = col / 5;
    const v0 = 1 - (row + 1) / 4;
    const cw = 1 / 5;
    const ch = 1 / 4;
    const pad = 0.16;
    // v0 = apex (number top), v1/v2 = base corners.
    uvs[face * 6 + 0] = u0 + cw / 2;
    uvs[face * 6 + 1] = v0 + ch * (1 - pad * 0.6);
    uvs[face * 6 + 2] = u0 + cw * pad;
    uvs[face * 6 + 3] = v0 + ch * pad;
    uvs[face * 6 + 4] = u0 + cw * (1 - pad);
    uvs[face * 6 + 5] = v0 + ch * pad;

    a.fromBufferAttribute(position, face * 3);
    b.fromBufferAttribute(position, face * 3 + 1);
    c.fromBufferAttribute(position, face * 3 + 2);
    mid.copy(b).add(c).multiplyScalar(0.5);
    normal.copy(b).sub(a).cross(c.clone().sub(a)).normalize();
    // Ensure outward normal.
    if (normal.dot(a) < 0) normal.negate();
    upish.copy(a).sub(mid);
    upish.addScaledVector(normal, -upish.dot(normal)).normalize();
    xAxis.copy(upish).cross(normal).normalize();

    // Local frame (x', up, normal) → world (X, Y, Z): rotation = basis⁻¹.
    basis.makeBasis(xAxis, upish, normal);
    presentation.push(new THREE.Quaternion().setFromRotationMatrix(basis.clone().transpose()));
  }

  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  return { geometry, presentation };
}

/* ------------------------------------------------------------------ */
/* Sound                                                               */
/* ------------------------------------------------------------------ */

function playRollSound(critical: "high" | "low" | null) {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx: AudioContext = new AudioCtx();
    const master = ctx.createGain();
    master.gain.value = 0.16;
    master.connect(ctx.destination);

    // Rumbling tumble: low sawtooth with wobble, fading into the impact.
    const rumble = ctx.createOscillator();
    rumble.type = "sawtooth";
    rumble.frequency.setValueAtTime(55, ctx.currentTime);
    rumble.frequency.linearRampToValueAtTime(110, ctx.currentTime + TUMBLE_SECONDS);
    const wobble = ctx.createOscillator();
    wobble.frequency.value = 9;
    const wobbleGain = ctx.createGain();
    wobbleGain.gain.value = 22;
    wobble.connect(wobbleGain);
    wobbleGain.connect(rumble.frequency);
    const rumbleGain = ctx.createGain();
    rumbleGain.gain.setValueAtTime(0.0001, ctx.currentTime);
    rumbleGain.gain.exponentialRampToValueAtTime(0.5, ctx.currentTime + 0.35);
    rumbleGain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + TUMBLE_SECONDS + 0.2);
    rumble.connect(rumbleGain);
    rumbleGain.connect(master);
    rumble.start();
    wobble.start();
    rumble.stop(ctx.currentTime + TUMBLE_SECONDS + 0.3);
    wobble.stop(ctx.currentTime + TUMBLE_SECONDS + 0.3);

    // Impact at settle.
    const impactAt = ctx.currentTime + TUMBLE_SECONDS;
    const thud = ctx.createOscillator();
    thud.type = "sine";
    thud.frequency.setValueAtTime(150, impactAt);
    thud.frequency.exponentialRampToValueAtTime(40, impactAt + 0.4);
    const thudGain = ctx.createGain();
    thudGain.gain.setValueAtTime(0.0001, ctx.currentTime);
    thudGain.gain.setValueAtTime(0.9, impactAt);
    thudGain.gain.exponentialRampToValueAtTime(0.0001, impactAt + 0.45);
    thud.connect(thudGain);
    thudGain.connect(master);
    thud.start(impactAt);
    thud.stop(impactAt + 0.5);

    // Crit chime / dirge.
    if (critical) {
      const revealAt = impactAt + SETTLE_SECONDS + 0.1;
      const freqs = critical === "high" ? [660, 990, 1320] : [220, 208];
      freqs.forEach((freq, index) => {
        const chime = ctx.createOscillator();
        chime.type = "triangle";
        chime.frequency.value = freq;
        const chimeGain = ctx.createGain();
        chimeGain.gain.setValueAtTime(0.0001, revealAt);
        chimeGain.gain.exponentialRampToValueAtTime(0.4 / (index + 1), revealAt + 0.05 + index * 0.08);
        chimeGain.gain.exponentialRampToValueAtTime(0.0001, revealAt + 1.1);
        chime.connect(chimeGain);
        chimeGain.connect(master);
        chime.start(revealAt);
        chime.stop(revealAt + 1.2);
      });
    }

    setTimeout(() => ctx.close().catch(() => undefined), (TUMBLE_SECONDS + SETTLE_SECONDS + 2.5) * 1000);
  } catch {
    // Sound is decoration; never let it break the roll.
  }
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

/**
 * Full-screen dice cinematic. A d20 (or a fistful of dice for other
 * notations) drops out of darkness, tumbles with decaying spin, and is
 * snapped onto its rolled face — the face texture mapping is exact, so the
 * die genuinely lands showing the number the server rolled. Advantage and
 * disadvantage throw two dice and let the loser sink into shadow.
 */
export default function DiceTheater({
  roll,
  compact = false,
  muted = false,
  onDone
}: {
  roll: DiceRollData;
  compact?: boolean;
  muted?: boolean;
  onDone: () => void;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>("tumble");
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const isD20 = roll.notation.toLowerCase().includes("d20") || !!roll.d20Mode;
  const isDual = (roll.d20Mode === "advantage" || roll.d20Mode === "disadvantage") && roll.rolls.length >= 2;
  const chosenIndex = isDual
    ? (roll.d20Mode === "advantage"
        ? (roll.rolls[0] >= roll.rolls[1] ? 0 : 1)
        : (roll.rolls[0] <= roll.rolls[1] ? 0 : 1))
    : 0;
  const headline = isDual ? roll.rolls[chosenIndex] : roll.total;
  const critical: "high" | "low" | null = isD20
    ? (headline === 20 ? "high" : headline === 1 ? "low" : null)
    : null;
  const accent = critical === "high" ? "#ffd76a" : critical === "low" ? "#ff6a5c" : "#e6c378";

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 50);
    camera.position.set(0, 0.15, compact ? 5.6 : 6.4);
    camera.lookAt(0, 0, 0);

    scene.add(new THREE.AmbientLight(0x404868, 1.4));
    const key = new THREE.PointLight(0xe6c378, 60, 40, 1.8);
    key.position.set(-4, 5, 5);
    scene.add(key);
    const fill = new THREE.PointLight(0x5f6cff, 22, 30, 2);
    fill.position.set(5, -3, 3);
    scene.add(fill);

    const disposables: Array<{ dispose: () => void }> = [];
    const dice: Array<{
      mesh: THREE.Mesh;
      spin: THREE.Vector3;
      startQ: THREE.Quaternion;
      targetQ: THREE.Quaternion;
      restX: number;
      dim: boolean;
    }> = [];

    const shownRolls = roll.rolls.slice(0, isDual ? 2 : 5);
    const spread = shownRolls.length > 1 ? (compact ? 1.5 : 1.85) : 0;
    const scale = (compact ? 0.95 : 1.15) * (shownRolls.length > 1 ? 0.82 : 1);

    /** Aim a die's presented face at the camera from its resting spot. */
    const aimAtCamera = (restX: number) => {
      const toCamera = camera.position.clone().sub(new THREE.Vector3(restX, 0, 0)).normalize();
      return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), toCamera);
    };

    if (isD20) {
      const { geometry, presentation } = buildD20();
      const atlas = makeD20Atlas("#e6c378");
      const material = new THREE.MeshStandardMaterial({
        map: atlas,
        roughness: 0.32,
        metalness: 0.55,
        flatShading: true
      });
      disposables.push(geometry, atlas, material);

      shownRolls.forEach((value, index) => {
        const mesh = new THREE.Mesh(geometry, material.clone());
        disposables.push(mesh.material as THREE.Material);
        mesh.scale.setScalar(scale);
        const restX = (index - (shownRolls.length - 1) / 2) * spread * 1.5;
        mesh.position.set(restX, 4.5, 0);
        scene.add(mesh);
        dice.push({
          mesh,
          spin: new THREE.Vector3(
            (Math.random() * 6 + 7) * (Math.random() < 0.5 ? -1 : 1),
            (Math.random() * 6 + 7) * (Math.random() < 0.5 ? -1 : 1),
            (Math.random() * 4 + 3) * (Math.random() < 0.5 ? -1 : 1)
          ),
          startQ: new THREE.Quaternion(),
          targetQ: aimAtCamera(restX).multiply(presentation[Math.max(0, Math.min(19, value - 1))]),
          restX,
          dim: isDual && index !== chosenIndex
        });
      });
    } else {
      const geometry = new THREE.BoxGeometry(1.2, 1.2, 1.2);
      disposables.push(geometry);
      shownRolls.forEach((value, index) => {
        const texture = makeValueTexture(value, "#e6c378");
        const material = new THREE.MeshStandardMaterial({
          map: texture,
          roughness: 0.35,
          metalness: 0.5
        });
        disposables.push(texture, material);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.scale.setScalar(scale * 0.85);
        const restX = (index - (shownRolls.length - 1) / 2) * spread;
        mesh.position.set(restX, 4.5, 0);
        scene.add(mesh);
        dice.push({
          mesh,
          spin: new THREE.Vector3(
            (Math.random() * 5 + 6) * (Math.random() < 0.5 ? -1 : 1),
            (Math.random() * 5 + 6) * (Math.random() < 0.5 ? -1 : 1),
            (Math.random() * 3 + 2) * (Math.random() < 0.5 ? -1 : 1)
          ),
          startQ: new THREE.Quaternion(),
          targetQ: aimAtCamera(restX),
          restX,
          dim: false
        });
      });
    }

    // Glow disc beneath the landing spot.
    const glowTexture = (() => {
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 256;
      const ctx = canvas.getContext("2d")!;
      const gradient = ctx.createRadialGradient(128, 128, 8, 128, 128, 128);
      gradient.addColorStop(0, "rgba(230,195,120,0.55)");
      gradient.addColorStop(1, "rgba(230,195,120,0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 256, 256);
      return new THREE.CanvasTexture(canvas);
    })();
    const glowMaterial = new THREE.MeshBasicMaterial({
      map: glowTexture,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(7, 7), glowMaterial);
    glow.position.set(0, -1.2, -1);
    scene.add(glow);
    disposables.push(glowTexture, glowMaterial, glow.geometry);

    if (!muted) playRollSound(critical);

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
    let lastT = 0;
    let currentPhase: Phase = "tumble";
    let settleCaptured = false;
    let finished = false;
    const tumbleTime = reducedMotion ? 0.01 : TUMBLE_SECONDS;
    const settleTime = reducedMotion ? 0.01 : SETTLE_SECONDS;
    const holdTime = compact ? 2.0 : 2.9;

    const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);

    const loop = () => {
      frame = requestAnimationFrame(loop);
      const t = clock.getElapsedTime();
      const dt = Math.min(Math.max(t - lastT, 0.001), 0.05);
      lastT = t;

      if (t < tumbleTime) {
        const progress = t / tumbleTime;
        const decay = 1 - easeOutCubic(progress) * 0.85;
        // Drop with two decaying bounces.
        const drop = Math.max(0, 4.5 * (1 - easeOutCubic(Math.min(progress * 1.6, 1))));
        const bounce = progress > 0.6 ? Math.abs(Math.sin(progress * 14)) * (1 - progress) * 0.7 : 0;
        for (const die of dice) {
          die.mesh.rotation.x += die.spin.x * dt * decay;
          die.mesh.rotation.y += die.spin.y * dt * decay;
          die.mesh.rotation.z += die.spin.z * dt * decay;
          die.mesh.position.y = drop + bounce;
          die.mesh.position.x = die.restX + Math.sin(t * 5 + die.restX) * (1 - progress) * 0.4;
        }
        glowMaterial.opacity = progress * 0.35;
      } else if (t < tumbleTime + settleTime) {
        if (!settleCaptured) {
          settleCaptured = true;
          for (const die of dice) die.startQ.copy(die.mesh.quaternion);
          if (currentPhase !== "settle") {
            currentPhase = "settle";
            setPhase("settle");
          }
        }
        const progress = easeOutCubic((t - tumbleTime) / settleTime);
        for (const die of dice) {
          die.mesh.quaternion.slerpQuaternions(die.startQ, die.targetQ, progress);
          die.mesh.position.y *= 1 - progress;
          die.mesh.position.x = die.restX;
        }
        glowMaterial.opacity = 0.35 + progress * 0.3;
      } else {
        if (currentPhase !== "reveal") {
          currentPhase = "reveal";
          setPhase("reveal");
        }
        const since = t - tumbleTime - settleTime;
        for (const die of dice) {
          die.mesh.quaternion.copy(die.targetQ);
          if (die.dim) {
            // The unchosen die sinks into shadow.
            const sink = Math.min(since / 0.9, 1);
            die.mesh.position.y = -sink * 1.4;
            die.mesh.scale.setScalar(scale * (1 - sink * 0.35));
            const material = die.mesh.material as THREE.MeshStandardMaterial;
            material.transparent = true;
            material.opacity = 1 - sink * 0.75;
          } else {
            die.mesh.position.y = Math.sin(since * 1.8) * 0.06;
          }
        }
        glowMaterial.opacity = 0.65 + Math.sin(since * 3) * 0.12;
        if (!finished && since > holdTime) {
          finished = true;
          onDoneRef.current();
        }
      }

      renderer.render(scene, camera);
    };
    frame = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.dispose();
      for (const item of disposables) item.dispose();
      if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement);
    };
    // The roll is immutable per mount; parent remounts with a new key per event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roll.id]);

  const modeLabel = roll.d20Mode === "advantage" ? "Advantage" : roll.d20Mode === "disadvantage" ? "Disadvantage" : null;

  return (
    <div className={`dice-theater ${compact ? "compact" : ""} phase-${phase} ${critical ? `crit-${critical}` : ""}`}>
      <div className="dice-theater-canvas" ref={mountRef} />
      <div className="dice-theater-chrome">
        <div className="dice-reason">
          {roll.speaker ? <span className="dice-speaker" style={{ color: roll.color || undefined }}>{roll.speaker}</span> : null}
          <span className="dice-reason-text">{roll.reason}</span>
          {modeLabel ? <span className={`dice-mode mode-${roll.d20Mode}`}>{modeLabel}</span> : null}
        </div>
        <div className="dice-result" style={{ color: accent }}>
          <span className="dice-result-number">{headline}</span>
          {critical === "high" ? <span className="dice-crit-label">Critical!</span> : null}
          {critical === "low" ? <span className="dice-crit-label">Catastrophe</span> : null}
          {isDual ? (
            <span className="dice-dual-detail">
              {roll.rolls[0]} / {roll.rolls[1]} — kept {roll.rolls[chosenIndex]}
            </span>
          ) : roll.modifier ? (
            <span className="dice-dual-detail">
              {roll.rolls.join(" + ")} {roll.modifier > 0 ? `+ ${roll.modifier}` : `− ${Math.abs(roll.modifier)}`} = {roll.total}
            </span>
          ) : roll.rolls.length > 1 ? (
            <span className="dice-dual-detail">{roll.rolls.join(" + ")} = {roll.total}</span>
          ) : null}
          <span className="dice-notation">{roll.notation}</span>
        </div>
      </div>
    </div>
  );
}
