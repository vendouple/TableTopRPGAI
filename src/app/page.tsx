"use client";

import { FormEvent, useEffect, useMemo, useState, useRef, useCallback } from "react";
import type { CSSProperties } from "react";
import type { Campaign, CampaignSummary, DiceEvent, DisplayEvent, Player, SuggestedAction, PlayerStat } from "@/lib/campaign/types";
import { QRCodeSVG } from "qrcode.react";

type Mode = "host" | "controller";

// ===========================================================================
// Web Audio dice SFX — synthesized hum (charge) + thump (settle)
// No external audio files. Context is lazily created on first user gesture.
// ===========================================================================
let _audioCtx: AudioContext | null = null;
let _chargeNodes: { osc: OscillatorNode; lfo: OscillatorNode; lfoGain: GainNode; masterGain: GainNode } | null = null;

function getAudioCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (_audioCtx) return _audioCtx;
  try {
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    _audioCtx = new Ctor();
    return _audioCtx;
  } catch {
    return null;
  }
}

function playDiceCharge() {
  const ctx = getAudioCtx();
  if (!ctx || _chargeNodes) return;
  if (ctx.state === "suspended") ctx.resume().catch(() => {});

  const masterGain = ctx.createGain();
  masterGain.gain.setValueAtTime(0.0, ctx.currentTime);
  masterGain.gain.linearRampToValueAtTime(0.18, ctx.currentTime + 0.4);
  masterGain.connect(ctx.destination);

  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(60, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(140, ctx.currentTime + 2.8);
  const oscGain = ctx.createGain();
  oscGain.gain.setValueAtTime(0.6, ctx.currentTime);
  osc.connect(oscGain).connect(masterGain);
  osc.start();

  const lfo = ctx.createOscillator();
  lfo.type = "sine";
  lfo.frequency.setValueAtTime(3.5, ctx.currentTime);
  lfo.frequency.exponentialRampToValueAtTime(11, ctx.currentTime + 2.8);
  const lfoGain = ctx.createGain();
  lfoGain.gain.setValueAtTime(40, ctx.currentTime);
  lfoGain.gain.exponentialRampToValueAtTime(180, ctx.currentTime + 2.8);
  lfo.connect(lfoGain);
  lfoGain.connect(osc.frequency);
  lfo.start();

  _chargeNodes = { osc, lfo, lfoGain, masterGain };
}

function stopDiceCharge() {
  const ctx = _audioCtx;
  if (!ctx || !_chargeNodes) return;
  const nodes = _chargeNodes;
  try {
    nodes.masterGain.gain.cancelScheduledValues(ctx.currentTime);
    nodes.masterGain.gain.setValueAtTime(nodes.masterGain.gain.value, ctx.currentTime);
    nodes.masterGain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.18);
    nodes.osc.stop(ctx.currentTime + 0.22);
    nodes.lfo.stop(ctx.currentTime + 0.22);
  } catch {
    /* node already stopped */
  }
  _chargeNodes = null;
}

function playDiceImpact() {
  const ctx = getAudioCtx();
  if (!ctx) return;
  if (ctx.state === "suspended") ctx.resume().catch(() => {});

  const now = ctx.currentTime;

  // Thump: low-frequency sine + quick noise burst
  const thumpGain = ctx.createGain();
  thumpGain.gain.setValueAtTime(0.0, now);
  thumpGain.gain.linearRampToValueAtTime(0.55, now + 0.012);
  thumpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
  thumpGain.connect(ctx.destination);

  const thumpOsc = ctx.createOscillator();
  thumpOsc.type = "sine";
  thumpOsc.frequency.setValueAtTime(180, now);
  thumpOsc.frequency.exponentialRampToValueAtTime(50, now + 0.18);
  thumpOsc.connect(thumpGain);
  thumpOsc.start(now);
  thumpOsc.stop(now + 0.5);

  // High "tink" snap
  const tinkGain = ctx.createGain();
  tinkGain.gain.setValueAtTime(0.0, now);
  tinkGain.gain.linearRampToValueAtTime(0.22, now + 0.005);
  tinkGain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
  tinkGain.connect(ctx.destination);

  const tinkOsc = ctx.createOscillator();
  tinkOsc.type = "triangle";
  tinkOsc.frequency.setValueAtTime(2200, now);
  tinkOsc.frequency.exponentialRampToValueAtTime(800, now + 0.4);
  tinkOsc.connect(tinkGain);
  tinkOsc.start(now);
  tinkOsc.stop(now + 0.6);
}


export default function Home() {
  const [mode, setMode] = useState<Mode>("host");
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [playerName, setPlayerName] = useState("Player");
  const [localPlayer, setLocalPlayer] = useState<Player | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const campaignId = campaign?.id;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setMode(params.get("controller") === "1" ? "controller" : "host");
    refreshCampaigns();
  }, []);

  const campaignStatus = campaign?.status;
  const dmStatus = campaign?.dmStatus;

  const isInitialIntro = useMemo(() => {
    if (!campaign) return false;
    return !campaign.displayEvents.some(
      (e) => e.type === "narration" || e.type === "dialogue"
    );
  }, [campaign]);

  const playLobbyBGM = !!(campaign && (campaign.status === "lobby" || (campaign.status === "active" && isInitialIntro)));

  useEffect(() => {
    if (!campaignId) return;

    let intervalMs = 6000; // default for active campaign with idle DM
    if (campaignStatus === "lobby") {
      intervalMs = 4000;
    } else if (dmStatus) {
      intervalMs = 2000; // fast polling when DM is thinking/generating
    }

    const poll = async () => {
      if (document.hidden) return; // skip if tab is in background
      try {
        const url = `/api/campaigns/${campaignId}${mode === "host" ? "?host=1" : ""}`;
        const fresh = await fetchJson<{ campaign: Campaign }>(url);
        setCampaign((prev) => {
          if (!prev || prev.updatedAt !== fresh.campaign.updatedAt || prev.dmStatus !== fresh.campaign.dmStatus) {
            return fresh.campaign;
          }
          return prev;
        });
      } catch (err) {
        console.error("Polling error:", err);
      }
    };

    poll();

    const timer = window.setInterval(poll, intervalMs);

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        poll();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [campaignId, campaignStatus, dmStatus, mode]);

  async function refreshCampaigns() {
    const data = await fetchJson<{ campaigns: CampaignSummary[] }>("/api/campaigns");
    setCampaigns(data.campaigns);
  }

  async function loadCampaign(id: string) {
    console.log(`[Main] User clicked load campaign for ID: ${id}`);
    const data = await fetchJson<{ campaign: Campaign }>(`/api/campaigns/${id}`);
    console.log(`[Main] Campaign loaded successfully: "${data.campaign.title}"`);
    setCampaign(data.campaign);
  }

  if (mode === "controller") {
    return (
      <main className="app-shell controller-wrap" data-theme={themeOf(campaign)}>
        <ControllerView
          campaign={campaign}
          campaigns={campaigns}
          refreshCampaigns={refreshCampaigns}
          playerName={playerName}
          setPlayerName={setPlayerName}
          localPlayer={localPlayer}
          setLocalPlayer={setLocalPlayer}
          setCampaign={setCampaign}
          busy={busy}
          setBusy={setBusy}
          error={error}
          setError={setError}
        />
      </main>
    );
  }

  if (!campaign) {
    return (
      <main className="app-shell setup-wrap">
        <SetupView 
          campaigns={campaigns} 
          onCreate={setCampaign} 
          onLoad={loadCampaign} 
          onDelete={refreshCampaigns}
          busy={busy} 
          setBusy={setBusy} 
          error={error} 
          setError={setError} 
        />
      </main>
    );
  }

  return (
    <>
      <HostView campaign={campaign} setCampaign={setCampaign} busy={busy} setBusy={setBusy} error={error} setError={setError} />
      {playLobbyBGM && <LobbyBGM />}
    </>
  );
}

// ===========================================================================
// Mode flavor — the frontend adapts its identity to the campaign type.
// "dnd" keeps the classic ember-gold arcane look; "tabletop" becomes a
// genre-neutral storyteller table with an arcane-teal ink identity.
// ===========================================================================
type CampaignTypeChoice = "tabletop" | "dnd";

function themeOf(campaign?: { campaignType?: CampaignTypeChoice } | null): CampaignTypeChoice {
  return campaign?.campaignType === "tabletop" ? "tabletop" : "dnd";
}

function flavorOf(campaignType?: CampaignTypeChoice) {
  const isDnd = campaignType !== "tabletop";
  return {
    isDnd,
    dmName: isDnd ? "Dungeon Master" : "Storyteller",
    gateKicker: isDnd ? "✦ CAMPAIGN GATE ✦" : "✦ STORY LOOM ✦",
    gateTitle: isDnd ? "Opening the Gate" : "Weaving the Tale",
    spliceKicker: isDnd ? "✦ SOUL SPLICE ✦" : "✦ NEW THREAD ✦",
    spliceTitle: isDnd ? "Merging a new soul" : "Weaving a new thread",
    emptyRoster: isDnd ? "No souls have arrived yet." : "No storytellers have arrived yet.",
    joined: (n: number) => isDnd
      ? `${n} soul${n === 1 ? "" : "s"} bound.`
      : `${n} storyteller${n === 1 ? "" : "s"} at the table.`,
    awaitingFirst: isDnd ? "Awaiting the first soul..." : "Awaiting the first storyteller...",
  };
}

const LENGTH_OPTIONS = [
  { value: "short", icon: "⚡", label: "Short", detail: "2 chapters" },
  { value: "medium", icon: "⚔️", label: "Medium", detail: "4 chapters" },
  { value: "long", icon: "🏰", label: "Long", detail: "6 chapters" },
  { value: "extra_long", icon: "🐉", label: "Epic", detail: "8 chapters" },
  { value: "infinite", icon: "🌌", label: "Endless", detail: "12 chapters" },
] as const;

// ===========================================================================
// Decorative SVG suite — animated backdrop, mode crests, dividers, frames.
// All colors run through CSS variables so the whole suite retints per theme.
// ===========================================================================

function ArcaneBackdrop() {
  // Deterministic pseudo-random ember placement (no Math.random → no hydration mismatch)
  const embers = Array.from({ length: 22 }, (_, i) => {
    const left = ((i * 41.7) % 97) + 1.5;
    const size = 2 + ((i * 7) % 4);
    const delay = (i * 1.37) % 14;
    const duration = 11 + ((i * 3.1) % 9);
    const drift = ((i % 5) - 2) * 14;
    return { left, size, delay, duration, drift };
  });

  return (
    <div className="arcane-backdrop" aria-hidden="true">
      <svg className="backdrop-ring ring-a" viewBox="0 0 600 600">
        <circle cx="300" cy="300" r="284" fill="none" stroke="currentColor" strokeOpacity="0.16" strokeWidth="1" strokeDasharray="3 9 34 9" />
        <circle cx="300" cy="300" r="250" fill="none" stroke="currentColor" strokeOpacity="0.28" strokeWidth="1.4" strokeDasharray="6 14 52 14" />
        <circle cx="300" cy="300" r="212" fill="none" stroke="currentColor" strokeOpacity="0.14" strokeWidth="0.8" strokeDasharray="2 7 18 7" />
        <g stroke="currentColor" strokeOpacity="0.3" strokeWidth="1.4">
          {Array.from({ length: 24 }, (_, i) => {
            const a = (i / 24) * Math.PI * 2;
            const long = i % 6 === 0;
            const r1 = long ? 226 : 238;
            // round to avoid server/client float drift → hydration mismatch
            const rd = (v: number) => Math.round(v * 100) / 100;
            return (
              <line
                key={i}
                x1={rd(300 + Math.cos(a) * r1)} y1={rd(300 + Math.sin(a) * r1)}
                x2={rd(300 + Math.cos(a) * 250)} y2={rd(300 + Math.sin(a) * 250)}
              />
            );
          })}
        </g>
        <g fill="currentColor" fillOpacity="0.5">
          {Array.from({ length: 8 }, (_, i) => {
            const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
            const rd = (v: number) => Math.round(v * 100) / 100;
            return <circle key={i} cx={rd(300 + Math.cos(a) * 250)} cy={rd(300 + Math.sin(a) * 250)} r={i % 2 === 0 ? 4 : 2.4} />;
          })}
        </g>
      </svg>
      <svg className="backdrop-ring ring-b" viewBox="0 0 600 600">
        <circle cx="300" cy="300" r="270" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1" strokeDasharray="1 6 12 6" />
        <g stroke="currentColor" strokeOpacity="0.16" strokeWidth="1" fill="none">
          {Array.from({ length: 6 }, (_, i) => {
            const a1 = (i / 6) * Math.PI * 2 - Math.PI / 2;
            const a2 = ((i + 2) / 6) * Math.PI * 2 - Math.PI / 2;
            const rd = (v: number) => Math.round(v * 100) / 100;
            return (
              <line
                key={i}
                x1={rd(300 + Math.cos(a1) * 200)} y1={rd(300 + Math.sin(a1) * 200)}
                x2={rd(300 + Math.cos(a2) * 200)} y2={rd(300 + Math.sin(a2) * 200)}
              />
            );
          })}
        </g>
      </svg>
      <div className="backdrop-embers">
        {embers.map((e, i) => (
          <span
            key={i}
            style={{
              left: `${e.left}%`,
              width: `${e.size}px`,
              height: `${e.size}px`,
              animationDelay: `${e.delay}s`,
              animationDuration: `${e.duration}s`,
              "--drift": `${e.drift}px`,
            } as CSSProperties}
          />
        ))}
      </div>
      <div className="backdrop-nebula" />
    </div>
  );
}

function CornerFrame() {
  const corner = (
    <svg viewBox="0 0 90 90" fill="none">
      <path d="M4 66 V14 Q4 4 14 4 H66" stroke="currentColor" strokeOpacity="0.55" strokeWidth="2" strokeLinecap="round" />
      <path d="M12 58 V20 Q12 12 20 12 H58" stroke="currentColor" strokeOpacity="0.22" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M4 4 L22 22" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="4" cy="66" r="3" fill="currentColor" fillOpacity="0.8" />
      <circle cx="66" cy="4" r="3" fill="currentColor" fillOpacity="0.8" />
      <path d="M22 22 l6 -2 -2 6 z" fill="currentColor" fillOpacity="0.6" />
    </svg>
  );
  return (
    <div className="corner-frame" aria-hidden="true">
      <span className="cf cf-tl">{corner}</span>
      <span className="cf cf-tr">{corner}</span>
      <span className="cf cf-bl">{corner}</span>
      <span className="cf cf-br">{corner}</span>
    </div>
  );
}

function SectionDivider({ label }: { label: string }) {
  return (
    <div className="section-divider">
      <span className="divider-rule" aria-hidden="true" />
      <svg className="divider-gem" viewBox="0 0 26 26" aria-hidden="true">
        <path d="M13 2 L24 13 L13 24 L2 13 Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeOpacity="0.85" />
        <path d="M13 7 L19 13 L13 19 L7 13 Z" fill="currentColor" fillOpacity="0.35" />
        <circle cx="13" cy="13" r="1.8" fill="currentColor" />
      </svg>
      <span className="divider-label">{label}</span>
      <svg className="divider-gem" viewBox="0 0 26 26" aria-hidden="true">
        <path d="M13 2 L24 13 L13 24 L2 13 Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeOpacity="0.85" />
        <path d="M13 7 L19 13 L13 19 L7 13 Z" fill="currentColor" fillOpacity="0.35" />
        <circle cx="13" cy="13" r="1.8" fill="currentColor" />
      </svg>
      <span className="divider-rule" aria-hidden="true" />
    </div>
  );
}

