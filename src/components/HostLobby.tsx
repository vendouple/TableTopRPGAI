"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { api, accentColor, Campaign } from "@/lib/client/api";
import { playSfx } from "@/lib/client/sfx";
import WorldForge from "@/components/three/WorldForge";
import { themeVisual, ThemeKey } from "@/components/three/themeVisuals";

/**
 * The Gathering. The TV shows the table code like an inscription over a
 * summoning circle; as each phone joins, a hero card materializes with its
 * portrait being forged live by the Weaver.
 */
export default function HostLobby({ campaign, theme }: { campaign: Campaign; theme?: ThemeKey | string | null }) {
  const visual = themeVisual(theme);
  const [joinUrl, setJoinUrl] = useState("");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const partySizeRef = useRef(campaign.players.length);

  useEffect(() => {
    setJoinUrl(`${window.location.origin}/?controller=1&code=${campaign.joinCode}`);
  }, [campaign.joinCode]);

  // A soft chime as each hero materializes.
  useEffect(() => {
    if (campaign.players.length > partySizeRef.current) playSfx("join");
    partySizeRef.current = campaign.players.length;
  }, [campaign.players.length]);

  const leader = useMemo(
    () => campaign.players.find((player) => player.id === campaign.partyLeaderId),
    [campaign.players, campaign.partyLeaderId]
  );
  const ready = campaign.players.length > 0;

  const beginFromTable = async () => {
    if (!leader) return;
    setStarting(true);
    setStartError(null);
    try {
      await api.party({ campaignId: campaign.id, action: "start", playerId: leader.id });
    } catch (err) {
      setStartError(err instanceof Error ? err.message : "The summons failed. Try again.");
      setStarting(false);
    }
  };

  return (
    <div className="lobby screen" data-music-theme={visual.key}>
      {/* The unforged world: its fragments drift as wireframe ghosts, charging
          a little brighter with every hero who takes a seat. */}
      <WorldForge mode="lobby" drama={0.3 + Math.min(campaign.players.length * 0.14, 0.65)} theme={visual.key} />
      <div className="portal-veil" />

      <header className="lobby-mast">
        <span className="lobby-kicker">{campaign.campaignType === "dnd" ? "A Dungeons & Dragons tale" : "A story-engine tale"}</span>
        <h1 className="lobby-title">{campaign.isRandomized ? "A Sealed Legend" : campaign.title}</h1>
        {!campaign.isRandomized && campaign.startingStory ? (
          <p className="lobby-premise">{campaign.startingStory.slice(0, 260)}{campaign.startingStory.length > 260 ? "…" : ""}</p>
        ) : campaign.isRandomized ? (
          <p className="lobby-premise">The envelope stays sealed until every seat is taken. Not even the host knows what waits inside.</p>
        ) : null}
      </header>

      <main className="lobby-main">
        <section className="lobby-summons panel">
          <span className="summons-label">Take your seat</span>
          <div className="join-code" aria-label={`Join code ${campaign.joinCode}`}>
            {campaign.joinCode.split("").map((char, index) => (
              <span key={index} className="join-code-glyph" style={{ animationDelay: `${index * 0.12}s` }}>{char}</span>
            ))}
          </div>
          {joinUrl ? (
            <div className="join-qr">
              <QRCodeSVG value={joinUrl} size={148} bgColor="transparent" fgColor={visual.accentBright} level="M" />
            </div>
          ) : null}
          <span className="join-hint">Scan with a phone, or visit this address and enter the code.</span>
        </section>

        <section className="lobby-party">
          <h2 className="panel-subtitle">{ready ? "The party assembles" : "Awaiting the first hero…"}</h2>
          <div className="lobby-party-grid">
            {campaign.players.map((player) => {
              const forging = (player.status || "").toLowerCase().includes("generating");
              const failed = (player.status || "").toLowerCase().startsWith("error");
              const color = accentColor(player.color);
              return (
                <div key={player.id} className={`hero-card ${forging ? "forging" : "arrived"}`} style={{ borderColor: color }}>
                  <div className="hero-portrait" style={{ boxShadow: `0 0 22px ${color}44 inset` }}>
                    {player.portraitUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={player.portraitUrl} alt={player.characterName || player.name} />
                    ) : (
                      <span className={`forge-circle ${failed ? "failed" : ""}`} aria-hidden />
                    )}
                    {campaign.partyLeaderId === player.id ? <span className="hero-crown" title="Party leader">♛</span> : null}
                  </div>
                  <span className="hero-name" style={{ color }}>{player.characterName || player.name}</span>
                  <span className="hero-player">{player.name}</span>
                  <span className={`hero-status ${failed ? "failed" : ""}`}>
                    {forging ? "The Weaver forges their likeness…" : failed ? "The forge sputtered — rejoin to retry" : player.status || "Ready"}
                  </span>
                </div>
              );
            })}
            <div className="hero-card empty">
              <div className="hero-portrait"><span className="empty-seat" aria-hidden>✦</span></div>
              <span className="hero-name muted">An empty seat</span>
              <span className="hero-status">waits for a hero</span>
            </div>
          </div>
        </section>
      </main>

      <footer className="lobby-foot">
        {leader ? (
          <>
            <span className="lobby-foot-hint">
              <strong style={{ color: accentColor(leader.color) }}>{leader.characterName || leader.name}</strong> holds the leader&apos;s seal — their phone can begin the tale.
            </span>
            <button className="ghost-button" disabled={starting} onClick={beginFromTable}>
              {starting ? "Beginning…" : "Begin from the table instead"}
            </button>
            {startError ? <span className="form-error inline">{startError}</span> : null}
          </>
        ) : (
          <span className="lobby-foot-hint">The first hero to join becomes party leader.</span>
        )}
      </footer>
    </div>
  );
}
