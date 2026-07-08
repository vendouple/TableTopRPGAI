"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

/**
 * The Astral Table — the ambient scene behind the portal, creation wizard,
 * lobby, and join flow. Great polyhedral dice drift like slow moons through
 * gold star-dust, with a faint horizon of fog below. Pointer movement gives
 * a gentle parallax so the whole menu feels like it floats over a real space.
 */
export default function CosmosCanvas({ accent = "#c9a35c", drama = 0.6 }: { accent?: string; drama?: number }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const dramaRef = useRef(drama);
  dramaRef.current = drama;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x05070d, 0.055);

    const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 100);
    camera.position.set(0, 0.4, 11);

    const accentColor = new THREE.Color(accent);

    // -- lighting --------------------------------------------------------
    scene.add(new THREE.AmbientLight(0x2a3350, 1.1));
    const keyLight = new THREE.PointLight(accentColor, 42, 60, 1.9);
    keyLight.position.set(-6, 6, 6);
    scene.add(keyLight);
    const rimLight = new THREE.PointLight(0x4a5aff, 16, 50, 2);
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
      color: 0x0d1322,
      roughness: 0.35,
      metalness: 0.75,
      flatShading: true
    });
    const edgeMaterial = new THREE.LineBasicMaterial({ color: accentColor, transparent: true, opacity: 0.5 });

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
      color: accentColor,
      size: 0.045,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true
    });
    const dust = new THREE.Points(dustGeometry, dustMaterial);
    scene.add(dust);

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

      dust.rotation.y = t * 0.008 * drive;
      dustMaterial.opacity = 0.55 + Math.sin(t * 0.6) * 0.15;

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
      dustGeometry.dispose();
      dustMaterial.dispose();
      bodyMaterial.dispose();
      edgeMaterial.dispose();
      for (const [geometry] of shapes) geometry.dispose();
      for (const solid of solids) {
        solid.group.children.forEach((child) => {
          if (child instanceof THREE.LineSegments) child.geometry.dispose();
        });
      }
      if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement);
    };
  }, [accent]);

  return <div ref={mountRef} className="cosmos-canvas" aria-hidden />;
}