function DndCrest({ active }: { active: boolean }) {
  return (
    <svg className={`mode-crest crest-dnd ${active ? "crest-active" : ""}`} viewBox="0 0 160 160">
      <defs>
        <radialGradient id="dndAura" cx="50%" cy="46%" r="52%">
          <stop offset="0%" stopColor="#ffd77a" stopOpacity="0.55" />
          <stop offset="55%" stopColor="#d9a441" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#d9a441" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="dndFaceHi" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ffe9b0" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#c8892b" stopOpacity="0.8" />
        </linearGradient>
        <linearGradient id="dndFaceLo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#8a5a1c" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#3c2508" stopOpacity="0.95" />
        </linearGradient>
        <linearGradient id="dndFaceMid" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#e8b85a" />
          <stop offset="100%" stopColor="#9c6a20" />
        </linearGradient>
        <filter id="dndGlow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="2.4" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      <circle cx="80" cy="80" r="74" fill="url(#dndAura)" className="crest-aura" />
      <g className="crest-orbit">
        <circle cx="80" cy="80" r="66" fill="none" stroke="#e9bd66" strokeOpacity="0.5" strokeWidth="1.3" strokeDasharray="5 9 26 9" />
        <circle cx="80" cy="14" r="2.6" fill="#ffe9b0" />
        <circle cx="80" cy="146" r="1.8" fill="#ffe9b0" fillOpacity="0.7" />
      </g>
      <g className="crest-orbit-rev">
        <circle cx="80" cy="80" r="57" fill="none" stroke="#e9bd66" strokeOpacity="0.28" strokeWidth="0.9" strokeDasharray="2 6 14 6" />
      </g>

      <g className="crest-body" filter="url(#dndGlow)">
        {/* d20 silhouette */}
        <polygon points="80,30 121,54 121,104 80,130 39,104 39,54" fill="url(#dndFaceLo)" stroke="#f3cd7d" strokeWidth="2" strokeLinejoin="round" />
        {/* top faces */}
        <polygon points="80,30 121,54 80,60" fill="url(#dndFaceMid)" fillOpacity="0.85" />
        <polygon points="80,30 39,54 80,60" fill="url(#dndFaceHi)" fillOpacity="0.55" />
        {/* central face */}
        <polygon points="80,60 104,98 56,98" fill="url(#dndFaceHi)" />
        {/* side faces */}
        <polygon points="121,54 104,98 80,60" fill="url(#dndFaceMid)" fillOpacity="0.6" />
        <polygon points="39,54 56,98 80,60" fill="url(#dndFaceMid)" fillOpacity="0.4" />
        <polygon points="121,54 121,104 104,98" fill="url(#dndFaceLo)" />
        <polygon points="39,54 39,104 56,98" fill="url(#dndFaceLo)" />
        <polygon points="80,130 104,98 121,104" fill="url(#dndFaceMid)" fillOpacity="0.5" />
        <polygon points="80,130 56,98 39,104" fill="url(#dndFaceLo)" fillOpacity="0.85" />
        <polygon points="80,130 56,98 104,98" fill="url(#dndFaceMid)" fillOpacity="0.72" />
        <g stroke="#f3cd7d" strokeWidth="1.1" strokeOpacity="0.85" fill="none" strokeLinejoin="round">
          <line x1="80" y1="30" x2="80" y2="60" />
          <line x1="39" y1="54" x2="80" y2="60" />
          <line x1="121" y1="54" x2="80" y2="60" />
          <line x1="121" y1="54" x2="104" y2="98" />
          <line x1="39" y1="54" x2="56" y2="98" />
          <line x1="121" y1="104" x2="104" y2="98" />
          <line x1="39" y1="104" x2="56" y2="98" />
          <line x1="80" y1="130" x2="104" y2="98" />
          <line x1="80" y1="130" x2="56" y2="98" />
          <line x1="56" y1="98" x2="104" y2="98" />
          <line x1="80" y1="60" x2="104" y2="98" />
          <line x1="80" y1="60" x2="56" y2="98" />
        </g>
        <text x="80" y="88" textAnchor="middle" fontFamily="Cinzel, Georgia, serif" fontWeight="700" fontSize="24" fill="#2b1a05" className="crest-number">20</text>
      </g>

      <g className="crest-sparks" fill="#ffe9b0">
        <circle cx="26" cy="42" r="1.8" className="spark s1" />
        <circle cx="138" cy="52" r="1.4" className="spark s2" />
        <circle cx="30" cy="120" r="1.5" className="spark s3" />
        <circle cx="132" cy="116" r="2" className="spark s4" />
      </g>
    </svg>
  );
}

function TabletopCrest({ active }: { active: boolean }) {
  return (
    <svg className={`mode-crest crest-tabletop ${active ? "crest-active" : ""}`} viewBox="0 0 160 160">
      <defs>
        <radialGradient id="ttAura" cx="50%" cy="50%" r="52%">
          <stop offset="0%" stopColor="#9fe8f2" stopOpacity="0.5" />
          <stop offset="55%" stopColor="#4db3c4" stopOpacity="0.16" />
          <stop offset="100%" stopColor="#4db3c4" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="ttPageL" x1="0" y1="0" x2="1" y2="0.4">
          <stop offset="0%" stopColor="#dff6f9" />
          <stop offset="100%" stopColor="#9fd3dc" />
        </linearGradient>
        <linearGradient id="ttPageR" x1="1" y1="0" x2="0" y2="0.4">
          <stop offset="0%" stopColor="#eafcff" />
          <stop offset="100%" stopColor="#aadde5" />
        </linearGradient>
        <linearGradient id="ttCover" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#1c6273" />
          <stop offset="100%" stopColor="#0c3540" />
        </linearGradient>
        <linearGradient id="ttQuill" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#eafcff" />
          <stop offset="60%" stopColor="#7fd4e2" />
          <stop offset="100%" stopColor="#2e8ba0" />
        </linearGradient>
        <filter id="ttGlow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="2.2" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      <circle cx="80" cy="80" r="74" fill="url(#ttAura)" className="crest-aura" />
      <g className="crest-orbit">
        <circle cx="80" cy="80" r="66" fill="none" stroke="#7fd4e2" strokeOpacity="0.45" strokeWidth="1.3" strokeDasharray="5 9 26 9" />
        <circle cx="146" cy="80" r="2.4" fill="#c9f2f7" />
        <circle cx="14" cy="80" r="1.7" fill="#c9f2f7" fillOpacity="0.7" />
      </g>
      <g className="crest-orbit-rev">
        <circle cx="80" cy="80" r="57" fill="none" stroke="#7fd4e2" strokeOpacity="0.25" strokeWidth="0.9" strokeDasharray="2 6 14 6" />
      </g>

      <g className="crest-body" filter="url(#ttGlow)">
        {/* open tome */}
        <path d="M28 96 Q28 62 80 66 Q132 62 132 96 L132 106 Q132 100 80 104 Q28 100 28 106 Z" fill="url(#ttCover)" stroke="#8fdbe8" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M34 92 Q40 66 80 70 L80 98 Q46 94 34 98 Z" fill="url(#ttPageL)" />
        <path d="M126 92 Q120 66 80 70 L80 98 Q114 94 126 98 Z" fill="url(#ttPageR)" />
        <g stroke="#2e8ba0" strokeOpacity="0.55" strokeWidth="1.2" strokeLinecap="round">
          <path d="M42 80 Q58 76 72 78" fill="none" />
          <path d="M42 86 Q58 82 72 84" fill="none" />
          <path d="M88 78 Q102 76 118 80" fill="none" />
          <path d="M88 84 Q102 82 118 86" fill="none" />
        </g>
        {/* quill */}
        <g className="crest-quill">
          <path d="M84 92 Q96 58 128 30 Q112 66 92 94 Z" fill="url(#ttQuill)" stroke="#c9f2f7" strokeWidth="1" strokeLinejoin="round" />
          <path d="M92 82 Q104 58 122 38" fill="none" stroke="#0c3540" strokeOpacity="0.5" strokeWidth="1" />
          <path d="M84 92 L80 100 L88 96 Z" fill="#0c3540" stroke="#7fd4e2" strokeWidth="0.8" />
        </g>
        {/* ink trail written by the quill */}
        <path className="crest-ink" d="M46 116 Q66 108 84 114 T126 112" fill="none" stroke="#8fdbe8" strokeWidth="2" strokeLinecap="round" strokeDasharray="90" />
      </g>

      <g className="crest-sparks" fill="#c9f2f7">
        <circle cx="36" cy="40" r="1.7" className="spark s1" />
        <circle cx="130" cy="58" r="1.3" className="spark s2" />
        <circle cx="26" cy="112" r="1.5" className="spark s3" />
        <circle cx="136" cy="124" r="1.9" className="spark s4" />
      </g>
    </svg>
  );
}

function SetupView({ campaigns, onCreate, onLoad, onDelete, busy, setBusy, error, setError }: {
  campaigns: CampaignSummary[];
  onCreate: (campaign: Campaign) => void;
  onLoad: (id: string) => void;
  onDelete: () => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  error: string;
  setError: (error: string) => void;
}) {
  const [title, setTitle] = useState("The Unwritten Road");
  const [startingStory, setStartingStory] = useState("");
  const [campaignType, setCampaignType] = useState<"tabletop" | "dnd">("tabletop");
  const [campaignLength, setCampaignLength] = useState<"short" | "medium" | "long" | "extra_long" | "infinite">("medium");
  const [rulesMode, setRulesMode] = useState<"casual" | "full">("casual");
  const [storyCharacters, setStoryCharacters] = useState<Array<{ id: string; name: string; description: string; status: "Starting NPC" | "Future NPC" }>>([]);
  const [suggestingNpcs, setSuggestingNpcs] = useState(false);
  const [generatingNpcId, setGeneratingNpcId] = useState<string | null>(null);
  const [campaignToDelete, setCampaignToDelete] = useState<{ id: string; name: string } | null>(null);

  async function handleDeleteCampaign(id: string, name: string) {
    console.log(`[Setup] User clicked delete campaign for "${name}" (ID: ${id})`);
    setCampaignToDelete({ id, name });
  }

  async function confirmDeleteCampaign() {
    if (!campaignToDelete) return;
    const { id, name } = campaignToDelete;
    console.log(`[Setup] User confirmed deletion of campaign: "${name}" (ID: ${id})`);
    setCampaignToDelete(null);
    await runBusy(setBusy, setError, async () => {
      await fetchJson(`/api/campaigns/${id}`, { method: "DELETE" });
      console.log(`[Setup] Campaign "${name}" (ID: ${id}) deleted successfully.`);
      onDelete();
    });
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    console.log(`[Setup] User clicked "Create campaign" for title: "${title}"`);
    await runBusy(setBusy, setError, async () => {
      const data = await fetchJson<{ campaign: Campaign }>("/api/campaigns", {
        method: "POST",
        body: JSON.stringify({ 
          title, 
          startingStory, 
          storyCharacters: storyCharacters.map(n => ({ name: n.name, description: n.description, status: n.status })), 
          isRandomized: false, 
          campaignType,
          campaignLength,
          rulesMode: campaignType === "dnd" ? rulesMode : "casual"
        })
      });
      console.log(`[Setup] Campaign created successfully with ID: ${data.campaign.id}`);
      onCreate(data.campaign);
    });
  }

  async function handleCampaignGeneration() {
    console.log(`[Setup] User clicked generate/improve starting scenario. Prompt: "${startingStory.slice(0, 100)}..."`);
    await runBusy(setBusy, setError, async () => {
      const data = await fetchJson<{ result: { title: string; startingStory: string } }>("/api/generate", {
        method: "POST",
        body: JSON.stringify({ type: "campaign", prompt: startingStory, campaignType, rulesMode: campaignType === "dnd" ? rulesMode : "casual" })
      });
      console.log(`[Setup] Successfully generated campaign details. Title: "${data.result.title}"`);
      setTitle(data.result.title);
      setStartingStory(data.result.startingStory);
    });
  }

  function addNpc() {
    setStoryCharacters((prev) => [
      ...prev,
      { id: "npc_" + Math.random().toString(36).substring(2, 9), name: "", description: "", status: "Starting NPC" }
    ]);
  }

  function removeNpc(id: string) {
    setStoryCharacters((prev) => prev.filter((n) => n.id !== id));
  }

  function updateNpc(id: string, field: string, value: string) {
    setStoryCharacters((prev) =>
      prev.map((n) => (n.id === id ? { ...n, [field]: value } : n))
    );
  }

  async function suggestNpcs() {
    if (!startingStory.trim()) {
      setError("Please describe the starting background story first so we can suggest relevant NPCs.");
      return;
    }
    setSuggestingNpcs(true);
    setError("");
    try {
      const data = await fetchJson<{ result: { npcs: Array<{ name: string; description: string; status?: string }> } }>("/api/generate", {
        method: "POST",
        body: JSON.stringify({ type: "suggest_npcs", prompt: startingStory, campaignType, rulesMode: campaignType === "dnd" ? rulesMode : "casual" })
      });
      const generated = data.result.npcs.map((n) => ({
        id: "npc_" + Math.random().toString(36).substring(2, 9),
        name: n.name,
        description: n.description,
        status: (n.status === "Future NPC" ? "Future NPC" : "Starting NPC") as "Starting NPC" | "Future NPC"
      }));
      setStoryCharacters((prev) => [...prev, ...generated]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to suggest NPCs");
    } finally {
      setSuggestingNpcs(false);
    }
  }

  async function generateOrImproveNpc(npcId: string) {
    const targetNpc = storyCharacters.find((n) => n.id === npcId);
    if (!targetNpc) return;
    setGeneratingNpcId(npcId);
    setError("");
    try {
      const data = await fetchJson<{ result: { name: string; description: string } }>("/api/generate", {
        method: "POST",
        body: JSON.stringify({
          type: "npc",
          prompt: targetNpc.description,
          name: targetNpc.name,
          startingStory,
          campaignType,
          rulesMode: campaignType === "dnd" ? rulesMode : "casual"
        })
      });
      setStoryCharacters((prev) =>
        prev.map((n) => (n.id === npcId ? { ...n, name: data.result.name, description: data.result.description } : n))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate NPC");
    } finally {
      setGeneratingNpcId(null);
    }
  }

  return (
    <div className="setup-scope" data-theme={campaignType}>
      <ArcaneBackdrop />
      <section className="setup-card setup-card-v2">
      <CornerFrame />
      <header className="setup-hero">
        <div className="setup-hero-top">
          <span className="setup-kicker">✦ Local AI Game Table ✦</span>
          <a href="/?controller=1" className="controller-link-pill">📱 Join as Controller</a>
        </div>
        <h1 className="setup-title">{campaignType === "dnd" ? "Forge Your Campaign" : "Weave Your Story"}</h1>
        <p className="setup-subtitle">
          Craft the adventure on this display — players join from their phones as living characters,
          and the AI {campaignType === "dnd" ? "Dungeon Master" : "Storyteller"} runs the table.
        </p>
      </header>
      <form className="form-grid setup-form" onSubmit={create}>
        <div className="mode-card-grid" role="radiogroup" aria-label="Campaign type">
          <button
            type="button"
            role="radio"
            aria-checked={campaignType === "tabletop"}
            className={`mode-card mode-tabletop ${campaignType === "tabletop" ? "selected" : ""}`}
            onClick={() => setCampaignType("tabletop")}
          >
            <TabletopCrest active={campaignType === "tabletop"} />
            <strong className="mode-card-name">Storyteller RPG</strong>
            <span className="mode-card-desc">Any genre, any world — sci-fi heists, noir mysteries, cozy fables. Rules-light and narrative-first: your story leads, the dice follow.</span>
            <span className="mode-card-badge">{campaignType === "tabletop" ? "✦ Selected" : "Choose"}</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={campaignType === "dnd"}
            className={`mode-card mode-dnd ${campaignType === "dnd" ? "selected" : ""}`}
            onClick={() => setCampaignType("dnd")}
          >
            <DndCrest active={campaignType === "dnd"} />
            <strong className="mode-card-name">Dungeons &amp; Dragons</strong>
            <span className="mode-card-desc">Classic high-fantasy campaign — classes, ability checks, advantage and disadvantage, critical hits, and an AI Dungeon Master behind the screen.</span>
            <span className="mode-card-badge">{campaignType === "dnd" ? "✦ Selected" : "Choose"}</span>
          </button>
        </div>

        <label>Campaign title<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="E.g. The Unwritten Road" /></label>
        <label>
          Starting background story (Optional, but recommended)
          <textarea 
            value={startingStory} 
            onChange={(event) => setStartingStory(event.target.value)} 
            placeholder="Describe the opening situation, location, tone, or threat. If empty, the DM will generate a starting scene." 
          />
        </label>
        
        <button 
          type="button" 
          disabled={busy} 
          onClick={handleCampaignGeneration}
          className="generate-prompt-btn"
          style={{ 
            background: "rgba(217, 164, 65, 0.08)", 
            border: "1px solid rgba(217, 164, 65, 0.35)", 
            color: "var(--gold)", 
            fontSize: "0.85rem",
            padding: "0.5rem 1.1rem",
            borderRadius: "10px",
            marginTop: "-0.5rem",
            marginBottom: "0.5rem",
            alignSelf: "flex-start",
            width: "fit-content",
            cursor: "pointer",
            fontWeight: 600,
            transition: "all 0.2s ease"
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "rgba(217, 164, 65, 0.16)";
            e.currentTarget.style.borderColor = "var(--gold)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "rgba(217, 164, 65, 0.08)";
            e.currentTarget.style.borderColor = "rgba(217, 164, 65, 0.35)";
          }}
        >
          {startingStory.trim() ? "✨ Improve my prompt" : "🎲 Generate me a campaign"}
        </button>

        {campaignType === "dnd" && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "rgba(255,255,255,0.02)", border: "1px solid var(--line)", padding: "0.75rem 1rem", borderRadius: "12px", margin: "0.5rem 0", gap: "1rem" }}>
          <div style={{ flex: 1 }}>
            <strong style={{ display: "block", color: "var(--text)", fontSize: "0.95rem" }}>Full D&D Rules Mode</strong>
            <span className="small" style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: "0.15rem", display: "block", lineHeight: "1.25" }}>Toggle on for character classes, standard attribute stats, modifiers, and rests; toggle off for casual backstory play.</span>
          </div>
          <label className="switch" style={{ position: "relative", display: "inline-block", width: "46px", height: "24px", margin: 0, flexShrink: 0 }}>
            <input 
              type="checkbox" 
              checked={rulesMode === "full"} 
              onChange={(e) => setRulesMode(e.target.checked ? "full" : "casual")}
              style={{ opacity: 0, width: 0, height: 0 }}
            />
            <span style={{
              position: "absolute",
              cursor: "pointer",
              top: 0, left: 0, right: 0, bottom: 0,
              backgroundColor: rulesMode === "full" ? "var(--gold)" : "rgba(255,255,255,0.15)",
              transition: "0.3s",
              borderRadius: "24px",
              boxShadow: rulesMode === "full" ? "0 0 8px rgba(217, 164, 65, 0.4)" : "none"
            }}>
              <span style={{
                position: "absolute",
                content: '""',
                height: "18px", width: "18px",
                left: "3px", bottom: "3px",
                backgroundColor: "#fff",
                transition: "0.3s",
                borderRadius: "50%",
                transform: rulesMode === "full" ? "translateX(22px)" : "translateX(0)"
              }} />
            </span>
          </label>
        </div>
        )}

        <div className="length-section">
          <span className="field-label">Campaign length</span>
          <div className="length-chip-row" role="radiogroup" aria-label="Campaign length">
            {LENGTH_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={campaignLength === opt.value}
                className={`length-chip ${campaignLength === opt.value ? "selected" : ""}`}
                onClick={() => setCampaignLength(opt.value)}
              >
                <span className="length-chip-icon">{opt.icon}</span>
                <span className="length-chip-label">{opt.label}</span>
                <span className="length-chip-detail">{opt.detail}</span>
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginTop: "0.5rem" }}>
          <SectionDivider label="Key Characters" />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
            <h3 style={{ margin: 0, color: "var(--gold)", fontSize: "1.1rem" }}>Starting & Future NPCs (Optional)</h3>
            <button 
              type="button" 
              onClick={suggestNpcs} 
              disabled={suggestingNpcs}
              className="generate-prompt-btn"
              style={{ fontSize: "0.8rem", padding: "0.3rem 0.7rem", borderRadius: "8px", cursor: "pointer" }}
            >
              {suggestingNpcs ? "🪄 Suggesting..." : "✨ Suggest NPCs from Story"}
            </button>
          </div>
          <p className="small" style={{ margin: "0 0 1rem 0" }}>Define key characters that start in this campaign or will appear later. The AI can suggest them or generate their backstory.</p>
          
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem", marginBottom: "1rem" }}>
            {storyCharacters.map((npc) => (
              <div 
                key={npc.id} 
                style={{ 
                  background: "rgba(255,255,255,0.02)", 
                  border: "1px solid var(--line)", 
                  borderRadius: "10px", 
                  padding: "0.75rem",
                  position: "relative"
                }}
              >
                <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "0.5rem", marginBottom: "0.5rem" }}>
                  <input 
                    value={npc.name} 
                    onChange={(e) => updateNpc(npc.id, "name", e.target.value)} 
                    placeholder="NPC Name (e.g. Elminster, Old Barnaby)"
                    style={{ background: "transparent", borderBottom: "1px solid rgba(255,255,255,0.15)", borderRadius: 0, padding: "0.2rem 0" }}
                  />
                  <button 
                    type="button" 
                    onClick={() => removeNpc(npc.id)}
                    style={{ background: "rgba(239, 68, 68, 0.1)", border: "1px solid rgba(239,68,68,0.3)", color: "#ff8888", fontSize: "0.75rem", padding: "0.2rem 0.5rem", borderRadius: "6px", cursor: "pointer" }}
                  >
                    Remove
                  </button>
                </div>
                
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "start" }}>
                  <textarea 
                    value={npc.description} 
                    onChange={(e) => updateNpc(npc.id, "description", e.target.value)} 
                    placeholder="Describe their backstory, traits, motives, or relationship to the party..."
                    style={{ height: "60px", fontSize: "0.8rem", width: "100%" }}
                  />
                </div>

                <button
                  type="button"
                  disabled={generatingNpcId === npc.id}
                  onClick={() => generateOrImproveNpc(npc.id)}
                  className="generate-prompt-btn"
                  style={{ 
                    fontSize: "0.75rem", 
                    padding: "0.25rem 0.6rem", 
                    borderRadius: "6px", 
                    marginTop: "0.5rem", 
                    display: "inline-flex", 
                    alignSelf: "flex-start", 
                    cursor: "pointer" 
                  }}
                >
                  {generatingNpcId === npc.id ? "🪄 Forging..." : npc.description.trim() ? "✨ Improve Backstory" : "✍️ Generate for me"}
                </button>
              </div>
            ))}
          </div>

          <button 
            type="button" 
            onClick={addNpc} 
            style={{ 
              background: "transparent", 
              border: "1px dashed rgba(217,164,65,0.4)", 
              color: "var(--gold)", 
              fontSize: "0.85rem", 
              width: "100%", 
              padding: "0.5rem",
              borderRadius: "10px",
              cursor: "pointer"
            }}
          >
            + Add Custom NPC
          </button>
        </div>

        <button disabled={busy} className="create-campaign-btn" style={{ marginTop: "1rem" }}>
          {busy ? "⏳ Creating..." : campaignType === "dnd" ? "⚔️ Begin the Campaign" : "✒️ Begin the Story"}
        </button>
      </form>
      {campaigns.length > 0 && <SectionDivider label="Continue a Saga" />}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        {campaigns.map((item) => (
          <div key={item.id} style={{ display: "flex", gap: "0.5rem" }}>
            <button
              onClick={() => onLoad(item.id)}
              className="load-campaign-btn"
              style={{ flex: 1, textAlign: "left", display: "flex", alignItems: "center", gap: "0.75rem" }}
            >
              <span className={`saga-type-badge ${item.campaignType === "dnd" ? "badge-dnd" : "badge-tabletop"}`}>
                {item.campaignType === "dnd" ? "D&D" : "RPG"}
              </span>
              <span style={{ flex: 1 }}>
                <strong style={{ display: "block" }}>{item.title}</strong>
                <span className="small" style={{ fontSize: "0.78rem" }}>
                  {item.playerCount} player{item.playerCount === 1 ? "" : "s"} · code {item.joinCode}
                </span>
              </span>
            </button>
            <button 
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handleDeleteCampaign(item.id, item.title);
              }}
              style={{ 
                background: "rgba(239, 68, 68, 0.1)", 
                border: "1px solid rgba(239, 68, 68, 0.3)", 
                color: "#ff8888", 
                padding: "0 1rem", 
                borderRadius: "10px",
                cursor: "pointer",
                fontWeight: 600,
                transition: "all 0.2s ease"
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "rgba(239, 68, 68, 0.2)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "rgba(239, 68, 68, 0.1)";
              }}
            >
              Delete
            </button>
          </div>
        ))}
      </div>
      {error && <p className="small">{error}</p>}

      {campaignToDelete && (
        <div style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0, 0, 0, 0.75)",
          backdropFilter: "blur(8px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 1000,
          padding: "1.5rem"
        }}>
          <div style={{
            background: "var(--panel-strong)",
            border: "1px solid var(--line)",
            borderRadius: "16px",
            padding: "2.5rem 2rem",
            maxWidth: "450px",
            width: "100%",
            textAlign: "center",
            boxShadow: "0 10px 30px rgba(0, 0, 0, 0.5)",
            boxSizing: "border-box"
          }}>
            <h3 style={{
              margin: "0 0 1rem 0",
              color: "#ff8888",
              fontSize: "1.5rem",
              fontFamily: "Cinzel, Georgia, serif",
              letterSpacing: "0.05em"
            }}>
              ⚔️ Delete Campaign? ⚔️
            </h3>
            <p style={{
              fontSize: "1rem",
              color: "var(--text)",
              marginBottom: "2rem",
              lineHeight: "1.5",
              fontFamily: "'Spectral', Georgia, serif"
            }}>
              Are you sure you want to delete the campaign <strong>&ldquo;{campaignToDelete.name}&rdquo;</strong>?
              <br />
              <span style={{ color: "var(--muted)", fontSize: "0.85rem", display: "block", marginTop: "0.5rem" }}>
                This action is permanent and cannot be undone.
              </span>
            </p>
            <div style={{ display: "flex", gap: "1rem", justifyContent: "center" }}>
              <button
                type="button"
                onClick={() => setCampaignToDelete(null)}
                style={{
                  background: "transparent",
                  border: "1px solid var(--line)",
                  color: "var(--text)",
                  borderRadius: "10px",
                  padding: "0.6rem 1.5rem",
                  cursor: "pointer",
                  fontSize: "0.9rem",
                  fontWeight: 600,
                  transition: "all 0.2s ease"
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDeleteCampaign}
                style={{
                  background: "linear-gradient(135deg, #9a2e2e, #c53030)",
                  border: "1px solid rgba(239, 68, 68, 0.4)",
                  color: "#fff",
                  borderRadius: "10px",
                  padding: "0.6rem 1.5rem",
                  cursor: "pointer",
                  fontSize: "0.9rem",
                  fontWeight: 600,
                  boxShadow: "0 4px 12px rgba(154, 46, 46, 0.3)",
                  transition: "all 0.2s ease"
                }}
              >
                Yes, Delete
              </button>
            </div>
          </div>
        </div>
      )}
      </section>
    </div>
  );
}

function HostView(props: {
  campaign: Campaign;
  setCampaign: (campaign: Campaign) => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  error: string;
  setError: (error: string) => void;
}) {
  const [adminOpen, setAdminOpen] = useState(false);
  return (
    <main className="app-shell host-fullscreen" data-theme={themeOf(props.campaign)}>
      <SceneStage 
        campaign={props.campaign} 
        setCampaign={props.setCampaign}
        busy={props.busy}
        setBusy={props.setBusy}
        setError={props.setError}
      />
      <button className="cog-button" onClick={() => setAdminOpen((open) => !open)} aria-label="Party controls">⚙</button>
      <ThreeDToggleButton className="host-corner-toggle" />
      {adminOpen && (
        <HostAdminPanel 
          {...props} 
        />
      )}
    </main>
  );
}

const THREE_D_KEY = "dnd_threejs_disabled";
const THREE_D_EVENT = "threejs-pref-changed";

