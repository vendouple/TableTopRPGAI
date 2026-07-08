"use client";

import { useEffect, useState } from "react";
import { api, loadSeat, saveSeat, StoredSeat } from "@/lib/client/api";
import CosmosCanvas from "@/components/three/CosmosCanvas";

/**
 * The phone's doorway: enter the table code, then shape (or summon) the
 * character you'll carry into the tale.
 */
export default function JoinFlow({
  initialCode,
  onSeated,
  onBack
}: {
  initialCode?: string;
  onSeated: (seat: StoredSeat) => void;
  onBack: () => void;
}) {
  const [step, setStep] = useState<"code" | "character">("code");
  const [code, setCode] = useState(initialCode?.toUpperCase() || "");
  const [tableTitle, setTableTitle] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [characterName, setCharacterName] = useState("");
  const [background, setBackground] = useState("");
  const [personality, setPersonality] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [oldSeat, setOldSeat] = useState<StoredSeat | null>(null);

  useEffect(() => {
    setOldSeat(loadSeat());
  }, []);

  // If the QR carried a code, verify it right away.
  useEffect(() => {
    if (initialCode) checkCode(initialCode.toUpperCase());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCode]);

  async function checkCode(value: string) {
    setBusy("code");
    setError(null);
    try {
      const { campaigns } = await api.listCampaigns();
      const found = campaigns.find((item) => item.joinCode === value || item.id === value);
      if (!found) {
        setError("No table answers to that code.");
        return;
      }
      setCode(found.joinCode);
      setTableTitle(found.title);
      setStep("character");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reach the table.");
    } finally {
      setBusy(null);
    }
  }

  const forgeCharacter = async () => {
    setBusy("forge");
    setError(null);
    try {
      const { result } = await api.generate({
        type: "character",
        joinCode: code,
        prompt: background.trim() || undefined,
        characterName: characterName.trim() || undefined,
        personality: personality.trim() || undefined
      });
      setCharacterName(String(result.characterName || characterName));
      setBackground(String(result.background || background));
      setPersonality(String(result.personality || personality));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The Oracle fell silent — try again.");
    } finally {
      setBusy(null);
    }
  };

  const takeSeat = async () => {
    if (!name.trim()) {
      setError("Tell the table your name first.");
      return;
    }
    setBusy("join");
    setError(null);
    try {
      const { campaignId, player, isPartyLeader } = await api.join({
        joinCode: code,
        name: name.trim(),
        characterName: characterName.trim(),
        background: background.trim(),
        personality: personality.trim()
      });
      const seat: StoredSeat = { campaignId, playerId: player.id, name: player.name, isPartyLeader };
      saveSeat(seat);
      onSeated(seat);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The table refused the seat.");
      setBusy(null);
    }
  };

  return (
    <div className="join screen">
      <CosmosCanvas drama={0.45} />
      <div className="portal-veil" />

      <div className="join-frame panel">
        {step === "code" ? (
          <>
            <button className="ghost-button" onClick={onBack}>← Back</button>
            <h1 className="join-title">Join a Table</h1>
            {oldSeat ? (
              <button className="choice-card resume-seat" onClick={() => onSeated(oldSeat)}>
                <span className="choice-title">Return to your seat</span>
                <span className="choice-sub">You were seated as {oldSeat.name} — pick up where you left off.</span>
              </button>
            ) : null}
            <label className="director-label">Table code</label>
            <input
              className="field code-field"
              value={code}
              maxLength={8}
              autoCapitalize="characters"
              autoComplete="off"
              placeholder="e.g. K3XT9A"
              onChange={(event) => setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
              onKeyDown={(event) => {
                if (event.key === "Enter" && code.length >= 4) checkCode(code);
              }}
            />
            {error ? <div className="form-error">{error}</div> : null}
            <button className="primary-button" disabled={busy !== null || code.length < 4} onClick={() => checkCode(code)}>
              {busy === "code" ? "Knocking…" : "Knock on the door"}
            </button>
          </>
        ) : (
          <>
            <button className="ghost-button" onClick={() => setStep("code")}>← Different table</button>
            <h1 className="join-title small">{tableTitle}</h1>
            <p className="panel-hint">Who takes this seat?</p>

            <label className="director-label">Your name (the real you)</label>
            <input className="field" value={name} placeholder="e.g. Sam" onChange={(event) => setName(event.target.value)} />

            <label className="director-label">Your character</label>
            <input
              className="field"
              value={characterName}
              placeholder="Character name — or leave blank and be surprised"
              onChange={(event) => setCharacterName(event.target.value)}
            />
            <textarea
              className="field textarea slim"
              rows={3}
              value={background}
              placeholder="Backstory — a sentence is plenty. The Weaver will grow it."
              onChange={(event) => setBackground(event.target.value)}
            />
            <textarea
              className="field textarea slim"
              rows={2}
              value={personality}
              placeholder="Personality — quirks, flaws, fire."
              onChange={(event) => setPersonality(event.target.value)}
            />
            <button className="oracle-button" disabled={busy !== null} onClick={forgeCharacter}>
              {busy === "forge" ? "The Oracle forges…" : "✦ Let the Oracle forge me"}
            </button>

            {error ? <div className="form-error">{error}</div> : null}
            <button className="summon-button" disabled={busy !== null} onClick={takeSeat}>
              {busy === "join" ? "Taking your seat…" : "⟡ Take the Seat"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