function use3DEnabled(): [boolean, (enabled: boolean) => void] {
  const [disabled, setDisabled] = useState<boolean>(() =>
    typeof window !== "undefined" && localStorage.getItem(THREE_D_KEY) === "true"
  );
  useEffect(() => {
    const sync = () => setDisabled(localStorage.getItem(THREE_D_KEY) === "true");
    window.addEventListener(THREE_D_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(THREE_D_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const setEnabled = useCallback((enabled: boolean) => {
    localStorage.setItem(THREE_D_KEY, String(!enabled));
    window.dispatchEvent(new Event(THREE_D_EVENT));
  }, []);
  return [!disabled, setEnabled];
}

function ThreeDToggleButton({ className }: { className?: string }) {
  const [enabled, setEnabled] = use3DEnabled();
  return (
    <button
      type="button"
      className={`threejs-toggle-btn ${!enabled ? "disabled" : ""} ${className || ""}`}
      onClick={() => setEnabled(!enabled)}
      aria-pressed={!enabled}
    >
      <span>{enabled ? "⚡ Disable 3D" : "🔮 Enable 3D"}</span>
    </button>
  );
}

function CinematicFallbackBackdrop() {
  return (
    <div className="cinematic-fallback-backdrop" aria-hidden="true">
      <div className="cfb-ring" />
      <div className="cfb-embers">
        {Array.from({ length: 9 }).map((_, i) => (
          <span key={i} className={`cfb-ember e${i + 1}`} />
        ))}
      </div>
    </div>
  );
}

function SmoothBackground({ imageUrl }: { imageUrl?: string }) {
  const [currentUrl, setCurrentUrl] = useState(imageUrl);
  const [prevUrl, setPrevUrl] = useState<string | undefined>(undefined);
  const [isTransitioning, setIsTransitioning] = useState(false);

  useEffect(() => {
    if (imageUrl !== currentUrl) {
      setPrevUrl(currentUrl);
      setCurrentUrl(imageUrl);
      setIsTransitioning(true);

      const timer = setTimeout(() => {
        setIsTransitioning(false);
        setPrevUrl(undefined);
      }, 1500); // 1.5s smooth crossfade
      return () => clearTimeout(timer);
    }
  }, [imageUrl, currentUrl]);

  return (
    <div className="scene-background-container">
      {prevUrl && (
        <div 
          className="scene-image prev-scene-image" 
          style={{ backgroundImage: `url(${prevUrl})` }} 
        />
      )}
      {currentUrl && (
        <div 
          className="scene-image current-scene-image" 
          style={{ 
            backgroundImage: `url(${currentUrl})`, 
            opacity: isTransitioning && prevUrl ? 0 : 0.72,
            transition: isTransitioning ? 'none' : 'opacity 1.5s ease-in-out'
          }} 
          ref={(el) => {
            if (el && isTransitioning) {
              // trigger reflow to apply transition
              el.getBoundingClientRect();
              el.style.opacity = '0.72';
              el.style.transition = 'opacity 1.5s ease-in-out';
            }
          }}
        />
      )}
    </div>
  );
}

// ============================================================================================
// Three.js 3D Sacred Geometry Mandala Scene
// ============================================================================================

type HostLoadingMode = "lobby" | "initial" | "player-sync";

type HostLoadingPhase = {
  key: string;
  icon?: string;
  label: string;
  detail: string;
};

const INITIAL_CAMPAIGN_PHASES: HostLoadingPhase[] = [
  { key: "signal", icon: "◆", label: "DM Signal", detail: "Contacting the story engine" },
  { key: "world",  icon: "✦", label: "World State", detail: "Writing lore, stakes, and secrets" },
  { key: "scene",  icon: "◈", label: "Opening Scene", detail: "Composing the first playable beat" },
  { key: "image",  icon: "◐", label: "Scene Painter", detail: "Rendering a cinematic backdrop" },
  { key: "sheet",  icon: "✧", label: "Party Sheets", detail: "Attaching abilities and inventory" },
  { key: "live",   icon: "✹", label: "Go Live", detail: "Handing control to the table" },
];

const PLAYER_SYNC_PHASES: HostLoadingPhase[] = [
  { key: "signal",    icon: "◌", label: "Profile Intake", detail: "Reading the player signal" },
  { key: "sheet",     icon: "◇", label: "Sheet Forge", detail: "Building stats, gear, and hooks" },
  { key: "image",     icon: "◉", label: "Portrait Gate", detail: "Rendering a character anchor" },
  { key: "integrate", icon: "◎", label: "Timeline Merge", detail: "Splicing into the live campaign" },
  { key: "live",      icon: "✹", label: "Live", detail: "Handing back to the table" },
];

const LOADING_STEPS_CHARACTER = [
  { icon: "📋", label: "Reviewing" },
  { icon: "🎭", label: "Forging Sheet" },
  { icon: "🖼️", label: "Painting Portrait" },
  { icon: "✨", label: "Integrating" },
];

function getStepIndex(status: string, steps: { label: string }[]): number {
  const s = status.toLowerCase();
  
  if (s.includes("portrait") || s.includes("painting a character") || s.includes("painting a portrait") || s.includes("painting a cinematic scene")) {
    return 2; // Painting Portrait
  }
  if (s.includes("sheet") || s.includes("scrolls") || s.includes("notes") || s.includes("inventory") || s.includes("abilities") || s.includes("forge")) {
    return 1; // Forging Sheet
  }
  if (s.includes("splicing") || s.includes("timeline merge") || s.includes("live") || (s.includes("integrate") && !s.includes("profile"))) {
    return 3; // Integrating
  }
  if (s.includes("reviewing") || s.includes("reading") || s.includes("intake") || s.includes("generating") || s.includes("preparing") || s.includes("integrating new player profile")) {
    return 0; // Reviewing
  }
  return 0;
}

function getHostLoadingMode(campaign: Campaign): HostLoadingMode {
  if (campaign.status === "lobby") return "lobby";

  const phase = campaign.dmPhase;
  const status = (campaign.dmStatus || "").toLowerCase();
  const hasStoryStarted = campaign.displayEvents.some((e) => e.type === "narration" || e.type === "dialogue");
  const playerGenerating = campaign.players.some((p) => (p.status || "").toLowerCase().includes("generating profile"));
  const isPlayerSync =
    phase === "integrate" ||
    playerGenerating ||
    status.includes("integrating") ||
    status.includes("reintegrating") ||
    status.includes("rejoin") ||
    status.includes("reconnect") ||
    status.includes("character sheet") ||
    status.includes("player profile");

  if (isPlayerSync && hasStoryStarted) return "player-sync";
  return "initial";
}

function getHostPhases(mode: HostLoadingMode): HostLoadingPhase[] {
  if (mode === "player-sync") return PLAYER_SYNC_PHASES;
  return INITIAL_CAMPAIGN_PHASES;
}

function getHostPhaseIndex(mode: HostLoadingMode, status: string, dmPhase?: string): number {
  if (mode === "lobby") return 0;
  const phases = getHostPhases(mode);

  // Authoritative path: server explicitly set the phase, just match by key.
  if (dmPhase) {
    const idx = phases.findIndex((p) => p.key === dmPhase);
    if (idx >= 0) return idx;
  }

  // Fallback: infer from status text (older code paths / legacy).
  const s = status.toLowerCase();
  const keyToIndex = (key: string) => Math.max(0, phases.findIndex((p) => p.key === key));

  if (s.includes("preparing") || s.includes("contacting") || s.includes("scheming")) return keyToIndex("signal");
  if (s.includes("finalizing") || s.includes("starting") || s.includes("launching") || s.includes("awakening") || s.includes("go live")) return keyToIndex("live");
  if (s.includes("portrait") || s.includes("painting a character")) return keyToIndex("image");
  if (s.includes("cinematic") || s.includes("painting") || s.includes("scene image") || s.includes("background") || s.includes("visual")) return keyToIndex(mode === "player-sync" ? "image" : "image");
  if (s.includes("integrating") || s.includes("reintegrating") || s.includes("merge") || s.includes("rejoin") || s.includes("reconnect")) return keyToIndex("integrate");
  if (s.includes("sheet") || s.includes("stats") || s.includes("inventory") || s.includes("abilities") || s.includes("notes") || s.includes("scrolls") || s.includes("character")) return keyToIndex("sheet");
  if (s.includes("lore") || s.includes("world") || s.includes("npc") || s.includes("quest")) return keyToIndex("world");
  if (s.includes("opening scene") || s.includes("scenario") || s.includes("first")) return keyToIndex("scene");
  return 0;
}

/**
 * Smooths a discrete progress target (updated by the 2-6s campaign poll) into
 * a continuously animating value: eases up to the target on jumps, then creeps
 * toward `cap` while waiting for the next poll. Never regresses.
 */
function useSmoothedProgress(target: number, cap: number = target): number {
  const [value, setValue] = useState(target);
  const ref = useRef({ v: target, target, cap });
  ref.current.target = target;
  ref.current.cap = Math.max(target, cap);
  useEffect(() => {
    if (typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      ref.current.v = target;
      setValue(target);
      return;
    }
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const s = ref.current;
      let v = s.v;
      if (v < s.target) v = Math.min(s.target, v + Math.max((s.target - v) * 1.6, 0.04) * dt);
      else if (v < s.cap) v = Math.min(s.cap, v + 0.015 * dt);
      if (Math.abs(v - s.v) > 0.0004) {
        s.v = v;
        setValue(v);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return value;
}

function StatusTimeline({ status, mode = "campaign" }: { status: string; mode?: "campaign" | "character" }) {
  const steps = mode === "campaign" ? INITIAL_CAMPAIGN_PHASES : LOADING_STEPS_CHARACTER;
  const currentStep = getStepIndex(status, steps);

  return (
    <div className="status-timeline">
      {steps.map((step, i) => (
        <div key={i} className={`timeline-step ${i < currentStep ? "completed" : i === currentStep ? "active" : "pending"}`}>
          {i > 0 && (
            <div className={`timeline-connector ${i <= currentStep ? "filled" : ""}`} />
          )}
          <div className="timeline-node">
            <span className="timeline-icon">{step.icon}</span>
            {i === currentStep && <div className="timeline-pulse" />}
          </div>
          <span className="timeline-label">{step.label}</span>
        </div>
      ))}
    </div>
  );
}

const TIPS_ALL = [
  "Advantage lets you roll twice and take the higher value, while disadvantage takes the lower.",
  "Be creative! The AI Dungeon Master adapts dynamically to freeform actions you write.",
  "Coordinate with your party to handle battles, negotiate, and explore secret areas.",
  "The Dungeon Master keeps private markdown records of your progress and inventory.",
  "Your background and character name help shape the story and dialogue.",
  "You can inspect your character sheet anytime during gameplay from the menu.",
  "Try examining objects in the scene — hidden clues might be anywhere!",
  "Natural 20 rolls are automatic critical successes with spectacular outcomes.",
  "Natural 1 rolls are critical failures — expect something hilariously catastrophic.",
  "The DM adapts the difficulty based on your party's performance and decisions.",
  "You can use items from your inventory by describing how you use them.",
  "Side quests and hidden paths are woven into every story — explore thoroughly!",
  "Your party leader can start the campaign when everyone is ready in the lobby.",
  "Each character gets a unique AI-generated portrait based on their backstory.",
  "The AI remembers your past actions and references them in future encounters.",
  "Teamwork bonuses apply when multiple players coordinate their actions together.",
  "Charisma checks can sometimes resolve combat encounters peacefully.",
  "The world reacts to your reputation — villains and allies remember your deeds.",
  "Healing potions restore health but cost an action — use them wisely in battle.",
  "Short rests restore some abilities, while long rests restore everything.",
  "Bardic inspiration can turn a failed roll into a success — music is powerful!",
  "Flanking enemies with allies grants advantage on your attack rolls.",
  "The environment is interactive — push boulders, ignite oil, collapse tunnels!",
  "Every NPC has their own motivations and secrets. Some may betray you.",
];

const TIPS_TABLETOP = [
  "Be creative! The AI Storyteller adapts dynamically to freeform actions you write.",
  "Your background and character name help shape the story and dialogue.",
  "The Storyteller keeps private markdown records of your progress and inventory.",
  "Try examining objects in the scene — hidden clues might be anywhere!",
  "You can use items from your inventory by describing how you use them.",
  "Side quests and hidden paths are woven into every story — explore thoroughly!",
  "Each character gets a unique AI-generated portrait based on their backstory.",
  "The AI remembers your past actions and references them in future scenes.",
  "Every NPC has their own motivations and secrets. Some may betray you.",
  "The world reacts to your reputation — rivals and allies remember your deeds.",
  "Talking your way out of trouble is always an option — persuasion is powerful.",
  "The story bends to your genre: heists, romances, mysteries, and epics all work.",
  "Coordinate with your party — plans hatched together get better outcomes.",
  "Ask questions in-character; the Storyteller loves curious protagonists.",
  "Bold, specific actions make for better scenes than cautious vague ones.",
];

function CyclingTipBox({ variant = "dnd" }: { variant?: CampaignTypeChoice }) {
  const tips = variant === "tabletop" ? TIPS_TABLETOP : TIPS_ALL;
  const [tipIndex, setTipIndex] = useState(() => Math.floor(Math.random() * tips.length));
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      setVisible(false);
      setTimeout(() => {
        setTipIndex((prev) => (prev + 1) % tips.length);
        setVisible(true);
      }, 600);
    }, 8000);
    return () => clearInterval(interval);
  }, [tips.length]);

  return (
    <div className="cycling-tip-box">
      <strong>DID YOU KNOW?</strong>
      <p className={`cycling-tip-text ${visible ? "tip-visible" : "tip-hidden"}`}>
        {tips[tipIndex % tips.length]}
      </p>
    </div>
  );
}

type PortalPlayer = { id: string; color?: string };

function CinematicPortalScene({
  isActive,
  mode,
  stepProgress,
  phaseKey,
  players,
  localPlayerId,
}: {
  isActive: boolean;
  mode: HostLoadingMode;
  stepProgress: number;
  phaseKey: string;
  players: PortalPlayer[];
  localPlayerId?: string;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{
    dispose: () => void;
    setActive: (v: boolean) => void;
    setMode: (v: HostLoadingMode) => void;
    setStepProgress: (v: number) => void;
    setPhaseKey: (v: string) => void;
    setPlayers: (v: PortalPlayer[]) => void;
    setLocalPlayerId: (v?: string) => void;
  } | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let disposed = false;

    import("three").then((THREE) => {
      if (disposed) return;

      // ===================== SCENE =====================
      const scene = new THREE.Scene();
      scene.fog = new THREE.FogExp2(0x030108, 0.025);

      const camera = new THREE.PerspectiveCamera(50, mount.clientWidth / mount.clientHeight, 0.1, 200);
      camera.position.set(0, 6, 14);
      camera.lookAt(0, 1, 0);

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      renderer.setSize(mount.clientWidth, mount.clientHeight);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setClearColor(0x020106, 1);
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.3;
      mount.appendChild(renderer.domElement);

      // ===================== MUTABLE STATE =====================
      let activeState = isActive;
      let modeState: HostLoadingMode = mode;
      let stepProgressState = stepProgress;
      let phaseKeyState = phaseKey;
      let phaseBlend = mode === "lobby" ? 0 : 1;
      let stepSmooth = stepProgress;
      let speedCurrent = mode === "lobby" ? 0.45 : 1.0 + stepProgress * 2.5;
      let localPlayerIdState = localPlayerId;
      const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

      const hexFromColor = (c?: string): number => {
        if (!c) return 0xffd700;
        const m = c.trim().replace("#", "");
        const v = parseInt(m.length === 3 ? m.split("").map((x) => x + x).join("") : m, 16);
        return Number.isFinite(v) ? v : 0xffd700;
      };

      // ===================== ARCANE GROUND CIRCLE TEXTURE =====================
      const circCanvas = document.createElement("canvas");
      circCanvas.width = 1024;
      circCanvas.height = 1024;
      const cctx = circCanvas.getContext("2d")!;
      const ccx = 512, ccy = 512;
      cctx.clearRect(0, 0, 1024, 1024);

      // Ambient radial glow
      const grd = cctx.createRadialGradient(ccx, ccy, 0, ccx, ccy, 500);
      grd.addColorStop(0, "rgba(217,164,65,0.2)");
      grd.addColorStop(0.5, "rgba(217,164,65,0.06)");
      grd.addColorStop(1, "rgba(0,0,0,0)");
      cctx.fillStyle = grd;
      cctx.fillRect(0, 0, 1024, 1024);

      // Concentric ritual rings
      [0.08, 0.16, 0.24, 0.32, 0.40, 0.47].forEach((r, i) => {
        cctx.beginPath();
        cctx.arc(ccx, ccy, r * 1024, 0, Math.PI * 2);
        cctx.strokeStyle = `rgba(217,164,65,${0.42 - i * 0.05})`;
        cctx.lineWidth = (i === 0 || i === 5) ? 2.5 : 1.2;
        cctx.stroke();
      });

      // Compass radial lines
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        cctx.beginPath();
        cctx.moveTo(ccx + Math.cos(a) * 60, ccy + Math.sin(a) * 60);
        cctx.lineTo(ccx + Math.cos(a) * 480, ccy + Math.sin(a) * 480);
        cctx.strokeStyle = `rgba(217,164,65,${i % 4 === 0 ? 0.24 : 0.08})`;
        cctx.lineWidth = i % 4 === 0 ? 1.8 : 0.7;
        cctx.stroke();
      }

      // Hexagram star
      for (let i = 0; i < 6; i++) {
        const a1 = (i / 6) * Math.PI * 2 - Math.PI / 2;
        const a2 = ((i + 2) / 6) * Math.PI * 2 - Math.PI / 2;
        cctx.beginPath();
        cctx.moveTo(ccx + Math.cos(a1) * 320, ccy + Math.sin(a1) * 320);
        cctx.lineTo(ccx + Math.cos(a2) * 320, ccy + Math.sin(a2) * 320);
        cctx.strokeStyle = "rgba(255,215,0,0.14)";
        cctx.lineWidth = 1;
        cctx.stroke();
      }

      // Rune marker dots along 4th ring
      for (let i = 0; i < 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        const radius = 0.40 * 1024;
        cctx.beginPath();
        cctx.arc(ccx + Math.cos(a) * radius, ccy + Math.sin(a) * radius, i % 6 === 0 ? 4.5 : 2, 0, Math.PI * 2);
        cctx.fillStyle = `rgba(255,215,0,${i % 6 === 0 ? 0.6 : 0.22})`;
        cctx.fill();
      }

      // Inner ring tick marks
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        cctx.beginPath();
        cctx.moveTo(ccx + Math.cos(a) * 0.15 * 1024, ccy + Math.sin(a) * 0.15 * 1024);
        cctx.lineTo(ccx + Math.cos(a) * 0.17 * 1024, ccy + Math.sin(a) * 0.17 * 1024);
        cctx.strokeStyle = "rgba(255,215,0,0.35)";
        cctx.lineWidth = 1.5;
        cctx.stroke();
      }

      const circTexture = new THREE.CanvasTexture(circCanvas);

      const groundGeo = new THREE.PlaneGeometry(28, 28);
      const groundMat = new THREE.MeshBasicMaterial({
        map: circTexture,
        transparent: true,
        opacity: 0.6,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const ground = new THREE.Mesh(groundGeo, groundMat);
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = -0.02;
      scene.add(ground);

      // ===================== PORTAL TORUS RINGS =====================
      const portalRingsGroup = new THREE.Group();
      const ringCfg = [
        { r: 2.2, tube: 0.03, color: 0xd9a441, op: 0.55, tX: 0, tZ: 0 },
        { r: 2.8, tube: 0.024, color: 0xffd700, op: 0.38, tX: 0.38, tZ: 0.28 },
        { r: 3.4, tube: 0.02, color: 0xffe4a0, op: 0.26, tX: -0.25, tZ: -0.18 },
        { r: 4.0, tube: 0.016, color: 0xfff5dc, op: 0.16, tX: 0.78, tZ: 0.12 },
      ];
      const portalRings: InstanceType<typeof THREE.Mesh>[] = [];
      const portalRingMats: InstanceType<typeof THREE.MeshBasicMaterial>[] = [];
      ringCfg.forEach((cfg) => {
        const geo = new THREE.TorusGeometry(cfg.r, cfg.tube, 16, 128);
        const mat = new THREE.MeshBasicMaterial({
          color: cfg.color,
          transparent: true,
          opacity: cfg.op,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.rotation.x = Math.PI / 2 + cfg.tX;
        mesh.rotation.z = cfg.tZ;
        mesh.position.y = 1.5;
        portalRings.push(mesh);
        portalRingMats.push(mat);
        portalRingsGroup.add(mesh);
      });
      scene.add(portalRingsGroup);

      // ===================== ENERGY CORE =====================
      const coreGeo = new THREE.IcosahedronGeometry(0.9, 2);
      const coreMat = new THREE.MeshBasicMaterial({
        color: 0xffd700,
        transparent: true,
        opacity: 0.22,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const core = new THREE.Mesh(coreGeo, coreMat);
      core.position.y = 1.5;
      scene.add(core);

      // Inner glow sphere
      const igGeo = new THREE.SphereGeometry(1.6, 24, 24);
      const igMat = new THREE.MeshBasicMaterial({
        color: 0xd9a441,
        transparent: true,
        opacity: 0.06,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.BackSide,
      });
      const innerGlow = new THREE.Mesh(igGeo, igMat);
      innerGlow.position.y = 1.5;
      scene.add(innerGlow);

      // Outer energy shell
      const shellGeo = new THREE.SphereGeometry(2.5, 16, 16);
      const shellMat = new THREE.MeshBasicMaterial({
        color: 0xfff5dc,
        transparent: true,
        opacity: 0.025,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.BackSide,
      });
      const shell = new THREE.Mesh(shellGeo, shellMat);
      shell.position.y = 1.5;
      scene.add(shell);

      // ===================== CENTRAL D20 =====================
      const d20Geo = new THREE.IcosahedronGeometry(0.6, 0);
      const d20SolidMat = new THREE.MeshBasicMaterial({
        color: 0x080412,
        transparent: true,
        opacity: 0.75,
      });
      const d20WireMat = new THREE.MeshBasicMaterial({
        color: 0xffd700,
        wireframe: true,
        transparent: true,
        opacity: 0.85,
      });
      const d20Solid = new THREE.Mesh(d20Geo, d20SolidMat);
      const d20Wire = new THREE.Mesh(d20Geo.clone(), d20WireMat);
      const d20Group = new THREE.Group();
      d20Group.add(d20Solid);
      d20Group.add(d20Wire);
      scene.add(d20Group);

      // ===================== YOUR D20 (CONTROLLER ONLY) =====================
      const yourD20Geo = new THREE.IcosahedronGeometry(0.35, 0);
      const yourD20SolidMat = new THREE.MeshBasicMaterial({
        color: 0x080412,
        transparent: true,
        opacity: 0.75,
      });
      const yourD20WireMat = new THREE.MeshBasicMaterial({
        color: 0xffd700,
        wireframe: true,
        transparent: true,
        opacity: 0.85,
      });
      const yourD20Solid = new THREE.Mesh(yourD20Geo, yourD20SolidMat);
      const yourD20Wire = new THREE.Mesh(yourD20Geo.clone(), yourD20WireMat);
      const yourD20Group = new THREE.Group();
      yourD20Group.add(yourD20Solid);
      yourD20Group.add(yourD20Wire);
      yourD20Group.position.set(0, 0.5, 4.0);
      scene.add(yourD20Group);

      // ===================== TRANSMISSION BEAM (CONTROLLER ONLY) =====================
      const beamLineGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0.5, 4.0),
        new THREE.Vector3(0, 1.5, -2.0)
      ]);
      const beamLineMat = new THREE.LineBasicMaterial({
        color: 0xffd700,
        transparent: true,
        opacity: 0.4,
        blending: THREE.AdditiveBlending,
      });
      const transmissionBeam = new THREE.Line(beamLineGeo, beamLineMat);
      scene.add(transmissionBeam);

      // ===================== MINI D20 DICE =====================
      const miniD20Group = new THREE.Group();
      const miniD20Count = 12;
      const miniD20s: Array<{
        mesh: InstanceType<typeof THREE.Mesh>;
        baseAngle: number;
        radiusOffset: number;
        speedMultiplier: number;
        verticalOffset: number;
      }> = [];

      const miniD20Geo = new THREE.IcosahedronGeometry(0.08, 0);
      for (let i = 0; i < miniD20Count; i++) {
        const miniD20Mat = new THREE.MeshBasicMaterial({
          color: 0xffd700,
          wireframe: true,
          transparent: true,
          opacity: 0.8,
          blending: THREE.AdditiveBlending,
        });
        const mesh = new THREE.Mesh(miniD20Geo, miniD20Mat);
        miniD20Group.add(mesh);
        miniD20s.push({
          mesh,
          baseAngle: (i / miniD20Count) * Math.PI * 2,
          radiusOffset: Math.random() * 2 - 1,
          speedMultiplier: 0.8 + Math.random() * 0.4,
          verticalOffset: Math.random() * 2 - 1,
        });
      }
      scene.add(miniD20Group);

      // ===================== LIGHTING =====================
      const coreLight = new THREE.PointLight(0xd9a441, 4, 25);
      coreLight.position.set(0, 1.5, 0);
      scene.add(coreLight);

      const ambientLight = new THREE.AmbientLight(0x0f0520, 0.3);
      scene.add(ambientLight);

      const accentLight1 = new THREE.PointLight(0x5522aa, 1.2, 18);
      accentLight1.position.set(-6, 0.5, -6);
      scene.add(accentLight1);

      const accentLight2 = new THREE.PointLight(0x2244aa, 0.8, 18);
      accentLight2.position.set(6, 0.3, 6);
      scene.add(accentLight2);

      // ===================== GOD RAYS (Light Beams) =====================
      const beamMeshes: InstanceType<typeof THREE.Mesh>[] = [];
      for (let i = 0; i < 6; i++) {
        const bGeo = new THREE.PlaneGeometry(0.14, 16);
        const bMat = new THREE.MeshBasicMaterial({
          color: 0xd9a441,
          transparent: true,
          opacity: 0.03,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        const beam = new THREE.Mesh(bGeo, bMat);
        beam.position.set(0, 8, 0);
        beam.rotation.y = (i / 6) * Math.PI;
        beamMeshes.push(beam);
        scene.add(beam);
      }

      // ===================== OUTER RUNE RING =====================
      const runeGeo = new THREE.TorusGeometry(6, 0.035, 4, 128);
      const runeMat = new THREE.MeshBasicMaterial({
        color: 0xd9a441,
        transparent: true,
        opacity: 0.12,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const runeRing = new THREE.Mesh(runeGeo, runeMat);
      runeRing.rotation.x = Math.PI / 2;
      runeRing.position.y = 0.04;
      scene.add(runeRing);

      // Tilted dash ring
      const dashGeo = new THREE.TorusGeometry(3.8, 0.015, 4, 64);
      const dashMat = new THREE.MeshBasicMaterial({
        color: 0xfff5dc,
        transparent: true,
        opacity: 0.06,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const dashRing = new THREE.Mesh(dashGeo, dashMat);
      dashRing.rotation.x = Math.PI / 3.5;
      dashRing.position.y = 1.5;
      scene.add(dashRing);

      // ===================== PARTICLE TEXTURE =====================
      const ptCanvas = document.createElement("canvas");
      ptCanvas.width = 64;
      ptCanvas.height = 64;
      const ptCtx = ptCanvas.getContext("2d")!;
      const ptGrd = ptCtx.createRadialGradient(32, 32, 0, 32, 32, 32);
      ptGrd.addColorStop(0, "rgba(255,245,220,1)");
      ptGrd.addColorStop(0.15, "rgba(255,215,0,0.85)");
      ptGrd.addColorStop(0.45, "rgba(217,164,65,0.3)");
      ptGrd.addColorStop(1, "rgba(217,164,65,0)");
      ptCtx.fillStyle = ptGrd;
      ptCtx.fillRect(0, 0, 64, 64);
      const pTex = new THREE.CanvasTexture(ptCanvas);

      // ===================== PARTICLE SYSTEM 1: AMBIENT DUST =====================
      const dustN = 220;
      const dustPos = new Float32Array(dustN * 3);
      const dustVel = new Float32Array(dustN * 3);
      for (let i = 0; i < dustN; i++) {
        dustPos[i * 3]     = (Math.random() - 0.5) * 38;
        dustPos[i * 3 + 1] = Math.random() * 16;
        dustPos[i * 3 + 2] = (Math.random() - 0.5) * 38;
        dustVel[i * 3]     = (Math.random() - 0.5) * 0.015;
        dustVel[i * 3 + 1] = 0.002 + Math.random() * 0.008;
        dustVel[i * 3 + 2] = (Math.random() - 0.5) * 0.015;
      }
      const dustGeo = new THREE.BufferGeometry();
      dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
      const dustMat = new THREE.PointsMaterial({
        size: 0.07,
        map: pTex,
        transparent: true,
        opacity: 0.3,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      });
      scene.add(new THREE.Points(dustGeo, dustMat));

      // ===================== PARTICLE SYSTEM 2: PORTAL SPARKS (spiral inward) =====================
      const spkN = 500;
      const spkAng = new Float32Array(spkN);
      const spkRad = new Float32Array(spkN);
      const spkH   = new Float32Array(spkN);
      const spkSpd = new Float32Array(spkN);
      const spkPos = new Float32Array(spkN * 3);
      for (let i = 0; i < spkN; i++) {
        spkAng[i] = Math.random() * Math.PI * 2;
        spkRad[i] = 1.2 + Math.random() * 7;
        spkH[i]   = Math.random() * 5;
        spkSpd[i] = 0.25 + Math.random() * 0.65;
      }
      const spkGeo = new THREE.BufferGeometry();
      spkGeo.setAttribute("position", new THREE.BufferAttribute(spkPos, 3));
      const spkMat = new THREE.PointsMaterial({
        size: 0.045,
        map: pTex,
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      });
      scene.add(new THREE.Points(spkGeo, spkMat));

      // ===================== PARTICLE SYSTEM 3: RISING EMBERS =====================
      const embN = 180;
      const embPos = new Float32Array(embN * 3);
      const embSpd = new Float32Array(embN);
      for (let i = 0; i < embN; i++) {
        const ea = Math.random() * Math.PI * 2;
        const er = Math.random() * 3.5;
        embPos[i * 3]     = Math.cos(ea) * er;
        embPos[i * 3 + 1] = Math.random() * 12;
        embPos[i * 3 + 2] = Math.sin(ea) * er;
        embSpd[i] = 0.4 + Math.random() * 0.8;
      }
      const embGeo = new THREE.BufferGeometry();
      embGeo.setAttribute("position", new THREE.BufferAttribute(embPos, 3));
      const embMat = new THREE.PointsMaterial({
        size: 0.035,
        map: pTex,
        transparent: true,
        opacity: 0.7,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      });
      scene.add(new THREE.Points(embGeo, embMat));

      // ===================== SOUL ORBS (PLAYERS) =====================
      type SoulOrb = {
        id: string;
        group: InstanceType<typeof THREE.Group>;
        sphere: InstanceType<typeof THREE.Mesh>;
        halo: InstanceType<typeof THREE.Mesh>;
        light: InstanceType<typeof THREE.PointLight>;
        trail: InstanceType<typeof THREE.Mesh>; // Small trail indicator
        baseAngle: number;
        born: number;
        color: number;
        beam?: InstanceType<typeof THREE.Line>;
      };
      let orbs: SoulOrb[] = [];
      const orbRadius = 4.5;
      let orbClock = 0;

      const makeOrb = (p: PortalPlayer, born: number): SoulOrb => {
        const color = hexFromColor(p.color);
        const group = new THREE.Group();

        // Core sphere
        const sGeo = new THREE.SphereGeometry(0.2, 16, 16);
        const sMat = new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: 0,
          blending: THREE.AdditiveBlending, depthWrite: false,
        });
        const sphere = new THREE.Mesh(sGeo, sMat);
        group.add(sphere);

        // Halo glow
        const hGeo = new THREE.SphereGeometry(0.55, 12, 12);
        const hMat = new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: 0,
          blending: THREE.AdditiveBlending, depthWrite: false,
        });
        const halo = new THREE.Mesh(hGeo, hMat);
        group.add(halo);

        // Inner bright core
        const tGeo = new THREE.SphereGeometry(0.08, 8, 8);
        const tMat = new THREE.MeshBasicMaterial({
          color: 0xffffff, transparent: true, opacity: 0,
          blending: THREE.AdditiveBlending, depthWrite: false,
        });
        const trail = new THREE.Mesh(tGeo, tMat);
        group.add(trail);

        const light = new THREE.PointLight(color, 0, 8);
        group.add(light);
        scene.add(group);

        let beam: InstanceType<typeof THREE.Line> | undefined;
        if (localPlayerIdState && p.id === localPlayerIdState) {
          const lineGeo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(0, 0, 0)
          ]);
          const lineMat = new THREE.LineBasicMaterial({
            color,
            transparent: true,
            opacity: 0.8,
            blending: THREE.AdditiveBlending
          });
          beam = new THREE.Line(lineGeo, lineMat);
          scene.add(beam);
        }

        return { id: p.id, group, sphere, halo, trail, light, baseAngle: 0, born, color, beam };
      };

      const reconcileOrbs = (next: PortalPlayer[]) => {
        const ids = new Set(next.map((p) => p.id));
        orbs = orbs.filter((o) => {
          if (!ids.has(o.id)) {
            scene.remove(o.group);
            if (o.beam) {
              scene.remove(o.beam);
              o.beam.geometry.dispose();
              (o.beam.material as InstanceType<typeof THREE.Material>).dispose();
            }
            o.sphere.geometry.dispose();
            (o.sphere.material as InstanceType<typeof THREE.Material>).dispose();
            o.halo.geometry.dispose();
            (o.halo.material as InstanceType<typeof THREE.Material>).dispose();
            o.trail.geometry.dispose();
            (o.trail.material as InstanceType<typeof THREE.Material>).dispose();
            return false;
          }
          return true;
        });
        const existing = new Set(orbs.map((o) => o.id));
        next.forEach((p) => {
          if (!existing.has(p.id)) orbs.push(makeOrb(p, orbClock));
        });
        orbs.forEach((o, i) => {
          o.baseAngle = (i / Math.max(1, orbs.length)) * Math.PI * 2;
        });
      };

      reconcileOrbs(players);

      // ===================== ANIMATION LOOP =====================
      const clock = new THREE.Clock();
      let animId: number;
      let lastFrame = 0;
      let camAngle = 0;

      const animate = () => {
        animId = requestAnimationFrame(animate);
        const t = clock.getElapsedTime();
        const dt = Math.min(0.05, t - lastFrame);
        lastFrame = t;
        orbClock = t;

        // Smooth blend between lobby and active states
        const target = modeState === "lobby" ? 0 : 1;
        phaseBlend += (target - phaseBlend) * Math.min(1, dt * 1.6);
        const sync = modeState === "player-sync" ? 1 : 0;
        // Lobby is slow and serene; loading charges up. Ease between the two
        // (~2s) instead of jumping so mode changes read as a ramp, not a cut.
        stepSmooth += (stepProgressState - stepSmooth) * Math.min(1, dt * 1.2);
        const speedTarget = modeState === "lobby" ? 0.45 : 1.0 + stepSmooth * 2.5;
        speedCurrent += (speedTarget - speedCurrent) * Math.min(1, dt * 0.9);
        if (reducedMotion) {
          phaseBlend = target;
          stepSmooth = stepProgressState;
          speedCurrent = speedTarget * 0.5;
        }
        const speed = speedCurrent + (reducedMotion ? 0 : Math.sin(t * 8) * 0.15 * phaseBlend);

        // Phase-specific intensity multipliers
        const pSignal = phaseKeyState === "signal" ? 1 : 0;
        const pWorld  = phaseKeyState === "world" ? 1 : 0;
        const pScene  = phaseKeyState === "scene" ? 1 : 0;
        const pImage  = phaseKeyState === "image" ? 1 : 0;
        const pSheet  = phaseKeyState === "sheet" ? 1 : 0;
        const pInteg  = phaseKeyState === "integrate" ? 1 : 0;
        const pLive   = phaseKeyState === "live" ? 1 : 0;

        // ---- Portal Rings ----
        portalRings.forEach((ring, i) => {
          const dir = i % 2 === 0 ? 1 : -1;
          const rs = speed * (0.12 + i * 0.06 + pScene * 0.35 + pLive * 0.7);
          ring.rotation.z += dir * rs * dt;
          ring.rotation.x += dir * rs * 0.25 * dt;
          const sc = 1 + pWorld * 0.14 + pLive * 0.28 + stepProgressState * 0.1;
          ring.scale.setScalar(sc);
          portalRingMats[i].opacity = ringCfg[i].op
            + Math.sin(t * (1.2 + i * 0.35)) * 0.07
            + phaseBlend * 0.1
            + pImage * 0.14
            + pLive * 0.18;
        });

        // ---- Energy Core ----
        core.rotation.x = t * 0.4 * speed;
        core.rotation.y = t * 0.6 * speed;
        const coreScale = 0.7 + phaseBlend * 0.35 + stepProgressState * 0.5
          + pImage * 0.3 + pLive * 0.55
          + Math.sin(t * (1.8 + pSignal * 4)) * 0.12;
        core.scale.setScalar(coreScale);
        coreMat.opacity = 0.12 + phaseBlend * 0.18 + pImage * 0.2 + pLive * 0.28;

        innerGlow.scale.setScalar(1 + Math.sin(t * 1.3) * 0.15 + phaseBlend * 0.28 + pImage * 0.4);
        igMat.opacity = 0.04 + phaseBlend * 0.08 + pImage * 0.14 + pLive * 0.2;

        shell.scale.setScalar(1 + Math.sin(t * 0.7) * 0.06 + pWorld * 0.22 + pLive * 0.4);
        shellMat.opacity = 0.015 + phaseBlend * 0.03 + pImage * 0.07 + pLive * 0.12;

        const isController = !!localPlayerIdState;

        // ---- D20 ----
        const d20Spd = speed * (0.4 + phaseBlend * 0.7 + pSheet * 0.4);
        const chargeShake = stepProgressState > 0 ? Math.sin(t * 30) * 0.04 * stepProgressState : 0;
        
        if (isController) {
          d20Group.position.set(0, 1.5, -2.0);
          
          const localPlayerInfo = players.find(p => p.id === localPlayerIdState);
          const localColor = hexFromColor(localPlayerInfo?.color);
          yourD20WireMat.color.setHex(localColor);
          beamLineMat.color.setHex(localColor);
          
          yourD20Group.position.set(0, 0.5, 4.0);
          yourD20Group.visible = true;
          transmissionBeam.visible = true;
          
          yourD20Group.rotation.x = -t * 0.3;
          yourD20Group.rotation.y = -t * 0.55;
          yourD20Group.rotation.z = -t * 0.18;
          yourD20Group.scale.setScalar(0.7);

          ground.visible = false;
          portalRingsGroup.visible = false;
          runeRing.visible = false;
          dashRing.visible = false;
          
          orbs.forEach(o => {
            o.group.visible = false;
            if (o.beam) o.beam.visible = false;
          });
        } else {
          d20Group.position.set(0, 1.5, 0);
          yourD20Group.visible = false;
          transmissionBeam.visible = false;
          
          ground.visible = true;
          portalRingsGroup.visible = true;
          runeRing.visible = true;
          dashRing.visible = true;
          
          orbs.forEach(o => {
            o.group.visible = true;
            if (o.beam) o.beam.visible = true;
          });
        }

        d20Group.rotation.x = t * 0.25 * d20Spd;
        d20Group.rotation.y = t * 0.4  * d20Spd;
        d20Group.rotation.z = t * 0.12 * d20Spd;
        d20Group.scale.setScalar((isController ? 1.0 : 0.85) + phaseBlend * 0.18 + stepProgressState * 0.22 + pLive * 0.18 + chargeShake);
        d20WireMat.opacity = 0.55 + phaseBlend * 0.3 + pSheet * 0.15;

        // ---- Mini D20s ----
        if (isController) {
          const speedFactor = modeState === "lobby" ? 0.22 : 0.65;
          miniD20s.forEach((die, i) => {
            const progress = ((t * speedFactor + (i / miniD20Count)) % 1.0);
            const startPos = yourD20Group.position;
            const endPos = d20Group.position;
            
            const basePos = new THREE.Vector3().lerpVectors(startPos, endPos, progress);
            
            const direction = new THREE.Vector3().subVectors(endPos, startPos).normalize();
            const upVec = new THREE.Vector3(0, 1, 0);
            const rightVec = new THREE.Vector3().crossVectors(direction, upVec).normalize();
            const orthoUpVec = new THREE.Vector3().crossVectors(rightVec, direction).normalize();
            
            const spiralAngle = progress * Math.PI * 6 + die.baseAngle;
            const spiralRadius = 0.35 * Math.sin(progress * Math.PI);
            
            const offset = new THREE.Vector3()
              .addScaledVector(rightVec, Math.cos(spiralAngle) * spiralRadius)
              .addScaledVector(orthoUpVec, Math.sin(spiralAngle) * spiralRadius);
              
            die.mesh.position.copy(basePos).add(offset);
            
            die.mesh.rotation.x = t * 3.5 * die.speedMultiplier;
            die.mesh.rotation.y = t * 4.5 * die.speedMultiplier;
            
            const dieMat = die.mesh.material as InstanceType<typeof THREE.MeshBasicMaterial>;
            const localPlayerInfo = players.find(p => p.id === localPlayerIdState);
            const localColor = hexFromColor(localPlayerInfo?.color);
            dieMat.color.setHex(localColor);
            
            dieMat.opacity = Math.sin(progress * Math.PI) * 0.85;
          });
        } else {
          miniD20s.forEach((die, i) => {
            const progress = stepProgressState;
            const startRadius = 8 + die.radiusOffset;
            const endRadius = 0.65;
            const curRadius = startRadius * (1 - progress) + endRadius * progress;
            const orbitSpeed = (2.4 + progress * 5.8) * die.speedMultiplier;
            const angle = die.baseAngle + t * orbitSpeed;
            const curY = 1.5 + die.verticalOffset * (1 - progress) + Math.sin(t * 4 + i) * 0.12 * (1 - progress);
            
            die.mesh.position.set(
              Math.cos(angle) * curRadius,
              curY,
              Math.sin(angle) * curRadius
            );
            
            die.mesh.rotation.x = t * 2 * die.speedMultiplier;
            die.mesh.rotation.y = t * 3 * die.speedMultiplier;
            
            const dieMat = die.mesh.material as InstanceType<typeof THREE.MeshBasicMaterial>;
            dieMat.opacity = (0.5 + (1 - progress) * 0.4) * (modeState === "lobby" ? 0.3 : 1);
            dieMat.color.setHex(0xffd700);
          });
        }

        // ---- Core Light ----
        const baseIntensity = 2 + phaseBlend * 6 + stepProgressState * 5
          + pSignal * Math.sin(t * 4.5) * 2.8
          + pImage * 6 + pLive * 12;
        coreLight.intensity = baseIntensity + Math.sin(t * (1.8 + phaseBlend * 2.5)) * 2;
        coreLight.color.setHex(sync > 0.5 ? 0x7dd3fc : 0xd9a441);
        if (sync > 0.5) {
          coreMat.color.setHex(0x7dd3fc);
          igMat.color.setHex(0x7dd3fc);
        } else {
          coreMat.color.setHex(0xffd700);
          igMat.color.setHex(0xd9a441);
        }

        // ---- Ground ----
        groundMat.opacity = 0.32 + phaseBlend * 0.38 + pImage * 0.22 + pLive * 0.35;
        ground.rotation.z = t * 0.02 * speed;

        // ---- Beams ----
        beamMeshes.forEach((bm, i) => {
          const bmMat = bm.material as InstanceType<typeof THREE.MeshBasicMaterial>;
          bmMat.opacity = (0.015 + phaseBlend * 0.04 + pImage * 0.07 + pLive * 0.12)
            + Math.sin(t * 0.5 + i * 1.1) * 0.018;
          bm.rotation.y += 0.0008 * speed;
        });

        // ---- Rune Ring ----
        runeRing.rotation.z = t * 0.04 * speed;
        runeMat.opacity = 0.06 + phaseBlend * 0.12 + pSheet * 0.14 + pLive * 0.18;

        // ---- Dash Ring ----
        dashRing.rotation.y = t * (0.08 + pInteg * 0.35) * speed;
        dashRing.rotation.z = t * (0.04 + pImage * 0.22) * speed;
        dashMat.opacity = 0.04 + phaseBlend * 0.04 + pInteg * 0.1;

        // ---- Soul Orbs ----
        const orbSpin = t * 0.1 * speed;
        orbs.forEach((orb) => {
          const age = t - orb.born;
          const fadeIn = Math.min(1, age / 1.0);
          const ease = 1 - Math.pow(1 - fadeIn, 3);

          const angle = orb.baseAngle + orbSpin;
          const r = orbRadius * (1 - phaseBlend * 0.25 + sync * 0.12)
            + Math.sin(t * 0.6 + orb.baseAngle) * 0.35;
          const bob = 1.5 + Math.sin(t * 0.55 + orb.baseAngle * 2) * 0.5;

          // Entry: fly in from far away
          const entryT = Math.min(1, age / 2.0);
          const entryEase = 1 - Math.pow(1 - entryT, 4);
          const curR = 25 + (r - 25) * entryEase;
          const curY = (bob + 8) - 8 * entryEase;

          orb.group.position.set(
            Math.cos(angle) * curR,
            curY,
            Math.sin(angle) * curR
          );

          const isLocal = localPlayerIdState && orb.id === localPlayerIdState;
          const scaleMult = isLocal ? 1.6 : 1.0;

          const sMat = orb.sphere.material as InstanceType<typeof THREE.MeshBasicMaterial>;
          const hMat = orb.halo.material as InstanceType<typeof THREE.MeshBasicMaterial>;
          const tMat = orb.trail.material as InstanceType<typeof THREE.MeshBasicMaterial>;
          const flk = 0.65 + Math.sin(t * 2.2 + orb.baseAngle * 3) * 0.35;
          sMat.opacity = ease * flk;
          hMat.opacity = ease * 0.2 * flk;
          tMat.opacity = ease * flk * 0.9;
          orb.light.intensity = ease * (1.5 + phaseBlend * 0.6) * flk * (isLocal ? 2.5 : 1.0);

          orb.sphere.scale.setScalar(scaleMult);

          // Join burst
          const burst = Math.max(0, 1 - age / 1.8);
          orb.halo.scale.setScalar((1 + burst * 4) * scaleMult);
          orb.light.intensity += burst * 7;

          // Integrate phase: pull last orb inward
          if (pInteg > 0 && orb === orbs[orbs.length - 1]) {
            const pullR = r * 0.25;
            orb.group.position.set(
              Math.cos(angle) * pullR,
              bob * 0.5,
              Math.sin(angle) * pullR
            );
            hMat.opacity += 0.35;
            orb.light.intensity += 5;
          }

          if (orb.beam) {
            const points = [
              orb.group.position.clone(),
              new THREE.Vector3(0, 1.5, 0)
            ];
            orb.beam.geometry.setFromPoints(points);
            const bMat = orb.beam.material as InstanceType<typeof THREE.LineBasicMaterial>;
            bMat.opacity = ease * (0.35 + Math.sin(t * 6) * 0.25);
          }
        });

        // ---- Particles: Dust ----
        const dArr = dustGeo.attributes.position.array as Float32Array;
        for (let i = 0; i < dustN; i++) {
          dArr[i * 3]     += dustVel[i * 3];
          dArr[i * 3 + 1] += dustVel[i * 3 + 1];
          dArr[i * 3 + 2] += dustVel[i * 3 + 2];
          if (Math.abs(dArr[i * 3]) > 19 || dArr[i * 3 + 1] > 16 || Math.abs(dArr[i * 3 + 2]) > 19) {
            dArr[i * 3]     = (Math.random() - 0.5) * 38;
            dArr[i * 3 + 1] = -1;
            dArr[i * 3 + 2] = (Math.random() - 0.5) * 38;
          }
        }
        dustGeo.attributes.position.needsUpdate = true;
        dustMat.opacity = 0.2 + phaseBlend * 0.15;

        // ---- Particles: Sparks ----
        const sArr = spkGeo.attributes.position.array as Float32Array;
        for (let i = 0; i < spkN; i++) {
          spkAng[i] += spkSpd[i] * 0.025 * speed;
          spkRad[i] -= spkSpd[i] * 0.006 * speed;
          if (spkRad[i] < 0.4) {
            spkRad[i] = 1.5 + Math.random() * 7;
            spkAng[i] = Math.random() * Math.PI * 2;
            spkH[i]   = Math.random() * 5.5;
          }
          sArr[i * 3]     = Math.cos(spkAng[i]) * spkRad[i];
          sArr[i * 3 + 1] = spkH[i] + Math.sin(t * 0.4 + i) * 0.25;
          sArr[i * 3 + 2] = Math.sin(spkAng[i]) * spkRad[i];
        }
        spkGeo.attributes.position.needsUpdate = true;
        spkMat.opacity = 0.3 + phaseBlend * 0.28 + pImage * 0.18;

        // ---- Particles: Embers ----
        const eArr = embGeo.attributes.position.array as Float32Array;
        for (let i = 0; i < embN; i++) {
          eArr[i * 3 + 1] += embSpd[i] * dt * speed * 0.6;
          eArr[i * 3]     += Math.sin(t + i) * 0.003;
          eArr[i * 3 + 2] += Math.cos(t + i) * 0.003;
          if (eArr[i * 3 + 1] > 13) {
            const ea = Math.random() * Math.PI * 2;
            const er = Math.random() * 3;
            eArr[i * 3]     = Math.cos(ea) * er;
            eArr[i * 3 + 1] = -0.5;
            eArr[i * 3 + 2] = Math.sin(ea) * er;
          }
        }
        embGeo.attributes.position.needsUpdate = true;
        embMat.opacity = 0.35 + phaseBlend * 0.35 + pImage * 0.2;

        // ---- Camera: Cinematic orbit ----
        const orbitSpeed = isController ? 0.25 : speed;
        camAngle += dt * 0.05 * orbitSpeed;
        const aspect = mount.clientWidth / mount.clientHeight;
        const aspectMult = aspect < 1 ? Math.min(1.8, 1.25 / aspect) : 1.0;
        
        let cR = (14 - phaseBlend * 2.5 - pLive * 3.5) * aspectMult;
        let cH = (6 + Math.sin(t * 0.12) * 0.6 - phaseBlend * 0.8) * aspectMult;
        
        if (isController) {
          cR = 9.0 * aspectMult;
          cH = 4.5 * aspectMult;
        }
        
        let shake = 0;
        if (modeState !== "lobby" && modeState !== "player-sync") {
          // Camera shake intensifies as progress reaches 100%
          shake = stepProgressState * 0.08;
        }
        const shakeX = (Math.random() - 0.5) * shake;
        const shakeY = (Math.random() - 0.5) * shake;
        const shakeZ = (Math.random() - 0.5) * shake;

        camera.position.set(
          Math.cos(camAngle) * cR + shakeX,
          cH + shakeY,
          Math.sin(camAngle) * cR + shakeZ
        );
        
        if (isController) {
          camera.lookAt(0, 1.0, 1.0);
        } else {
          camera.lookAt(0, 1.2, 0);
        }

        renderer.render(scene, camera);
      };

      animate();

      // ---- Handle Resize ----
      const onResize = () => {
        if (!mount || disposed) return;
        camera.aspect = mount.clientWidth / mount.clientHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(mount.clientWidth, mount.clientHeight);
      };
      window.addEventListener("resize", onResize);

      sceneRef.current = {
        dispose: () => {
          disposed = true;
          cancelAnimationFrame(animId);
          window.removeEventListener("resize", onResize);
          renderer.dispose();
          scene.traverse((obj) => {
            if ((obj as any).isMesh || (obj as any).isLine) {
              (obj as any).geometry.dispose();
              const mat = (obj as any).material;
              if (Array.isArray(mat)) mat.forEach((m: InstanceType<typeof THREE.Material>) => m.dispose());
              else (mat as InstanceType<typeof THREE.Material>).dispose();
            }
          });
          if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
        },
        setActive: (v: boolean) => { activeState = v; },
        setMode: (v: HostLoadingMode) => { modeState = v; },
        setStepProgress: (v: number) => { stepProgressState = Math.max(0, Math.min(1, v)); },
        setPhaseKey: (v: string) => { phaseKeyState = v; },
        setPlayers: (v: PortalPlayer[]) => { reconcileOrbs(v); },
        setLocalPlayerId: (v?: string) => {
          localPlayerIdState = v;
          orbs.forEach((o) => {
            if (localPlayerIdState && o.id === localPlayerIdState) {
              if (!o.beam) {
                const lineGeo = new THREE.BufferGeometry().setFromPoints([
                  new THREE.Vector3(0, 0, 0),
                  new THREE.Vector3(0, 0, 0)
                ]);
                const lineMat = new THREE.LineBasicMaterial({
                  color: o.color,
                  transparent: true,
                  opacity: 0.8,
                  blending: THREE.AdditiveBlending
                });
                o.beam = new THREE.Line(lineGeo, lineMat);
                scene.add(o.beam);
              }
            } else {
              if (o.beam) {
                scene.remove(o.beam);
                o.beam.geometry.dispose();
                (o.beam.material as InstanceType<typeof THREE.Material>).dispose();
                o.beam = undefined;
              }
            }
          });
        }
      };
    });

    return () => {
      disposed = true;
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Push reactive state into the Three.js scene
  const playersSig = players.map((p) => `${p.id}:${p.color ?? ""}`).join("|");
  useEffect(() => {
    let cancelled = false;
    const push = () => {
      const s = sceneRef.current;
      if (!s) {
        if (!cancelled) requestAnimationFrame(push);
        return;
      }
      s.setActive(isActive);
      s.setMode(mode);
      s.setStepProgress(stepProgress);
      s.setPhaseKey(phaseKey);
      s.setPlayers(players);
      s.setLocalPlayerId(localPlayerId);
    };
    push();
    return () => { cancelled = true; };
  }, [isActive, mode, stepProgress, phaseKey, playersSig, localPlayerId]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={mountRef} className="threejs-portal-mount" />;
}

function CinematicLoadingOverlay({ campaign, status, mode, threeDEnabled }: { campaign: Campaign; status: string; mode: HostLoadingMode; threeDEnabled: boolean }) {
  const isLobby = mode === "lobby";
  const isPlayerSync = mode === "player-sync";
  const isActive = !isLobby;
  const phases = getHostPhases(mode);
  const currentStep = getHostPhaseIndex(mode, status, campaign.dmPhase);
  const stepProgress = isLobby ? 0 : Math.min(1, currentStep / Math.max(1, phases.length - 1));
  const activePhase = phases[currentStep] || phases[0];

  const portalPlayers = useMemo<PortalPlayer[]>(
    () => campaign.players.map((p) => ({ id: p.id, color: p.color })),
    [campaign.players]
  );

  const joinUrl = typeof window !== "undefined" ? controllerUrl(campaign.joinCode) : "";
  const joinUrlClean = joinUrl.replace(/^https?:\/\//, "");
  const flavor = flavorOf(campaign.campaignType);

  return (
    <div className={`cinematic-overlay cinematic-${mode}`}>
      {/* Full 3D Portal Scene, or CSS-only backdrop when 3D is off */}
      {threeDEnabled ? (
        <CinematicPortalScene
          isActive={isActive}
          mode={mode}
          stepProgress={stepProgress}
          phaseKey={activePhase?.key || "signal"}
          players={portalPlayers}
        />
      ) : (
        <CinematicFallbackBackdrop />
      )}

      {/* Floating HUD Layer */}
      <div className="cinematic-hud">
        {/* Top: Title + State */}
        <div className="cin-hud-top">
          <span className="cin-kicker">
            {isLobby ? "✦ LOBBY BEACON ✦" : isPlayerSync ? flavor.spliceKicker : flavor.gateKicker}
          </span>
          <h1 className="cin-title">
            {isLobby ? "Assemble the Party" : isPlayerSync ? flavor.spliceTitle : flavor.gateTitle}
          </h1>
          <p className="cin-campaign-name">{campaign.title}</p>
        </div>

        {/* Right side: Ritual integrity (only shown if not lobby) */}
        {!isLobby && (
          <aside className="cin-hud-right">
            <span className="cin-label">Ritual Integrity</span>
            <strong className="cin-big-text">{Math.round(stepProgress * 100)}%</strong>
            <p>{isPlayerSync
              ? "Merging player without disturbing the live scene."
              : "The opening state is being conjured."}</p>
          </aside>
        )}

        {/* Bottom left: Player roster strip */}
        <div className="cin-player-strip">
          {campaign.players.map((p) => (
            <div
              key={p.id}
              className={`cin-player-pip ${p.status === "Generating profile..." ? "syncing" : ""}`}
              style={p.color ? { borderColor: `${p.color}aa`, boxShadow: `0 0 14px ${p.color}55` } as CSSProperties : undefined}
            >
              <Avatar portraitUrl={p.portraitUrl} name={p.characterName || p.name} />
              <span style={p.color ? { color: p.color } : undefined}>{p.characterName || p.name}</span>
            </div>
          ))}
          {campaign.players.length === 0 && <span className="cin-empty-roster">{flavor.emptyRoster}</span>}
        </div>

        {/* Bottom center: Phase track + status */}
        {!isLobby && (
          <div className="cin-phase-track">
            <div className="cin-phase-nodes">
              <div className="cin-phase-line"><div className="cin-phase-fill" style={{ width: `${stepProgress * 100}%` }} /></div>
              {phases.map((phase, i) => (
                <div key={phase.key} className={`cin-phase-node ${i < currentStep ? "done" : i === currentStep ? "active" : "queued"}`}>
                  <div className="cin-node-dot"><span>{phase.icon || "◆"}</span></div>
                  <span className="cin-node-label">{phase.label}</span>
                </div>
              ))}
            </div>
            <p className="cin-status-text">{status}</p>
            {activePhase && (
              <p className="cin-phase-detail">{activePhase.detail}</p>
            )}
          </div>
        )}

        {isLobby && <p className="cin-lobby-status">{status}</p>}

        <div className={`cin-tip-corner ${isLobby ? "cin-lobby-corner" : ""}`}>
          {isLobby ? (
            <div className="cin-join-card">
              <div className="cin-join-info">
                <span className="cin-join-code-label">Join Code</span>
                <strong className="cin-join-code-value">{campaign.joinCode}</strong>
                <span className="cin-join-link-label">Scan or Visit</span>
                <a 
                  href={joinUrl} 
                  target="_blank" 
                  rel="noopener noreferrer" 
                  className="cin-join-link"
                >
                  {joinUrlClean}
                </a>
                <p className="cin-join-status">
                  {campaign.players.length === 0
                    ? flavor.awaitingFirst
                    : flavor.joined(campaign.players.length)}
                </p>
              </div>
              <div className="cin-join-qr-wrapper">
                <QRCodeSVG value={joinUrl} size={90} bgColor="#ffffff" fgColor="#000000" includeMargin={false} />
              </div>
            </div>
          ) : (
            <CyclingTipBox variant={themeOf(campaign)} />
          )}
        </div>
      </div>
    </div>
  );
}

function SceneStage({
  campaign,
  setCampaign,
  busy,
  setBusy,
  setError
}: {
  campaign: Campaign;
  setCampaign?: (campaign: Campaign) => void;
  busy?: boolean;
  setBusy?: (busy: boolean) => void;
  setError?: (error: string) => void;
}) {
  const latestDice = latestDiceEvent(campaign.displayEvents);

  const [showDice, setShowDice] = useState(false);
  const [charging, setCharging] = useState(false);

  useEffect(() => {
    if (!latestDice) {
      setShowDice(false);
      return;
    }
    const elapsed = Date.now() - new Date(latestDice.createdAt).getTime();
    if (elapsed < 10000) {
      setShowDice(true);
      setCharging(false);
      const timer = setTimeout(() => {
        setShowDice(false);
      }, 10000 - elapsed);
      return () => clearTimeout(timer);
    } else {
      setShowDice(false);
    }
  }, [latestDice]);

  // Detect a playerAction newer than the latest dice event — start charging phase
  useEffect(() => {
    if (!campaign) return;
    const diceTs = latestDice ? new Date(latestDice.createdAt).getTime() : 0;
    const lastAction = [...campaign.displayEvents]
      .reverse()
      .find((e) => e.type === "playerAction");
    if (!lastAction) {
      setCharging(false);
      return;
    }
    const actionTs = new Date(lastAction.createdAt).getTime();
    const isNewerThanDice = actionTs > diceTs;
    const isRecent = Date.now() - actionTs < 30000;
    setCharging(isNewerThanDice && isRecent && !showDice);
  }, [campaign?.displayEvents, latestDice, showDice, campaign]);

  const chatBottomRef = useRef<HTMLDivElement>(null);
  const chatEvents = campaign.displayEvents.filter((event) =>
    ["narration", "dialogue", "playerAction", "system", "dice"].includes(event.type)
  );

  useEffect(() => {
    if (chatBottomRef.current) {
      chatBottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [chatEvents.length]);

  const isInitialIntro = !campaign.displayEvents.some(
    (e) => e.type === "narration" || e.type === "dialogue"
  );

  const [threeDEnabled] = use3DEnabled();
  const hostLoadingMode = getHostLoadingMode(campaign);
  const showMagicalLoading =
    campaign.status === "lobby" ||
    (campaign.status === "active" && isInitialIntro) ||
    (hostLoadingMode === "player-sync" && !!campaign.dmStatus);

  const showOverlay = showDice || charging;

  return (
    <section className="scene-stage fullscreen-stage">
      <SmoothBackground imageUrl={campaign.currentImageUrl} />
      <div className="scene-vignette" />
      
      <div className="stage-grid-layout" style={(campaign.questLog && campaign.showQuestOnTV !== false) ? { gridTemplateColumns: "280px minmax(0, 1fr) 280px" } : undefined}>
        {campaign.questLog && campaign.showQuestOnTV !== false && (
          <aside className="host-quest-log">
            <h3 className="quest-log-title">Quest Log</h3>
            <div className="panel-scroll" style={{ overflowY: "auto", flex: 1, paddingRight: "0.25rem" }}>
              {parseQuestLog(campaign.questLog)}
            </div>
          </aside>
        )}
        
        <div className="scene-content">
          <div className="meta-row">
            <span className="pill">Join code: {campaign.joinCode}</span>
          </div>
          <h1 className="scene-title">{campaign.title}</h1>
          <p className="scene-overview">{campaign.overview || campaign.currentScene}</p>
          
          {campaign.status === "active" && campaign.dmStatus && (
            <div className="inline-thinking-status">
              <span className="thinking-dot"></span>
              <span className="thinking-text">{campaign.dmStatus}</span>
            </div>
          )}
          
          <div className="chat-log-container">
            <div className="chat-log-scrollable">
              {chatEvents.map((event) => (
                <DialogueBox 
                  key={event.id} 
                  event={event} 
                  campaign={campaign} 
                  setCampaign={setCampaign}
                  busy={busy}
                  setBusy={setBusy}
                  setError={setError}
                />
              ))}
              <div ref={chatBottomRef} />
            </div>
          </div>
        </div>

        <HostPartyBar campaign={campaign} />
      </div>

      {showMagicalLoading && (
        <CinematicLoadingOverlay
          campaign={campaign}
          status={campaign.dmStatus || (campaign.status === "lobby" ? "Gathering party..." : "Preparing the initial scenario...")}
          mode={hostLoadingMode}
          threeDEnabled={threeDEnabled}
        />
      )}

      {showOverlay && <DiceOverlay event={showDice ? latestDice : undefined} charging={charging} threeDEnabled={threeDEnabled} />}
    </section>
  );
}

const LOADING_TITLES = [
  "The chronicles are shifting...",
  "Consulting the ancient scrolls...",
  "Shuffling the deck of fate...",
  "Aligning the stars of destiny...",
  "Drawing paths in the dark...",
  "Forging the legends...",
  "Whispering to the ether...",
  "Rolling for initiative...",
  "Steering the timeline...",
  "Awakening the old gods...",
  "Carving dark dungeon chambers...",
  "Summoning wandering monsters...",
  "Lighting the dungeon torches...",
  "Feeding the tavern mimics...",
  "Brewing fresh healing potions...",
  "Deciphering cryptic runes...",
  "Stirring the dragon's hoard...",
  "Polishing the 20-sided die...",
  "Sharpening rusty broadswords...",
  "Whispering rumors to tavern patrons...",
  "Unlocking hidden stone doors...",
  "Writing local campaign lore...",
  "Counting lost copper pieces...",
  "Preparing spell slots...",
  "Bribing the goblins with shiny rocks...",
  "Polishing the Beholder's many eyes...",
  "Sensing a disturbance in the Weave...",
  "Stretching the gelatinous cube...",
  "Summoning a horde of gazebo monsters...",
  "Consulting the Dungeon Master's Guide...",
  "Checking behind the DM screen...",
  "Plotting character tragic backstories...",
  "Whispering bargains with planar entities...",
  "Waking up the sleeping ancient dragon...",
  "Drafting contracts with the Archdevil...",
  "Resurrecting fallen adventurers...",
  "Hiding traps beneath suspicious rugs...",
  "Preparing the tavern keeper's secret quest...",
  "Polishing the Rust Monster's antennae...",
  "Casting Detect Magic on the loading bar...",
  "Infusing magic into common longswords...",
  "Whispering dark secrets to the Warlock..."
];

function TypingTitle({ texts }: { texts: string[] }) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [displayText, setDisplayText] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    let timer: number;
    const currentFullText = texts[currentIndex] || "";

    if (!isDeleting) {
      if (displayText !== currentFullText) {
        timer = window.setTimeout(() => {
          setDisplayText(currentFullText.slice(0, displayText.length + 1));
        }, 60);
      } else {
        timer = window.setTimeout(() => {
          setIsDeleting(true);
        }, 10000);
      }
    } else {
      if (displayText !== "") {
        timer = window.setTimeout(() => {
          setDisplayText(displayText.slice(0, -1));
        }, 30);
      } else {
        setIsDeleting(false);
        setCurrentIndex((prev) => (prev + 1) % texts.length);
      }
    }

    return () => clearTimeout(timer);
  }, [displayText, isDeleting, currentIndex, texts]);

  return (
    <h2 className="typing-title-container">
      <span className="typing-text">{displayText}</span>
      <span className="typing-cursor">|</span>
    </h2>
  );
}

function D20Spinner({ showNumber = true, finalValue }: { showNumber?: boolean; finalValue?: number }) {
  const [num, setNum] = useState(20);

  useEffect(() => {
    if (!showNumber || finalValue !== undefined) return;
    const interval = setInterval(() => {
      setNum((prev) => (prev % 20) + 1);
    }, 120);
    return () => clearInterval(interval);
  }, [showNumber, finalValue]);

  const display = finalValue !== undefined ? finalValue : num;

  return (
    <div className="d20-spinner-container">
      <svg viewBox="0 0 120 120" className="d20-svg">
        <defs>
          <radialGradient id="d20-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(217, 164, 65, 0.45)" />
            <stop offset="100%" stopColor="rgba(0, 0, 0, 0)" />
          </radialGradient>
          <linearGradient id="face-grad-center" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="rgba(255, 215, 0, 0.35)" />
            <stop offset="100%" stopColor="rgba(217, 164, 65, 0.08)" />
          </linearGradient>
          <linearGradient id="face-grad-outer" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="rgba(217, 164, 65, 0.18)" />
            <stop offset="100%" stopColor="rgba(20, 15, 30, 0.45)" />
          </linearGradient>
          <filter id="neon-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <circle cx="60" cy="60" r="50" fill="url(#d20-glow)" className="ambient-glow" />

        <circle cx="60" cy="60" r="54" fill="none" stroke="rgba(217, 164, 65, 0.25)" strokeWidth="1.5" strokeDasharray="10 15 25 10" className="magic-ring ring-outer" />
        <circle cx="60" cy="60" r="48" fill="none" stroke="rgba(217, 164, 65, 0.15)" strokeWidth="1" strokeDasharray="5 5 15 5" className="magic-ring ring-inner" />

        <g className="d20-group">
          <polygon points="60,15 20,40 60,40" fill="url(#face-grad-outer)" className="d20-face face-tl" />
          <polygon points="60,15 100,40 60,40" fill="url(#face-grad-outer)" className="d20-face face-tr" />
          <polygon points="100,40 80,75 60,40" fill="url(#face-grad-outer)" className="d20-face face-ur" />
          <polygon points="100,40 100,80 80,75" fill="url(#face-grad-outer)" className="d20-face face-mr" />
          <polygon points="100,80 60,105 80,75" fill="url(#face-grad-outer)" className="d20-face face-lr" />
          <polygon points="60,105 40,75 80,75" fill="url(#face-grad-outer)" className="d20-face face-b" />
          <polygon points="60,105 20,80 40,75" fill="url(#face-grad-outer)" className="d20-face face-ll" />
          <polygon points="20,80 20,40 40,75" fill="url(#face-grad-outer)" className="d20-face face-ml" />
          <polygon points="20,40 60,40 40,75" fill="url(#face-grad-outer)" className="d20-face face-ul" />
          <polygon points="60,40 80,75 40,75" fill="url(#face-grad-center)" className="d20-face face-c" />

          <g stroke="rgba(217, 164, 65, 0.6)" strokeWidth="1.5" strokeLinejoin="round" fill="none">
            <polygon points="60,15 100,40 100,80 60,105 20,80 20,40" className="d20-outline" />
            <line x1="60" y1="15" x2="60" y2="40" />
            <line x1="100" y1="40" x2="60" y2="40" />
            <line x1="20" y1="40" x2="60" y2="40" />
            <line x1="100" y1="40" x2="80" y2="75" />
            <line x1="100" y1="80" x2="80" y2="75" />
            <line x1="60" y1="105" x2="80" y2="75" />
            <line x1="60" y1="105" x2="40" y2="75" />
            <line x1="20" y1="80" x2="40" y2="75" />
            <line x1="20" y1="40" x2="40" y2="75" />
            <line x1="60" y1="40" x2="80" y2="75" />
            <line x1="80" y1="75" x2="40" y2="75" />
            <line x1="40" y1="75" x2="60" y2="40" />
          </g>

          {showNumber && (
            <text x="60" y="66" textAnchor="middle" fill="var(--gold)" filter="url(#neon-glow)" className={`d20-text ${finalValue !== undefined ? "d20-final-pop" : ""}`}>{display}</text>
          )}
        </g>

        <circle cx="25" cy="20" r="1.5" fill="var(--gold)" className="particle p1" />
        <circle cx="95" cy="25" r="1" fill="var(--gold)" className="particle p2" />
        <circle cx="15" cy="85" r="2" fill="var(--gold)" className="particle p3" />
        <circle cx="105" cy="90" r="1.5" fill="var(--gold)" className="particle p4" />
        <circle cx="60" cy="115" r="1" fill="var(--gold)" className="particle p5" />
      </svg>
    </div>
  );
}

function DMThinkingOverlay({ status }: { status: string }) {
  return (
    <div className="dm-thinking-overlay">
      <div className="thinking-content">
        <D20Spinner />
        <TypingTitle texts={LOADING_TITLES} />
        <p className="small italic text-glow">{status}</p>
      </div>
    </div>
  );
}

function formatContent(text: string): React.ReactNode[] {
  if (!text) return [];
  
  let cleanText = text;
  const match = text.match(/^Player\s+(.*?)\s+does\s+this\s+from\s+their\s+phone\s+controller:\s*(.*)/i);
  if (match) {
    cleanText = match[2];
  }

  const boldRegex = /(\*\*.*?\*\*|\*.*?\*)/g;
  const tokens = cleanText.split(boldRegex);

  return tokens.map((token, index) => {
    if (token.startsWith("**") && token.endsWith("**")) {
      return <strong key={index}>{token.slice(2, -2)}</strong>;
    } else if (token.startsWith("*") && token.endsWith("*")) {
      return <span key={index} className="dialogue-action">{token.slice(1, -1)}</span>;
    }
    return token;
  });
}

function DialogueBox({
  event,
  campaign,
  setCampaign,
  busy,
  setBusy,
  setError
}: {
  event: DisplayEvent;
  campaign: Campaign;
  setCampaign?: (campaign: Campaign) => void;
  busy?: boolean;
  setBusy?: (busy: boolean) => void;
  setError?: (error: string) => void;
}) {
  const isPlayer = event.type === "playerAction";
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(event.content || "");

  const speakerColor = useMemo(() => {
    if (!event.speaker || event.speaker === "NARRATOR" || event.speaker === "SYSTEM") return undefined;
    const player = campaign.players.find((p) => (p.characterName || p.name).toLowerCase() === event.speaker?.toLowerCase());
    if (player?.color) return player.color;
    const npc = campaign.storyCharacters.find((c) => c.name.toLowerCase() === event.speaker?.toLowerCase());
    if (npc?.color) return npc.color;
    return undefined;
  }, [event.speaker, campaign.players, campaign.storyCharacters]);

  const isPlayerDialogue = useMemo(() => {
    if (event.type === "playerAction") return true;
    if (!event.speaker) return false;
    return campaign.players.some(
      (p) => (p.characterName || p.name).toLowerCase() === event.speaker?.toLowerCase()
    );
  }, [event.type, event.speaker, campaign.players]);

  const canEdit = !isPlayerDialogue && !!setCampaign && (event.type === "narration" || event.type === "dialogue");

  const handleStartEdit = () => {
    setEditText(event.content || "");
    setIsEditing(true);
  };

  const handleSave = async () => {
    if (!setCampaign || !setBusy || !setError) return;
    setIsEditing(false);
    
    // Optimistic UI update
    const originalEvents = campaign.displayEvents;
    const updatedEvents = campaign.displayEvents.map((e) =>
      e.id === event.id ? { ...e, content: editText } : e
    );
    setCampaign({ ...campaign, displayEvents: updatedEvents });

    try {
      setBusy(true);
      const data = await fetchJson<{ campaign: Campaign }>("/api/party", {
        method: "POST",
        body: JSON.stringify({
          campaignId: campaign.id,
          action: "editEvent",
          eventId: event.id,
          content: editText
        })
      });
      setCampaign(data.campaign);
    } catch (err) {
      setError(messageOf(err));
      // Rollback
      setCampaign({ ...campaign, displayEvents: originalEvents });
    } finally {
      setBusy(false);
    }
  };

  if (event.type === "dice" && event.dice) {
    return (
      <div className="dialogue-box event-dice align-center" key={event.id}>
        <div className="dice-log-pill">
          🎲 <strong>{event.speaker || "Roll"}</strong>: {event.content || event.dice.reason} ➔ <span className="gold-text">{event.dice.total}</span> <span className="small">({event.dice.notation}: {event.dice.rolls.join(",")}{event.dice.modifier ? ` ${event.dice.modifier > 0 ? "+" : ""}${event.dice.modifier}` : ""})</span>
        </div>
      </div>
    );
  }

  return (
    <div 
      className={`dialogue-box event-${event.type} ${isPlayer ? "align-right" : "align-left"}`} 
      key={event.id}
      style={speakerColor ? { borderColor: speakerColor } : undefined}
    >
      <div className="dialogue-speaker" style={speakerColor ? { color: speakerColor } : undefined}>
        {event.speaker || (isPlayer ? "Player" : event.type)}
      </div>
      {isEditing ? (
        <div className="inline-edit-form" style={{ marginTop: "0.5rem", zIndex: 10, position: "relative" }}>
          <textarea
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            disabled={busy}
            style={{
              width: "100%",
              minHeight: "4rem",
              background: "rgba(20, 18, 25, 0.8)",
              border: "1px solid var(--gold)",
              borderRadius: "8px",
              color: "#fff",
              padding: "8px",
              marginBottom: "8px",
              fontFamily: "inherit",
              fontSize: "0.95rem"
            }}
          />
          <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
            <button 
              disabled={busy} 
              onClick={handleSave}
              className="save-edit-btn"
              style={{
                padding: "4px 12px",
                borderRadius: "6px",
                background: "var(--gold)",
                color: "#000",
                fontWeight: "bold",
                border: "none",
                fontSize: "0.85rem",
                cursor: "pointer"
              }}
            >
              {busy ? "Saving..." : "Save"}
            </button>
            <button 
              disabled={busy} 
              onClick={() => setIsEditing(false)}
              className="cancel-edit-btn"
              style={{
                padding: "4px 12px",
                borderRadius: "6px",
                background: "rgba(255,255,255,0.1)",
                color: "#fff",
                border: "1px solid rgba(255,255,255,0.2)",
                fontSize: "0.85rem",
                cursor: "pointer"
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="dialogue-content">{formatContent(event.content || "")}</div>
          {canEdit && (
            <button 
              className="edit-event-btn" 
              onClick={handleStartEdit}
              title="Edit and steer dialogue"
            >
              ✏️ Edit
            </button>
          )}
        </>
      )}
      {event.itemUsed && (
        <div className="use-tag item-use-tag">
          <span>🎒 Item:</span> <strong>{event.itemUsed}</strong>
        </div>
      )}
      {event.abilityUsed && (
        <div className="use-tag ability-use-tag">
          <span>⚡ Ability:</span> <strong>{event.abilityUsed}</strong>
        </div>
      )}
    </div>
  );
}

function colorFromRollOwner(event?: DisplayEvent) {
  const source = event?.playerId || event?.speaker || "dice";
  let hash = 0;
  for (let i = 0; i < source.length; i++) hash = (hash * 31 + source.charCodeAt(i)) >>> 0;
  const palette = ["#d9a441", "#7dd3fc", "#c084fc", "#fb7185", "#34d399", "#f97316"];
  return palette[hash % palette.length];
}

function ThreeJSD20Roll({ dice, phase, accentColor }: { dice?: DiceEvent; phase: "charging" | "rolling" | "settled"; accentColor: string }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{
    dispose: () => void;
    setPhase: (v: "charging" | "rolling" | "settled") => void;
    setDice: (v?: DiceEvent) => void;
    setAccent: (v: string) => void;
  } | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let disposed = false;

    import("three").then((THREE) => {
      if (disposed) return;

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(42, mount.clientWidth / mount.clientHeight, 0.1, 80);
      camera.position.set(0, 0.7, 7.4);
      camera.lookAt(0, 0, 0);

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(mount.clientWidth, mount.clientHeight);
      renderer.setClearColor(0x000000, 0);
      mount.appendChild(renderer.domElement);

      let phaseState = phase;
      let diceState = dice;
      let accentState = accentColor;
      let displayNumber = diceState?.total ?? 20;
      let finalReveal = 0;

      const accent = new THREE.Color(accentState);
      const dieMat = new THREE.MeshPhysicalMaterial({
        color: 0x171019,
        metalness: 0.55,
        roughness: 0.28,
        transmission: 0.18,
        thickness: 0.8,
        transparent: true,
        opacity: 0.94,
        emissive: accent,
        emissiveIntensity: 0.24,
      });
      const edgeMat = new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.86 });

      const die = new THREE.Mesh(new THREE.IcosahedronGeometry(1.55, 0), dieMat);
      scene.add(die);

      const edgeGeo = new THREE.EdgesGeometry(die.geometry, 1);
      const edges = new THREE.LineSegments(edgeGeo, edgeMat);
      die.add(edges);

      const floor = new THREE.Mesh(
        new THREE.CircleGeometry(3.2, 96),
        new THREE.MeshBasicMaterial({ color: 0xd9a441, transparent: true, opacity: 0.08, side: THREE.DoubleSide })
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -1.72;
      scene.add(floor);

      const halo = new THREE.Mesh(
        new THREE.TorusGeometry(2.05, 0.015, 8, 128),
        new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.35 })
      );
      halo.rotation.x = Math.PI / 2;
      scene.add(halo);

      const light = new THREE.PointLight(accent, 4.6, 20);
      light.position.set(0, 2.3, 3.4);
      scene.add(light);
      scene.add(new THREE.AmbientLight(0xfff1cc, 0.36));

      const numberCanvas = document.createElement("canvas");
      numberCanvas.width = 256;
      numberCanvas.height = 256;
      const numberCtx = numberCanvas.getContext("2d");
      const numberTexture = new THREE.CanvasTexture(numberCanvas);
      const numberMat = new THREE.MeshBasicMaterial({ map: numberTexture, transparent: true, depthWrite: false });
      const numberPlane = new THREE.Mesh(new THREE.PlaneGeometry(1.55, 1.55), numberMat);
      numberPlane.position.set(0, 0.03, 1.58);
      die.add(numberPlane);

      const redrawNumber = (value: number | string, alpha: number) => {
        if (!numberCtx) return;
        numberCtx.clearRect(0, 0, 256, 256);
        numberCtx.globalAlpha = alpha;
        numberCtx.fillStyle = "rgba(255, 245, 220, 0.92)";
        numberCtx.shadowColor = accentState;
        numberCtx.shadowBlur = 24;
        numberCtx.font = "bold 112px Georgia, serif";
        numberCtx.textAlign = "center";
        numberCtx.textBaseline = "middle";
        numberCtx.fillText(String(value), 128, 132);
        numberCtx.globalAlpha = 1;
        numberTexture.needsUpdate = true;
      };
      redrawNumber(displayNumber, 0.25);

      const clock = new THREE.Clock();
      let animationId = 0;
      let lastRandomTick = 0;
      let impact = 0;

      const animate = () => {
        animationId = requestAnimationFrame(animate);
        const t = clock.getElapsedTime();
        const speed = phaseState === "charging" ? 2.8 : phaseState === "rolling" ? 5.8 : 0.35;
        const settled = phaseState === "settled";

        if (phaseState === "rolling" && t - lastRandomTick > 0.07) {
          lastRandomTick = t;
          displayNumber = 1 + Math.floor(Math.random() * 20);
          redrawNumber(displayNumber, 0.28);
        }

        if (settled) {
          finalReveal = Math.min(1, finalReveal + 0.055);
          displayNumber = diceState?.total ?? displayNumber;
          redrawNumber(displayNumber, finalReveal);
          impact = Math.max(0, 1 - finalReveal);
          die.rotation.x += (0.42 - die.rotation.x) * 0.08;
          die.rotation.y += (0.78 - die.rotation.y) * 0.08;
          die.rotation.z += (-0.18 - die.rotation.z) * 0.08;
          die.position.y += (-0.2 - die.position.y) * 0.12;
          die.scale.setScalar(1 + Math.sin(finalReveal * Math.PI) * 0.13);
        } else {
          finalReveal = 0;
          impact = 0;
          die.rotation.x += 0.034 * speed;
          die.rotation.y += 0.052 * speed;
          die.rotation.z += 0.027 * speed;
          die.position.y = phaseState === "charging"
            ? Math.sin(t * 4.4) * 0.28
            : -0.15 + Math.abs(Math.sin(t * 7.2)) * 0.55;
          die.scale.setScalar(phaseState === "charging" ? 0.92 + Math.sin(t * 6) * 0.05 : 1.05);
          redrawNumber("?", phaseState === "charging" ? 0.04 : 0.12);
        }

        halo.rotation.z = t * (phaseState === "charging" ? 1.8 : 0.55);
        halo.scale.setScalar(1 + Math.sin(t * 3) * 0.04 + impact * 0.6);
        (halo.material as InstanceType<typeof THREE.MeshBasicMaterial>).opacity = 0.16 + Math.sin(t * 2.2) * 0.08 + (settled ? 0.22 : 0);
        dieMat.emissive.set(accentState);
        dieMat.emissiveIntensity = settled ? 0.52 + Math.sin(t * 5) * 0.08 : 0.24;
        edgeMat.color.set(accentState);
        light.color.set(accentState);
        light.intensity = phaseState === "charging" ? 5.7 + Math.sin(t * 8) : settled ? 6.4 : 4.6;

        renderer.render(scene, camera);
      };
      animate();

      const onResize = () => {
        if (disposed || !mount) return;
        camera.aspect = mount.clientWidth / mount.clientHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(mount.clientWidth, mount.clientHeight);
      };
      window.addEventListener("resize", onResize);

      sceneRef.current = {
        dispose: () => {
          disposed = true;
          cancelAnimationFrame(animationId);
          window.removeEventListener("resize", onResize);
          scene.traverse((obj) => {
            if (obj instanceof THREE.Mesh) {
              obj.geometry.dispose();
              if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
              else obj.material.dispose();
            }
          });
          edgeGeo.dispose();
          edgeMat.dispose();
          numberTexture.dispose();
          renderer.dispose();
          if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
        },
        setPhase: (v) => { phaseState = v; },
        setDice: (v) => { diceState = v; displayNumber = v?.total ?? displayNumber; },
        setAccent: (v) => { accentState = v; accent.set(v); },
      };
    });

    return () => {
      disposed = true;
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { sceneRef.current?.setPhase(phase); }, [phase]);
  useEffect(() => { sceneRef.current?.setDice(dice); }, [dice]);
  useEffect(() => { sceneRef.current?.setAccent(accentColor); }, [accentColor]);

  return <div className="dice-webgl-d20" ref={mountRef} aria-hidden="true" />;
}

function DiceOverlay({ event, charging, threeDEnabled = true }: { event?: DisplayEvent; charging?: boolean; threeDEnabled?: boolean }) {
  const dice = event?.dice;
  const [displayValue, setDisplayValue] = useState<number | string>("?");
  const [phase, setPhase] = useState<"charging" | "rolling" | "settled">("rolling");
  const accentColor = colorFromRollOwner(event);

  useEffect(() => {
    if (!dice) return;
    setPhase("rolling");
    setDisplayValue("?");
    const tumbleMs = 1100;
    const t = setTimeout(() => {
      setDisplayValue(dice.total);
      setPhase("settled");
      playDiceImpact();
    }, tumbleMs);
    return () => clearTimeout(t);
  }, [dice]);

  useEffect(() => {
    if (charging && phase === "rolling" && (!dice)) {
      setPhase("charging");
      setDisplayValue("?");
      playDiceCharge();
    }
    if (!charging && phase === "charging") {
      setPhase("rolling");
      stopDiceCharge();
    }
  }, [charging, phase, dice]);

  if (!dice && !charging) return null;

  const isVisible = Boolean(dice || charging);
  const phaseClass = phase;
  const rollMode = dice?.d20Mode && dice.d20Mode !== "normal" ? dice.d20Mode : undefined;
  const speaker = event?.speaker && event.speaker !== "Dice" ? event.speaker : "Fate";

  return (
    <div
      className={`dice-overlay epic ${phaseClass}`}
      key={dice ? `${dice.reason}-${dice.total}-${dice.rolls.join("-")}` : "charging-only"}
      style={{ "--roll-accent": accentColor } as CSSProperties}
    >
      <div className="dice-owner-chip">{speaker}</div>
      <div className="dice-stage">
        <div className="charge-ring r1" />
        <div className="charge-ring r2" />
        <svg className="charge-beams-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
          {Array.from({ length: 12 }).map((_, i) => {
            const angle = (i / 12) * Math.PI * 2;
            const x1 = 50 + Math.cos(angle) * 48;
            const y1 = 50 + Math.sin(angle) * 48;
            const x2 = 50 + Math.cos(angle) * 12;
            const y2 = 50 + Math.sin(angle) * 12;
            return (
              <line
                key={i}
                className={`charge-beam b${i + 1}`}
                x1={x1} y1={y1} x2={x2} y2={y2}
              />
            );
          })}
        </svg>
        {threeDEnabled ? (
          <ThreeJSD20Roll dice={dice} phase={phase} accentColor={accentColor} />
        ) : (
          <div className="dice-css-d20">
            <D20Spinner
              showNumber={phase !== "charging"}
              finalValue={phase === "settled" && dice ? dice.total : undefined}
            />
          </div>
        )}
        <div className="settle-shockwave" />
      </div>
      <div className="phase-label">
        {phase === "charging" && "Channeling fate"}
        {phase === "rolling" && "Rolling"}
        {phase === "settled" && "Fate decides"}
      </div>
      {dice && (
        <>
          <div className="dice-label">{dice.reason}</div>
          <div className="dice-total-readout">{displayValue}</div>
          <div className="small">{rollMode ? `${rollMode.toUpperCase()} | ` : ""}{dice.notation}: {dice.rolls.join(", ")}{dice.modifier ? ` ${dice.modifier > 0 ? "+" : ""}${dice.modifier}` : ""}</div>
        </>
      )}
    </div>
  );
}

function StatsBars({ stats }: { stats?: PlayerStat[] }) {
  if (!stats || stats.length === 0) return null;
  return (
    <div className="stats-bars-container">
      {stats.map((stat, i) => {
        const pct = Math.min(100, Math.max(0, (stat.value / stat.maxValue) * 100));
        let colorClass = "stat-bar-default";
        if (stat.color === "red" || stat.name.toLowerCase() === "hp" || stat.name.toLowerCase() === "health") colorClass = "stat-bar-red";
        else if (stat.color === "blue" || stat.name.toLowerCase() === "mana" || stat.name.toLowerCase() === "mp") colorClass = "stat-bar-blue";
        else if (stat.color === "green" || stat.name.toLowerCase() === "stamina" || stat.name.toLowerCase() === "energy") colorClass = "stat-bar-green";
        
        const style = stat.color && !["red", "blue", "green"].includes(stat.color) ? { backgroundColor: stat.color } : undefined;
        
        return (
          <div className="stat-row" key={`${stat.name}-${i}`}>
            <div className="stat-label-row">
              <span className="stat-name">{stat.name}</span>
              <span className="stat-values">{stat.value}/{stat.maxValue}</span>
            </div>
            <div className="stat-bar-bg">
              <div 
                className={`stat-bar-fill ${colorClass}`} 
                style={{ width: `${pct}%`, ...style }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function HostPartyBar({ campaign }: { campaign: Campaign }) {
  const activeNPCs = useMemo(() => {
    return (campaign.storyCharacters || []).filter((char) => {
      const hasStatus = typeof char.status === "string" && char.status.trim() !== "";
      const hasStats = Array.isArray(char.stats) && char.stats.length > 0;
      return hasStatus || hasStats;
    });
  }, [campaign.storyCharacters]);

  if (campaign.players.length === 0 && activeNPCs.length === 0) return null;

  return (
    <div className="host-party-bar">
      <div className="sidebar-section">
        <h3 className="sidebar-section-title">Party</h3>
        {campaign.players.map((player) => (
          <article 
            className="host-player-card" 
            key={player.id}
            style={player.color ? { borderColor: `${player.color}50`, boxShadow: `0 4px 15px ${player.color}15` } : undefined}
          >
            <Avatar portraitUrl={player.portraitUrl} name={player.characterName || player.name} />
            <div className="player-details">
              <strong style={player.color ? { color: player.color } : undefined}>
                {player.characterName || player.name}
              </strong>
              <span className="small">{player.status || "Ready"}</span>
              <StatsBars stats={player.stats} />
              {campaign.showPartyInventories && <span className="small block-stat">Items: {player.inventory.join(", ") || "None"}</span>}
              {campaign.showPartyAbilities && <span className="small block-stat">Abilities: {player.abilities.join(", ") || "None"}</span>}
            </div>
          </article>
        ))}
      </div>

      {activeNPCs.length > 0 && (
        <div className="sidebar-section npc-section">
          <h3 className="sidebar-section-title">NPCs & Foes</h3>
          {activeNPCs.map((npc) => (
            <article 
              className="host-player-card npc-card" 
              key={npc.id}
              style={npc.color ? { borderColor: `${npc.color}50`, boxShadow: `0 4px 15px ${npc.color}15` } : undefined}
            >
              <Avatar portraitUrl={npc.portraitUrl} name={npc.name} />
              <div className="player-details">
                <strong style={npc.color ? { color: npc.color } : undefined}>
                  {npc.name}
                </strong>
                <span className="small">{npc.status || "Active"}</span>
                <StatsBars stats={npc.stats} />
                {campaign.showNpcInventories && npc.inventory && npc.inventory.length > 0 && (
                  <span className="small block-stat">Items: {npc.inventory.join(", ")}</span>
                )}
                {campaign.showNpcAbilities && npc.abilities && npc.abilities.length > 0 && (
                  <span className="small block-stat">Abilities: {npc.abilities.join(", ")}</span>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function Avatar({ portraitUrl, name }: { portraitUrl?: string; name: string }) {
  if (portraitUrl) return <div className="avatar" style={{ backgroundImage: `url(${portraitUrl})` }} />;
  return <div className="avatar avatar-fallback">{name.slice(0, 2).toUpperCase()}</div>;
}

function LobbyRoster({ campaign }: { campaign: Campaign }) {
  return (
    <div className="lobby-roster">
      <h2>Gathering Party</h2>
      {campaign.players.length === 0 && <p className="small">No phones have joined yet.</p>}
      {campaign.players.map((player) => <span className="pill" key={player.id}>{player.characterName || player.name}{campaign.partyLeaderId === player.id ? " · leader" : ""}</span>)}
    </div>
  );
}

function HostAdminPanel({ campaign, setCampaign, busy, setBusy, error, setError }: {
  campaign: Campaign;
  setCampaign: (campaign: Campaign) => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  error: string;
  setError: (error: string) => void;
}) {
  const [imagePrompt, setImagePrompt] = useState("");
  const [guidance, setGuidance] = useState("");
  const [hostThreeDEnabled, setHostThreeDEnabled] = use3DEnabled();

  async function updateSetting(name: string, value: boolean) {
    const updated = { ...campaign, [name]: value };
    setCampaign(updated);
    try {
      const data = await fetchJson<{ campaign: Campaign }>("/api/party", {
        method: "POST",
        body: JSON.stringify({ campaignId: campaign.id, action: "updateSettings", [name]: value })
      });
      setCampaign(data.campaign);
    } catch (err) {
      setError(messageOf(err));
    }
  }

  async function makeImage() {
    const prompt = imagePrompt.trim() || (
      campaign.campaignType === "dnd"
        ? `Cinematic fantasy D&D scene background: ${campaign.currentScene}`
        : `Cinematic tabletop RPG scene background matching the campaign genre: ${campaign.currentScene}`
    );
    await runBusy(setBusy, setError, async () => {
      const data = await fetchJson<{ campaign: Campaign }>("/api/image", { method: "POST", body: JSON.stringify({ campaignId: campaign.id, prompt }) });
      setCampaign(data.campaign);
      setImagePrompt("");
    });
  }

  async function swayStory() {
    if (!guidance.trim()) return;
    await runBusy(setBusy, setError, async () => {
      const data = await fetchJson<{ campaign: Campaign }>("/api/party", { method: "POST", body: JSON.stringify({ campaignId: campaign.id, action: "sway", guidance }) });
      setCampaign(data.campaign);
      setGuidance("");
    });
  }



  return (
    <aside className="admin-panel">
      <h2>Party Controls</h2>
      <p className="small">Open on phones: <a href={controllerUrl(campaign.joinCode)} target="_blank" rel="noopener noreferrer" className="qr-link" style={{ textDecoration: "underline", color: "var(--gold)" }}>{controllerUrl(campaign.joinCode)}</a></p>
      <div className="form-grid">
        <label className="check-row">
          <input 
            type="checkbox" 
            checked={!!campaign.showPartyInventories} 
            onChange={(event) => updateSetting("showPartyInventories", event.target.checked)} 
          /> 
          Show party inventories on TV
        </label>
        <label className="check-row">
          <input 
            type="checkbox" 
            checked={!!campaign.showPartyAbilities} 
            onChange={(event) => updateSetting("showPartyAbilities", event.target.checked)} 
          /> 
          Show party abilities on TV
        </label>
        <label className="check-row">
          <input 
            type="checkbox" 
            checked={!!campaign.showNpcInventories} 
            onChange={(event) => updateSetting("showNpcInventories", event.target.checked)} 
          /> 
          Show NPC/Foe inventories on TV
        </label>
        <label className="check-row">
          <input 
            type="checkbox" 
            checked={!!campaign.showNpcAbilities} 
            onChange={(event) => updateSetting("showNpcAbilities", event.target.checked)} 
          /> 
          Show NPC/Foe abilities on TV
        </label>
        <label className="check-row">
          <input 
            type="checkbox" 
            checked={campaign.showQuestOnTV !== false} 
            onChange={(event) => updateSetting("showQuestOnTV", event.target.checked)} 
          /> 
          Show quest log on TV
        </label>
        <label className="check-row">
          <input 
            type="checkbox" 
            checked={campaign.showQuestOnController !== false} 
            onChange={(event) => updateSetting("showQuestOnController", event.target.checked)} 
          /> 
          Show quest log on controllers
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={hostThreeDEnabled}
            onChange={(event) => setHostThreeDEnabled(event.target.checked)}
          />
          3D effects (this screen)
        </label>
        <label>Scene image prompt<input value={imagePrompt} onChange={(event) => setImagePrompt(event.target.value)} placeholder="Optional manual image prompt" /></label>
        <button disabled={busy} onClick={makeImage}>Generate scene image</button>
        <label>Story guidance<textarea value={guidance} onChange={(event) => setGuidance(event.target.value)} placeholder="Privately steer the DM: make it darker, reveal an NPC clue, slow down combat..." /></label>
        <button disabled={busy} onClick={swayStory}>{busy ? "Thinking..." : "Sway story"}</button>
      </div>

      <Players campaign={campaign} />
      <div className="panel-scroll">
        <h3>Transcript</h3>
        {campaign.messages.slice(-12).map((message) => <div className="message" key={message.id}><strong>{message.name || message.role}</strong><br />{message.content}</div>)}
      </div>
      {error && <p className="small">{error}</p>}
    </aside>
  );
}

function ControllerView(props: {
  campaign: Campaign | null;
  campaigns: CampaignSummary[];
  refreshCampaigns: () => void;
  playerName: string;
  setPlayerName: (name: string) => void;
  localPlayer: Player | null;
  setLocalPlayer: (player: Player | null) => void;
  setCampaign: (campaign: Campaign | null) => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  error: string;
  setError: (error: string) => void;
}) {
  const [joinCode, setJoinCode] = useState("");
  const [threeDEnabled] = use3DEnabled();
  const threeJsDisabled = !threeDEnabled;

  const renderWithToggle = (node: React.ReactNode) => {
    return (
      <>
        {node}
        <ThreeDToggleButton />
      </>
    );
  };
  const [characterName, setCharacterName] = useState("");
  const [personality, setPersonality] = useState("");
  const [background, setBackground] = useState("");
  const [nickname, setNickname] = useState("Player");
  const [joining, setJoining] = useState(false);
  const joiningRef = useRef(false);

  const matchingCampaign = props.campaigns.find(
    (c) => c.joinCode === joinCode.trim().toUpperCase() || c.id === joinCode.trim()
  );
  const isSurpriseCampaign = !!matchingCampaign?.isRandomized;
  const hasValidJoinCode = !!matchingCampaign;

  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const [selectedCampaign, setSelectedCampaign] = useState<Campaign | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);

  const { refreshCampaigns } = props;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setJoinCode(params.get("code") || "");
    if (props.campaigns.length === 0) {
      refreshCampaigns();
    }
  }, [refreshCampaigns, props.campaigns.length]);

  async function selectCampaign(id: string) {
    setSelectedCampaignId(id);
    setLoadingDetails(true);
    props.setError("");
    try {
      const data = await fetchJson<{ campaign: Campaign }>(`/api/campaigns/${id}`);
      setSelectedCampaign(data.campaign);
    } catch (err) {
      props.setError(err instanceof Error ? err.message : "Failed to load campaign players");
    } finally {
      setLoadingDetails(false);
    }
  }

  async function performJoin(code: string, charName: string, pName: string, bg: string, pers?: string) {
    if (props.busy || joining || joiningRef.current) return;
    joiningRef.current = true;
    setJoining(true);
    await runBusy(props.setBusy, props.setError, async () => {
      const joined = await fetchJson<{ campaignId: string; player: Player; isPartyLeader: boolean }>("/api/join", {
        method: "POST",
        body: JSON.stringify({ joinCode: code, name: pName || charName, characterName: charName, background: bg, personality: pers })
      });
      props.setLocalPlayer(joined.player);
      const data = await fetchJson<{ campaign: Campaign }>(`/api/campaigns/${joined.campaignId}`);
      props.setCampaign(data.campaign);
    });
    setJoining(false);
    joiningRef.current = false;
  }

  async function generateOrImproveCharacterField(targetField: "characterName" | "personality" | "background") {
    await runBusy(props.setBusy, props.setError, async () => {
      const data = await fetchJson<{ result: { characterName: string; personality: string; background: string } }>("/api/generate", {
        method: "POST",
        body: JSON.stringify({
          type: "character",
          prompt: targetField === "background" ? background : (targetField === "personality" ? personality : ""),
          characterName: characterName,
          personality: personality,
          joinCode
        })
      });
      if (targetField === "characterName" || !characterName) {
        setCharacterName(data.result.characterName);
      }
      if (targetField === "personality" || !personality) {
        setPersonality(data.result.personality);
      }
      if (targetField === "background" || !background) {
        setBackground(data.result.background);
      }
    });
  }

  async function join(event: FormEvent) {
    event.preventDefault();
    if (isSurpriseCampaign) {
      await performJoin(joinCode, "", nickname, "", "");
    } else {
      await performJoin(joinCode, characterName, nickname, background, personality);
    }
  }

  if (joining || (props.busy && !props.localPlayer)) {
    return renderWithToggle(<JoinLoadingView campaign={props.campaign} localPlayer={props.localPlayer} threeJsDisabled={threeJsDisabled} />);
  }

  if (!props.campaign || !props.localPlayer) {
    if (selectedCampaignId) {
      return renderWithToggle(
        <section className="controller-card">
          <h1>Ongoing Campaign</h1>
          {loadingDetails ? (
            <p className="loading-status">Retrieving players and status...</p>
          ) : selectedCampaign ? (
            <div>
              <h2 style={{ color: "var(--gold)", margin: "0.25rem 0" }}>{selectedCampaign.title}</h2>
              <p className="small" style={{ marginBottom: "1.5rem" }}>Join Code: <strong>{selectedCampaign.joinCode}</strong></p>

              <h3>Rejoin as Character</h3>
              {selectedCampaign.players.length === 0 ? (
                <p className="small italic" style={{ margin: "1rem 0" }}>No characters in this campaign yet.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", margin: "1rem 0" }}>
                  {selectedCampaign.players.map((p) => (
                    <button
                      key={p.id}
                      disabled={props.busy}
                      onClick={() => performJoin(selectedCampaign.joinCode, p.characterName || p.name, p.name, p.background || "")}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "auto 1fr auto",
                        alignItems: "center",
                        gap: "1rem",
                        background: "rgba(255, 255, 255, 0.04)",
                        border: "1px solid rgba(255, 255, 255, 0.08)",
                        borderRadius: "14px",
                        padding: "0.75rem 1.2rem",
                        textAlign: "left",
                        width: "100%"
                      }}
                    >
                      <Avatar portraitUrl={p.portraitUrl} name={p.characterName || p.name} />
                      <div>
                        <strong style={p.color ? { color: p.color } : { color: "var(--gold)" }}>
                          {p.characterName || p.name}
                        </strong>
                        <span className="small block-stat" style={{ fontSize: "0.75rem", color: "var(--muted)", marginTop: "0.15rem" }}>
                          Status: {p.status || "Ready"}
                        </span>
                      </div>
                      <span style={{ fontSize: "1.2rem", color: "var(--gold)" }}>➜</span>
                    </button>
                  ))}
                </div>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginTop: "2rem" }}>
                <button
                  onClick={() => {
                    setJoinCode(selectedCampaign.joinCode);
                    setSelectedCampaignId(null);
                    setSelectedCampaign(null);
                  }}
                  style={{
                    background: "linear-gradient(135deg, rgba(217, 164, 65, 0.15), rgba(255, 255, 255, 0.04))",
                    borderColor: "var(--gold)",
                    color: "#fff5dc"
                  }}
                >
                  Join as a New Character
                </button>
                <button
                  onClick={() => {
                    setSelectedCampaignId(null);
                    setSelectedCampaign(null);
                    props.refreshCampaigns();
                  }}
                  style={{ background: "transparent", borderColor: "var(--line)", color: "var(--muted)" }}
                >
                  Back to Campaigns List
                </button>
              </div>
            </div>
          ) : (
            <div>
              <p className="small">Failed to load campaign details.</p>
              <button onClick={() => { setSelectedCampaignId(null); props.refreshCampaigns(); }} style={{ marginTop: "1rem" }}>
                Back
              </button>
            </div>
          )}
          {props.error && <p className="small" style={{ color: "var(--red)", marginTop: "1rem" }}>{props.error}</p>}
        </section>
      );
    }

    const activeCampaigns = props.campaigns.filter((c) => c.status === "active" && c.isHostActive);

    return renderWithToggle(
      <section className="controller-card">
        <h1>Join Adventure</h1>
        <form className="form-grid" onSubmit={join}>
          <div style={{ marginBottom: "1.2rem" }}>
            <label style={{ margin: 0 }}>Join code
              <input 
                value={joinCode} 
                required 
                onChange={(event) => setJoinCode(event.target.value.toUpperCase())} 
                placeholder="Enter campaign join code (e.g. ABCD)" 
              />
            </label>
            {!hasValidJoinCode && (
              <span style={{ fontSize: "0.8rem", color: "var(--muted)", display: "block", marginTop: "0.35rem" }}>
                ⚠️ Enter a valid Join Code first to get tailored ideas/suggestions from the campaign.
              </span>
            )}
            {hasValidJoinCode && (
              <span style={{ fontSize: "0.82rem", color: "var(--green)", display: "block", marginTop: "0.35rem", fontWeight: "500" }}>
                ✨ Connected to campaign: <strong>{matchingCampaign.title}</strong>
              </span>
            )}
          </div>

          {isSurpriseCampaign ? (
            <>
              <div 
                style={{ 
                  background: "rgba(217, 164, 65, 0.05)", 
                  border: "1px solid rgba(217, 164, 65, 0.2)", 
                  padding: "1rem", 
                  borderRadius: "14px", 
                  marginBottom: "0.5rem"
                }} 
              >
                <p style={{ margin: 0, fontWeight: "bold", color: "var(--gold)", display: "flex", alignItems: "center", gap: "0.5rem", fontFamily: "'Cinzel', Georgia, serif" }}>
                  🎲 Surprise Campaign Mode Active!
                </p>
                <p className="small" style={{ margin: "0.35rem 0 0 0", fontSize: "0.85rem", lineHeight: "1.3" }}>
                  The AI Dungeon Master will generate a completely randomized character name, backstory, traits, stats, and a portrait. Enter your player nickname and click Join!
                </p>
              </div>
              <label>Your nickname<input value={nickname} required onChange={(event) => setNickname(event.target.value)} placeholder="This isnt going to be used anyways. Just type anything!" /></label>
            </>
          ) : (
            <>
              <label>Your name<input value={nickname} required onChange={(event) => setNickname(event.target.value)} placeholder="Your player name" /></label>
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end", marginBottom: "0.5rem" }}>
                <label style={{ flex: 1, margin: 0 }}>Character name
                  <input value={characterName} required onChange={(event) => setCharacterName(event.target.value)} placeholder="E.g. Steve, Bob, Alice..." />
                </label>
                <button 
                  type="button" 
                  disabled={props.busy || !hasValidJoinCode} 
                  onClick={() => generateOrImproveCharacterField("characterName")}
                  className="generate-prompt-btn"
                  style={{ 
                    fontSize: "0.8rem", 
                    padding: "0.45rem 0.85rem", 
                    borderRadius: "10px", 
                    height: "fit-content", 
                    marginBottom: "0.5rem",
                    cursor: hasValidJoinCode ? "pointer" : "not-allowed",
                    background: "rgba(217, 164, 65, 0.08)",
                    border: "1px solid rgba(217, 164, 65, 0.35)",
                    color: "var(--gold)",
                    fontWeight: 600,
                    opacity: hasValidJoinCode ? 1 : 0.4
                  }}
                >
                  {characterName.trim() ? "✨ Improve" : "✍️ Suggest"}
                </button>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", marginBottom: "0.5rem" }}>
                <label style={{ margin: 0 }}>Personality (Traits, quirks, or flaws)
                  <textarea value={personality} onChange={(event) => setPersonality(event.target.value)} placeholder="E.g. Hot-headed but loyal, loves gold, scared of spiders..." style={{ height: "60px" }} />
                </label>
                <button 
                  type="button" 
                  disabled={props.busy || !hasValidJoinCode} 
                  onClick={() => generateOrImproveCharacterField("personality")}
                  className="generate-prompt-btn"
                  style={{ 
                    fontSize: "0.8rem", 
                    padding: "0.45rem 0.85rem", 
                    borderRadius: "10px", 
                    alignSelf: "flex-start",
                    cursor: hasValidJoinCode ? "pointer" : "not-allowed",
                    background: "rgba(217, 164, 65, 0.08)",
                    border: "1px solid rgba(217, 164, 65, 0.35)",
                    color: "var(--gold)",
                    fontWeight: 600,
                    opacity: hasValidJoinCode ? 1 : 0.4
                  }}
                >
                  {personality.trim() ? "✨ Improve Personality" : "✍️ Write Personality"}
                </button>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", marginBottom: "0.5rem" }}>
                <label style={{ margin: 0 }}>Your background (Story, history, or goals)
                  <textarea value={background} onChange={(event) => setBackground(event.target.value)} placeholder="Describe who your character is, their goals, or their traits to help the DM integrate you." style={{ height: "80px" }} />
                </label>
                <button 
                  type="button" 
                  disabled={props.busy || !hasValidJoinCode} 
                  onClick={() => generateOrImproveCharacterField("background")}
                  className="generate-prompt-btn"
                  style={{ 
                    fontSize: "0.8rem", 
                    padding: "0.45rem 0.85rem", 
                    borderRadius: "10px", 
                    alignSelf: "flex-start",
                    cursor: hasValidJoinCode ? "pointer" : "not-allowed",
                    background: "rgba(217, 164, 65, 0.08)",
                    border: "1px solid rgba(217, 164, 65, 0.35)",
                    color: "var(--gold)",
                    fontWeight: 600,
                    opacity: hasValidJoinCode ? 1 : 0.4
                  }}
                >
                  {background.trim() ? "✨ Improve Background" : "✍️ Write Background"}
                </button>
              </div>
            </>
          )}
          <button disabled={props.busy}>{props.busy ? "Joining..." : "Join"}</button>
        </form>
        {props.error && <p className="small" style={{ color: "var(--red)", marginTop: "1rem" }}>{props.error}</p>}

        {activeCampaigns.length > 0 && (
          <div style={{ marginTop: "2rem", borderTop: "1px solid var(--line)", paddingTop: "1.5rem" }}>
            <h2 style={{ fontSize: "1.2rem", margin: "0 0 1rem 0", color: "var(--gold)", letterSpacing: "0.05em" }}>Ongoing Campaigns</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
              {activeCampaigns.map((c) => (
                <button
                  key={c.id}
                  onClick={() => selectCampaign(c.id)}
                  style={{
                    background: "rgba(255, 255, 255, 0.04)",
                    border: "1px solid rgba(255, 255, 255, 0.08)",
                    borderRadius: "14px",
                    padding: "0.85rem 1.2rem",
                    textAlign: "left",
                    width: "100%",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center"
                  }}
                >
                  <div>
                    <strong style={{ display: "block", color: "var(--text)" }}>{c.title}</strong>
                    <span className="small" style={{ fontSize: "0.78rem" }}>
                      {c.playerCount} players · Join code: {c.joinCode}
                    </span>
                  </div>
                  <span style={{ color: "var(--gold)", fontSize: "1.1rem" }}>➜</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </section>
    );
  }

  const activePlayer = props.campaign.players.find((player) => player.id === props.localPlayer?.id) || props.localPlayer;

  const isInitialIntro = !props.campaign.displayEvents.some(
    (e) => e.type === "narration" || e.type === "dialogue"
  );
  const isInitialLoading = props.campaign.status === "active" && isInitialIntro && props.campaign.dmStatus;
  const isLocalPlayerGenerating = activePlayer && activePlayer.status === "Generating profile..." && props.campaign.dmStatus;
  const isOtherPlayerGenerating = !isLocalPlayerGenerating && props.campaign.players.some((p) => p.status === "Generating profile...") && props.campaign.dmStatus;

  if (isInitialLoading) {
    return renderWithToggle(
      <JoinLoadingView
        title={props.campaign.campaignType === "tabletop" ? "Starting Story..." : "Starting Campaign..."}
        status={props.campaign.dmStatus || `The ${flavorOf(props.campaign.campaignType).dmName} is preparing the initial scenario...`}
        campaign={props.campaign}
        localPlayer={activePlayer}
        threeJsDisabled={threeJsDisabled}
      />
    );
  }

  const hasLocalPlayerError = activePlayer && activePlayer.status?.startsWith("Error:");

  if (hasLocalPlayerError) {
    return renderWithToggle(
      <section className="controller-card error-card">
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: "1rem" }}>
          <div style={{ fontSize: "3rem" }}>⚠️</div>
          <h1 style={{ color: "var(--red)", fontFamily: "'Cinzel', Georgia, serif", margin: 0 }}>Generation Failed</h1>
          <p className="small" style={{ color: "var(--muted)", margin: 0 }}>
            Something went wrong while the Dungeon Master was forging your character sheet.
          </p>
          <div 
            style={{ 
              background: "rgba(239, 68, 68, 0.04)", 
              border: "1px solid rgba(239, 68, 68, 0.15)", 
              padding: "1rem", 
              borderRadius: "14px", 
              width: "100%",
              margin: "0.5rem 0",
              fontSize: "0.85rem",
              lineHeight: "1.4",
              textAlign: "left"
            }}
          >
            <strong style={{ color: "var(--red)" }}>Details:</strong>
            <p style={{ margin: "0.25rem 0 0 0", color: "#ffa3a3", fontFamily: "monospace", overflowWrap: "break-word" }}>
              {activePlayer.notes || activePlayer.status}
            </p>
          </div>
          <button 
            onClick={() => {
              props.setCampaign(null);
              props.setLocalPlayer(null);
            }}
            style={{
              background: "linear-gradient(135deg, rgba(217, 164, 65, 0.15), rgba(255, 255, 255, 0.04))",
              borderColor: "var(--gold)",
              color: "#fff5dc",
              width: "100%",
              marginTop: "1rem"
            }}
          >
            Try Rejoining
          </button>
        </div>
      </section>
    );
  }

  if (isLocalPlayerGenerating) {
    const isSurprise = props.campaign?.isRandomized;
    return renderWithToggle(
      <JoinLoadingView 
        title={isSurprise ? "Forging Your Character Sheet..." : "Setting Up Character..."}
        status={props.campaign?.dmStatus || `The ${flavorOf(props.campaign?.campaignType).dmName} is ${isSurprise ? "rolling character traits and painting a custom portrait..." : "reviewing your background and forging your character sheet..."}`}
        campaign={props.campaign}
        localPlayer={activePlayer}
        threeJsDisabled={threeJsDisabled}
      />
    );
  }

  if (isOtherPlayerGenerating) {
    return renderWithToggle(
      <JoinLoadingView 
        title="Party Member Joining..." 
        status={props.campaign.dmStatus || `The ${flavorOf(props.campaign.campaignType).dmName} is integrating a new adventurer...`}
        campaign={props.campaign}
        localPlayer={activePlayer}
        threeJsDisabled={threeJsDisabled}
      />
    );
  }

  if (props.campaign.status === "lobby") {
    return renderWithToggle(<PhoneLobby campaign={props.campaign} player={activePlayer} setCampaign={props.setCampaign} busy={props.busy} setBusy={props.setBusy} error={props.error} setError={props.setError} threeJsDisabled={threeJsDisabled} />);
  }

  return <PhoneController campaign={props.campaign} player={activePlayer} setCampaign={props.setCampaign} busy={props.busy} setBusy={props.setBusy} error={props.error} setError={props.setError} />;
}

function PhoneLobby({
  campaign,
  player,
  setCampaign,
  busy,
  setBusy,
  error,
  setError,
  threeJsDisabled,
}: {
  campaign: Campaign;
  player: Player;
  setCampaign: (campaign: Campaign) => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  error: string;
  setError: (error: string) => void;
  threeJsDisabled?: boolean;
}) {
  const isLeader = campaign.partyLeaderId === player.id;
  const startingRef = useRef(false);
  async function start() {
    if (busy || startingRef.current) return;
    startingRef.current = true;
    await runBusy(setBusy, setError, async () => {
      const data = await fetchJson<{ campaign: Campaign }>("/api/party", { method: "POST", body: JSON.stringify({ campaignId: campaign.id, action: "start", playerId: player.id }) });
      setCampaign(data.campaign);
    });
    startingRef.current = false;
  }

  const portalPlayers = useMemo<PortalPlayer[]>(
    () => campaign.players.map((p) => ({ id: p.id, color: p.color })),
    [campaign.players]
  );

  return (
    <section className={`controller-card phone-lobby-card ${!threeJsDisabled ? "has-3d" : ""}`}>
      {!threeJsDisabled && (
        <div className="controller-3d-bg">
          <CinematicPortalScene
            isActive={false}
            mode="lobby"
            stepProgress={0}
            phaseKey="signal"
            players={portalPlayers}
            localPlayerId={player.id}
          />
        </div>
      )}
      <div className="phone-lobby-glow" aria-hidden="true" />
      <span className="phone-lobby-kicker">Party Lobby</span>
      <h1>{campaign.title}</h1>
      <p className="small">Waiting for the party to gather. When the leader starts, this screen will fold into the campaign loading ritual.</p>
      <div className="phone-lobby-code">Code {campaign.joinCode}</div>
      <Players campaign={campaign} playerId={player.id} />
      {isLeader ? <button disabled={busy || campaign.players.length === 0} onClick={start}>{busy ? "Opening..." : "Start campaign"}</button> : <p className="small">The party leader will start the campaign.</p>}
      {error && <p className="small">{error}</p>}
    </section>
  );
}

function PhoneController({ campaign, player, setCampaign, busy, setBusy, error, setError }: {
  campaign: Campaign;
  player: Player;
  setCampaign: (campaign: Campaign) => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  error: string;
  setError: (error: string) => void;
}) {
  const [action, setAction] = useState("");
  const [controllerTab, setControllerTab] = useState<"sheet" | "quest">("sheet");
  const pendingActionRef = useRef(false);

  useEffect(() => {
    if (campaign.showQuestOnController === false && controllerTab === "quest") {
      setControllerTab("sheet");
    }
  }, [campaign.showQuestOnController, controllerTab]);

  async function sendAction(value = action, displayValue?: string) {
    if (busy || pendingActionRef.current) return;
    const val = value || action;
    if (!val.trim()) return;
    pendingActionRef.current = true;
    const actionId = "act_" + Date.now() + "_" + Math.random().toString(36).substring(2, 10);
    await runBusy(setBusy, setError, async () => {
      const data = await fetchJson<{ campaign: Campaign }>("/api/chat", {
        method: "POST",
        body: JSON.stringify({ 
          campaignId: campaign.id, 
          playerId: player.id, 
          action: val,
          displayAction: displayValue,
          actionId
        })
      });
      setCampaign(data.campaign);
      setAction("");
    });
    pendingActionRef.current = false;
  }

  const actions = controllerActions(campaign, player);
  const hasActions = actions.length > 0;

  return (
    <section className="controller-card phone-controller">
      <div style={{ display: "flex", gap: "1rem", alignItems: "center", marginBottom: "0.5rem" }}>
        <Avatar portraitUrl={player.portraitUrl} name={player.characterName || player.name} />
        <div>
          <h1 style={{ margin: 0, fontSize: "1.5rem" }}>{campaign.title}</h1>
          <p className="small" style={{ margin: 0 }}>Playing as <strong style={player.color ? { color: player.color } : { color: "var(--gold)" }}>{player.characterName || player.name}</strong></p>
        </div>
      </div>
      
      {hasActions ? (
        <>
          <p className="controller-status">Choose an action here, then watch it play out on the TV.</p>
          <div className="suggestion-list action-cards">
            {actions.map((suggestion) => (
              <button 
                key={`${suggestion.title}-${suggestion.prompt}`} 
                disabled={busy} 
                onClick={() => sendAction(actionPrompt(suggestion))}
              >
                {suggestion.title}
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="stunned-notice">
          <p className="controller-status warning-text">⚠️ No actions available (e.g. Stunned / Staggered / Skip a turn).</p>
          <button className="skip-turn-button" disabled={busy} onClick={() => sendAction("I skip my turn (stunned / no actions available).")}>
            {busy ? "Thinking..." : "Skip Turn"}
          </button>
        </div>
      )}

      <label>Freeform action
        <textarea 
          value={action} 
          disabled={!hasActions || busy} 
          onChange={(event) => setAction(event.target.value)} 
          placeholder={hasActions ? "Describe what you do, say, inspect, cast, attempt, or ask." : "Actions disabled."} 
        />
      </label>
      {busy && (
        <div className="controller-rolling-pulse" role="status" aria-live="polite">
          <span>🎲 Rolling on TV</span>
          <span className="pulse-dots" aria-hidden="true">
            <span /><span /><span />
          </span>
        </div>
      )}
      <button disabled={busy || !hasActions || !action.trim()} onClick={() => sendAction()}>
        {busy ? "Thinking..." : "Send action"}
      </button>

      <div className="controller-tabs" style={{ display: "flex", gap: "0.5rem", marginTop: "1.5rem", borderBottom: "1px solid var(--line)", paddingBottom: "0.5rem" }}>
        <button 
          onClick={() => setControllerTab("sheet")} 
          type="button"
          style={{ 
            flex: 1, 
            padding: "0.5rem", 
            borderRadius: "8px", 
            background: controllerTab === "sheet" ? "rgba(217, 164, 65, 0.15)" : "transparent",
            borderColor: controllerTab === "sheet" ? "var(--gold)" : "transparent",
            color: controllerTab === "sheet" ? "var(--gold)" : "var(--muted)",
            borderStyle: "solid",
            borderWidth: "1px",
            fontSize: "0.85rem",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            fontWeight: "bold",
            cursor: "pointer"
          }}
        >
          📜 Sheet
        </button>
        {campaign.showQuestOnController !== false && (
          <button 
            onClick={() => setControllerTab("quest")} 
            type="button"
            style={{ 
              flex: 1, 
              padding: "0.5rem", 
              borderRadius: "8px", 
              background: controllerTab === "quest" ? "rgba(217, 164, 65, 0.15)" : "transparent",
              borderColor: controllerTab === "quest" ? "var(--gold)" : "transparent",
              color: controllerTab === "quest" ? "var(--gold)" : "var(--muted)",
              borderStyle: "solid",
              borderWidth: "1px",
              fontSize: "0.85rem",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              fontWeight: "bold",
              cursor: "pointer"
            }}
          >
            ⚔️ Quest Log
          </button>
        )}
      </div>

      {controllerTab === "sheet" || campaign.showQuestOnController === false ? (
        <PrivateSheet player={player} />
      ) : (
        <div className="private-sheet mobile-quest-log" style={{ marginTop: "1rem" }}>
          <h3>Quest Log</h3>
          {campaign.questLog ? (
            parseQuestLog(campaign.questLog)
          ) : (
            <p className="small italic" style={{ color: "var(--muted)", textAlign: "center", padding: "1.5rem 0" }}>
              No quests logged by the DM yet.
            </p>
          )}
        </div>
      )}

      {error && <p className="small">{error}</p>}
    </section>
  );
}

function PrivateSheet({ player }: { player: Player }) {
  return (
    <div className="private-sheet">
      <h3>Your Sheet</h3>
      <p className="small">Status: {player.status || "Ready"}</p>
      <StatsBars stats={player.stats} />
      <p className="small" style={{ marginTop: "0.5rem" }}>Inventory: {player.inventory.join(", ") || "Empty"}</p>
      <p className="small">Abilities: {player.abilities.join(", ") || "None noted"}</p>
      {player.notes && <p className="small">Notes: {player.notes}</p>}
    </div>
  );
}

function Players({ campaign, playerId }: { campaign: Campaign; playerId?: string }) {
  const displayedPlayers = playerId
    ? campaign.players.filter((p) => p.id === playerId)
    : campaign.players;

  return (
    <div style={{ marginTop: "1rem" }}>
      <h3 style={{ borderBottom: "1px solid rgba(217,164,65,0.2)", paddingBottom: "0.5rem", color: "var(--gold)", letterSpacing: "0.1em", textTransform: "uppercase", fontSize: "0.9rem" }}>Party</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem", marginTop: "0.75rem" }}>
        {displayedPlayers.map((player) => (
          <div 
            key={player.id} 
            className="player-roster-card"
            style={{
              display: "grid",
              gridTemplateColumns: "3.2rem 1fr",
              gap: "0.8rem",
              alignItems: "start",
              border: "1px solid rgba(255,255,255,0.06)",
              borderRadius: "14px",
              background: "rgba(255,255,255,0.02)",
              padding: "0.75rem"
            }}
          >
            <Avatar portraitUrl={player.portraitUrl} name={player.characterName || player.name} />
            <div className="player-details">
              <strong style={player.color ? { color: player.color } : { color: "var(--gold)" }}>
                {player.characterName || player.name}{campaign.partyLeaderId === player.id ? " (Leader)" : ""}
              </strong>
              {player.background && <p className="small" style={{ margin: "0.25rem 0", fontSize: "0.85rem", color: "var(--muted)" }}>Background: {player.background}</p>}
              <StatsBars stats={player.stats} />
              <div style={{ marginTop: "0.5rem", display: "flex", flexDirection: "column", gap: "0.15rem" }}>
                <span className="small" style={{ fontSize: "0.8rem", color: "var(--muted)", display: "block" }}>Inventory: {player.inventory.join(", ") || "Empty"}</span>
                <span className="small" style={{ fontSize: "0.8rem", color: "var(--muted)", display: "block" }}>Abilities: {player.abilities.join(", ") || "None"}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers || {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data as T;
}

let globalPending = false;

async function runBusy(setBusy: (busy: boolean) => void, setError: (error: string) => void, action: () => Promise<void>) {
  if (globalPending) return;
  globalPending = true;
  setBusy(true);
  setError("");
  try {
    await action();
  } catch (err) {
    setError(messageOf(err));
  } finally {
    setBusy(false);
    globalPending = false;
  }
}

function controllerUrl(joinCode: string) {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.href);
  url.search = `?controller=1&code=${encodeURIComponent(joinCode)}`;
  return url.toString();
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

function splitList(value: string) {
  return value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
}

function actionPrompt(action: SuggestedAction) {
  return action.prompt || action.title;
}

function controllerActions(campaign: Campaign, player: Player) {
  const playerActions = campaign.playerActions[player.id] || campaign.suggestedActions || [];
  const partyActions = campaign.partyActions || [];
  const seen = new Set<string>();
  return [...playerActions, ...partyActions].filter((action) => {
    const key = `${action.title}:${action.prompt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function latestDisplayEvent(events: DisplayEvent[]) {
  return [...events].reverse().find((event) => event.type !== "dice" && (event.content || event.dice));
}

function latestDiceEvent(events: DisplayEvent[]) {
  return [...events].reverse().find((event) => event.type === "dice" && event.dice);
}

const ControllerMiniD20 = ({ className }: { className: string }) => (
  <div className={className} aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
      <polygon points="12,2 22,7 22,17 12,22 2,17 2,7" stroke="rgba(217, 164, 65, 0.85)" fill="rgba(217, 164, 65, 0.15)" />
      <line x1="12" y1="2" x2="12" y2="7" stroke="rgba(217, 164, 65, 0.85)" />
      <line x1="22" y1="7" x2="12" y2="7" stroke="rgba(217, 164, 65, 0.85)" />
      <line x1="2" y1="7" x2="12" y2="7" stroke="rgba(217, 164, 65, 0.85)" />
      <line x1="22" y1="7" x2="18" y2="16" stroke="rgba(217, 164, 65, 0.85)" />
      <line x1="22" y1="17" x2="18" y2="16" stroke="rgba(217, 164, 65, 0.85)" />
      <line x1="12" y1="22" x2="18" y2="16" stroke="rgba(217, 164, 65, 0.85)" />
      <line x1="12" y1="22" x2="6" y2="16" stroke="rgba(217, 164, 65, 0.85)" />
      <line x1="2" y1="17" x2="6" y2="16" stroke="rgba(217, 164, 65, 0.85)" />
      <line x1="2" y1="7" x2="6" y2="16" stroke="rgba(217, 164, 65, 0.85)" />
      <line x1="12" y1="7" x2="18" y2="16" stroke="rgba(217, 164, 65, 0.85)" />
      <line x1="18" y1="16" x2="6" y2="16" stroke="rgba(217, 164, 65, 0.85)" />
      <line x1="6" y1="16" x2="12" y2="7" stroke="rgba(217, 164, 65, 0.85)" />
    </svg>
  </div>
);

function JoinLoadingView({
  title,
  status,
  campaign,
  localPlayer,
  threeJsDisabled,
}: {
  title?: string;
  status?: string;
  campaign?: Campaign | null;
  localPlayer?: Player | null;
  threeJsDisabled?: boolean;
} = {}) {
  const mode = campaign ? getHostLoadingMode(campaign) : "initial";
  const flavor = flavorOf(campaign?.campaignType);
  const phases = getHostPhases(mode);
  const currentStep = campaign ? getHostPhaseIndex(mode, status || "", campaign.dmPhase) : 0;
  const stepProgress = mode === "lobby" ? 0 : Math.min(1, currentStep / Math.max(1, phases.length - 1));
  const displayProgress = useSmoothedProgress(
    stepProgress,
    Math.min(1, stepProgress + 0.6 / Math.max(1, phases.length - 1))
  );
  const activePhase = phases[currentStep] || phases[0];

  const portalPlayers = useMemo<PortalPlayer[]>(
    () => (campaign ? campaign.players.map((p) => ({ id: p.id, color: p.color })) : []),
    [campaign]
  );

  return (
    <section className={`controller-card join-loading-card controller-loading-screen ${!threeJsDisabled ? "has-3d" : ""}`}>
      {!threeJsDisabled && (
        <div className="controller-3d-bg">
          <CinematicPortalScene
            isActive={true}
            mode={mode}
            stepProgress={displayProgress}
            phaseKey={activePhase?.key || "signal"}
            players={portalPlayers}
            localPlayerId={localPlayer?.id}
          />
        </div>
      )}
      {threeJsDisabled ? (
        <div className="spinner-container controller-spinner-stage" style={{ minHeight: "150px" }}>
          <D20Spinner />
        </div>
      ) : (
        <div className="controller-3d-spacer" />
      )}
      <h2>{title || "Setting Up Character..."}</h2>
      <p className="loading-status">{status || `The ${flavor.dmName} is reviewing your background and forging your character sheet...`}</p>
      <div className="controller-progress" role="progressbar" aria-valuenow={Math.round(displayProgress * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div className="controller-progress-bar"><div className="controller-progress-fill" style={{ width: `${displayProgress * 100}%` }} /></div>
        <span className="controller-progress-pct">{Math.round(displayProgress * 100)}%</span>
      </div>
      <StatusTimeline status={status || ""} mode="character" />
      <CyclingTipBox variant={themeOf(campaign)} />
    </section>
  );
}

function parseQuestLog(content: string): React.ReactNode {
  if (!content) return null;
  const lines = content.split("\n");
  
  return (
    <div className="quest-log-parsed">
      {lines.map((line, idx) => {
        const trimmed = line.trim();
        if (!trimmed) return <div key={idx} className="quest-empty-line" />;
        
        // H1 header
        if (trimmed.startsWith("# ")) {
          return (
            <h3 key={idx} className="quest-header quest-h1">
              {trimmed.slice(2)}
            </h3>
          );
        }
        // H2 header
        if (trimmed.startsWith("## ")) {
          return (
            <h4 key={idx} className="quest-header quest-h2">
              {trimmed.slice(3)}
            </h4>
          );
        }
        // H3 header
        if (trimmed.startsWith("### ")) {
          return (
            <h5 key={idx} className="quest-header quest-h3">
              {trimmed.slice(4)}
            </h5>
          );
        }
        
        // Checkboxes
        const checkboxMatch = trimmed.match(/^-\s*\[([ xX])\]\s*(.*)/);
        if (checkboxMatch) {
          const checked = checkboxMatch[1].toLowerCase() === "x";
          const text = checkboxMatch[2];
          return (
            <div key={idx} className={`quest-item quest-todo ${checked ? "completed" : "pending"}`}>
              <span className="quest-check-icon">{checked ? "✓" : "◇"}</span>
              <span className="quest-todo-text">{formatContent(text)}</span>
            </div>
          );
        }

        // Standard bullet point
        if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
          return (
            <div key={idx} className="quest-item quest-bullet">
              <span className="quest-bullet-icon">✦</span>
              <span className="quest-bullet-text">{formatContent(trimmed.slice(2))}</span>
            </div>
          );
        }

        // Default paragraph
        return (
          <p key={idx} className="quest-paragraph">
            {formatContent(trimmed)}
          </p>
        );
      })}
    </div>
  );
}

function LobbyBGM() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const fadeIntervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    let active = true;
    let audio: HTMLAudioElement | null = null;
    let tracks: string[] = [];

    const handleEnded = () => {
      // Pause for 3 seconds before playing another random track
      setTimeout(() => {
        if (!audioRef.current || !active || tracks.length === 0) return;
        const nextTrack = tracks[Math.floor(Math.random() * tracks.length)];
        audioRef.current.src = nextTrack;
        audioRef.current.volume = 1.0;
        audioRef.current.load();
        audioRef.current.play().catch(err => console.log("BGM loop playback failed:", err));
      }, 3000);
    };

    const startPlay = () => {
      if (audioRef.current && !audioRef.current.paused) {
        setIsPlaying(true);
      } else if (audioRef.current) {
        audioRef.current.volume = 1.0;
        audioRef.current.play()
          .then(() => setIsPlaying(true))
          .catch(err => console.log("BGM playback failed on interaction:", err));
      }
      window.removeEventListener("click", startPlay);
      window.removeEventListener("keydown", startPlay);
    };

    fetch("/api/music")
      .then((res) => res.json())
      .then((data) => {
        if (!active) return;
        tracks = Array.isArray(data.tracks) && data.tracks.length > 0
          ? data.tracks
          : ["/music/BGM/Before_the_Gate_Opens (BGM).mp3"];

        const selectedTrack = tracks[Math.floor(Math.random() * tracks.length)];
        audio = new Audio(selectedTrack);
        audio.loop = false;
        audioRef.current = audio;
        audio.addEventListener("ended", handleEnded);

        // Try autoplay
        audio.play()
          .then(() => setIsPlaying(true))
          .catch(() => {
            console.log("Autoplay blocked. BGM waiting for user interaction.");
          });

        window.addEventListener("click", startPlay);
        window.addEventListener("keydown", startPlay);
      })
      .catch((err) => {
        console.error("Failed to load BGM list:", err);
      });

    return () => {
      active = false;
      window.removeEventListener("click", startPlay);
      window.removeEventListener("keydown", startPlay);

      if (audio) {
        const activeAudio = audio;
        activeAudio.removeEventListener("ended", handleEnded);

        // Gracefully fade out on unmount/termination
        if (fadeIntervalRef.current) clearInterval(fadeIntervalRef.current);
        
        const fadeDuration = 1500;
        const startVolume = activeAudio.volume;
        const steps = 15;
        const intervalMs = fadeDuration / steps;
        const volumeStep = startVolume / steps;
        let currentStep = 0;

        const fadeInterval = setInterval(() => {
          currentStep++;
          const nextVolume = Math.max(0, startVolume - (volumeStep * currentStep));
          activeAudio.volume = nextVolume;

          if (currentStep >= steps || nextVolume <= 0) {
            clearInterval(fadeInterval);
            activeAudio.pause();
          }
        }, intervalMs);
      }
    };
  }, []);

  const togglePlay = () => {
    if (!audioRef.current) return;
    
    if (isPlaying) {
      // Fade out and pause
      if (fadeIntervalRef.current) clearInterval(fadeIntervalRef.current);
      
      const audio = audioRef.current;
      const fadeDuration = 1000;
      const startVolume = audio.volume;
      const steps = 10;
      const intervalMs = fadeDuration / steps;
      const volumeStep = startVolume / steps;
      let currentStep = 0;

      fadeIntervalRef.current = setInterval(() => {
        currentStep++;
        const nextVolume = Math.max(0, startVolume - (volumeStep * currentStep));
        audio.volume = nextVolume;

        if (currentStep >= steps || nextVolume <= 0) {
          if (fadeIntervalRef.current) clearInterval(fadeIntervalRef.current);
          audio.pause();
          setIsPlaying(false);
          audio.volume = 1.0; // Reset volume for next play
        }
      }, intervalMs);
    } else {
      // Play and fade in
      if (fadeIntervalRef.current) clearInterval(fadeIntervalRef.current);
      
      const audio = audioRef.current;
      audio.volume = 0.0;
      audio.play()
        .then(() => {
          setIsPlaying(true);
          const fadeDuration = 1000;
          const steps = 10;
          const intervalMs = fadeDuration / steps;
          const volumeStep = 1.0 / steps;
          let currentStep = 0;

          fadeIntervalRef.current = setInterval(() => {
            currentStep++;
            const nextVolume = Math.min(1.0, volumeStep * currentStep);
            audio.volume = nextVolume;

            if (currentStep >= steps || nextVolume >= 1.0) {
              if (fadeIntervalRef.current) clearInterval(fadeIntervalRef.current);
              audio.volume = 1.0;
            }
          }, intervalMs);
        })
        .catch(err => console.log("Failed to play BGM:", err));
    }
  };

  return (
    <button 
      onClick={togglePlay}
      className="bgm-mute-button"
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "rgba(217, 164, 65, 0.15)";
        e.currentTarget.style.borderColor = "var(--gold)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "rgba(20, 15, 30, 0.65)";
        e.currentTarget.style.borderColor = "rgba(217, 164, 65, 0.35)";
      }}
      style={{
        position: "fixed",
        top: "2rem",
        right: "2rem",
        zIndex: 99999,
        background: "rgba(20, 15, 30, 0.65)",
        border: "1px solid rgba(217, 164, 65, 0.35)",
        borderRadius: "99px",
        color: "var(--gold)",
        padding: "0.5rem 1rem",
        fontSize: "0.8rem",
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        cursor: "pointer",
        transition: "all 0.2s ease",
        fontFamily: "inherit"
      }}
    >
      {isPlaying ? "🔊 Music On" : "🔇 Music Off"}
    </button>
  );
}
