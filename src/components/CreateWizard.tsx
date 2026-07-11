"use client";

import { useState } from "react";
import { api, Campaign } from "@/lib/client/api";
import CosmosCanvas from "@/components/three/CosmosCanvas";

type Npc = { name: string; description: string; status: string };
type Step = 0 | 1 | 2 | 3;

const LENGTHS: Array<{ value: string; label: string; sub: string }> = [
  { value: "auto", label: "Let Fate Decide", sub: "The Weaver paces the tale" },
  { value: "short", label: "One Evening", sub: "A tight, sharp tale" },
  { value: "medium", label: "A Few Nights", sub: "Room for detours" },
  { value: "long", label: "A Long Road", sub: "A proper campaign" },
  { value: "infinite", label: "Endless", sub: "It ends when you stop" }
];

const STEP_NAMES = ["The Discipline", "The Premise", "The Cast", "The Summons"];

/**
 * Four incantations to raise a table: pick the discipline, write (or let the
 * Oracle write) the premise, assemble the cast, and speak the summons.
 */
export default function CreateWizard({
  onBack,
  onCreated
}: {
  onBack: () => void;
  onCreated: (campaign: Campaign) => void;
}) {
  const [step, setStep] = useState<Step>(0);
  const [campaignType, setCampaignType] = useState<"tabletop" | "dnd">("tabletop");
  const [rulesMode, setRulesMode] = useState<"casual" | "full">("casual");
  const [campaignLength, setCampaignLength] = useState("auto");
  const [surprise, setSurprise] = useState(false);
  const [title, setTitle] = useState("");
  const [story, setStory] = useState("");
  const [npcs, setNpcs] = useState<Npc[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const oracle = async (label: string, task: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await task();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The Oracle fell silent. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const generatePremise = () =>
    oracle("premise", async () => {
      const trimmedTitle = title.trim();
      const { result } = await api.generate({
        type: "campaign",
        prompt: story.trim() || undefined,
        title: trimmedTitle || undefined,
        campaignType,
        rulesMode
      });
      // A title the user typed is theirs to keep — the Oracle only names the
      // tale when the field was left blank. The story is always (re)written.
      setTitle(trimmedTitle || String(result.title || ""));
      setStory(String(result.startingStory || ""));
    });

  const suggestCast = () =>
    oracle("cast", async () => {
      const { result } = await api.generate({
        type: "suggest_npcs",
        prompt: story,
        campaignType,
        rulesMode
      });
      const suggested = (result.npcs as Npc[]).map((npc) => ({
        name: String(npc.name || "Stranger"),
        description: String(npc.description || ""),
        status: npc.status === "Future NPC" ? "Future NPC" : "Starting NPC"
      }));
      setNpcs((prev) => [...prev, ...suggested]);
    });

  const conjureNpc = () =>
    oracle("npc", async () => {
      const { result } = await api.generate({
        type: "npc",
        startingStory: story,
        campaignType,
        rulesMode
      });
      setNpcs((prev) => [
        ...prev,
        { name: String(result.name || "Stranger"), description: String(result.description || ""), status: "Starting NPC" }
      ]);
    });

  const summon = () =>
    oracle("summon", async () => {
      const { campaign } = await api.createCampaign({
        title: surprise ? "" : title,
        startingStory: surprise ? "" : story,
        storyCharacters: surprise ? [] : npcs,
        isRandomized: surprise,
        campaignLength,
        campaignType,
        rulesMode: campaignType === "dnd" ? rulesMode : "casual"
      });
      onCreated(campaign);
    });

  const canAdvance =
    step === 0 ? true :
    step === 1 ? (surprise || story.trim().length > 0 || title.trim().length > 0) :
    true;

  const next = () => {
    if (step === 1 && surprise) {
      setStep(3);
    } else {
      setStep((s) => Math.min(3, s + 1) as Step);
    }
  };
  const back = () => {
    if (step === 0) {
      onBack();
    } else if (step === 3 && surprise) {
      setStep(1);
    } else {
      setStep((s) => Math.max(0, s - 1) as Step);
    }
  };

  return (
    <div className="wizard screen">
      <CosmosCanvas drama={0.35} />
      <div className="portal-veil" />

      <div className="wizard-frame panel">
        <header className="wizard-head">
          <button className="ghost-button" onClick={back}>←</button>
          <div className="wizard-steps">
            {STEP_NAMES.map((name, index) => (
              <span key={name} className={`wizard-step ${index === step ? "current" : index < step ? "done" : ""} ${surprise && index === 2 ? "skipped" : ""}`}>
                {name}
              </span>
            ))}
          </div>
        </header>

        {error ? <div className="form-error">{error}</div> : null}

        {step === 0 ? (
          <section className="wizard-body">
            <h2 className="panel-title">Choose the discipline</h2>
            <div className="choice-grid">
              <button className={`choice-card ${campaignType === "tabletop" ? "selected" : ""}`} onClick={() => setCampaignType("tabletop")}>
                <span className="choice-title">Story Engine</span>
                <span className="choice-sub">Any genre — noir, sci-fi, horror, heists, slice of life. Rules melt into the fiction.</span>
              </button>
              <button className={`choice-card ${campaignType === "dnd" ? "selected" : ""}`} onClick={() => setCampaignType("dnd")}>
                <span className="choice-title">Dungeons & Dragons</span>
                <span className="choice-sub">Swords, spells, and dungeon-crawling heroics.</span>
              </button>
            </div>

            {campaignType === "dnd" ? (
              <div className="choice-row">
                <button className={`chip-toggle ${rulesMode === "casual" ? "selected" : ""}`} onClick={() => setRulesMode("casual")}>
                  Rules-light <em>HP and heart, no bookkeeping</em>
                </button>
                <button className={`chip-toggle ${rulesMode === "full" ? "selected" : ""}`} onClick={() => setRulesMode("full")}>
                  Full 5e <em>Stats, classes, spell slots</em>
                </button>
              </div>
            ) : null}

            <h3 className="panel-subtitle">How long should the tale run?</h3>
            <div className="choice-row wrap">
              {LENGTHS.map((length) => (
                <button
                  key={length.value}
                  className={`chip-toggle ${campaignLength === length.value ? "selected" : ""}`}
                  onClick={() => setCampaignLength(length.value)}
                >
                  {length.label} <em>{length.sub}</em>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {step === 1 ? (
          <section className="wizard-body">
            <h2 className="panel-title">The premise</h2>
            <label className={`surprise-toggle ${surprise ? "selected" : ""}`}>
              <input type="checkbox" checked={surprise} onChange={(event) => setSurprise(event.target.checked)} />
              <span className="surprise-rune" aria-hidden>☄</span>
              <span>
                <strong>Sealed Envelope</strong>
                <em>Nobody — not even you — knows the tale until the table lights up. The Weaver invents everything.</em>
              </span>
            </label>

            {!surprise ? (
              <>
                <input
                  className="field"
                  placeholder="Title of the legend (optional — the Oracle can name it)"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
                <textarea
                  className="field textarea"
                  rows={9}
                  placeholder="Where does it begin? A rain-slick megacity, a manor with one locked door, a caravan crossing dead salt flats… Write a seed or a saga — or leave it to the Oracle."
                  value={story}
                  onChange={(event) => setStory(event.target.value)}
                />
                <div className="choice-row">
                  <button className="oracle-button" disabled={busy !== null} onClick={generatePremise}>
                    {busy === "premise" ? "The Oracle writes…" : story.trim() ? "✦ Let the Oracle deepen it" : "✦ Let the Oracle write it"}
                  </button>
                </div>
              </>
            ) : null}
          </section>
        ) : null}

        {step === 2 ? (
          <section className="wizard-body">
            <h2 className="panel-title">The cast</h2>
            <p className="panel-hint">Figures the Weaver will keep in play — allies, villains, and those yet to arrive. Optional but potent.</p>
            <div className="npc-list">
              {npcs.map((npc, index) => (
                <div key={`${npc.name}-${index}`} className="npc-row">
                  <div className="npc-fields">
                    <div className="npc-row-top">
                      <input
                        className="field slim"
                        value={npc.name}
                        onChange={(event) => setNpcs((prev) => prev.map((item, i) => i === index ? { ...item, name: event.target.value } : item))}
                      />
                      <button
                        className={`chip-toggle tiny ${npc.status === "Starting NPC" ? "selected" : ""}`}
                        onClick={() => setNpcs((prev) => prev.map((item, i) => i === index ? { ...item, status: item.status === "Starting NPC" ? "Future NPC" : "Starting NPC" } : item))}
                      >
                        {npc.status === "Starting NPC" ? "Opens the tale" : "Arrives later"}
                      </button>
                      <button className="archive-delete" onClick={() => setNpcs((prev) => prev.filter((_, i) => i !== index))}>✕</button>
                    </div>
                    <textarea
                      className="field textarea slim"
                      rows={2}
                      value={npc.description}
                      onChange={(event) => setNpcs((prev) => prev.map((item, i) => i === index ? { ...item, description: event.target.value } : item))}
                    />
                  </div>
                </div>
              ))}
            </div>
            <div className="choice-row">
              <button className="oracle-button" disabled={busy !== null || !story.trim()} onClick={suggestCast}>
                {busy === "cast" ? "Summoning the cast…" : "✦ Suggest a cast"}
              </button>
              <button className="ghost-button" disabled={busy !== null} onClick={conjureNpc}>
                {busy === "npc" ? "Conjuring…" : "+ Conjure one"}
              </button>
              <button className="ghost-button" onClick={() => setNpcs((prev) => [...prev, { name: "", description: "", status: "Starting NPC" }])}>
                + Write your own
              </button>
            </div>
          </section>
        ) : null}

        {step === 3 ? (
          <section className="wizard-body">
            <h2 className="panel-title">Speak the summons</h2>
            <div className="summons-review">
              <div className="summons-line"><span>Discipline</span><strong>{campaignType === "dnd" ? `Dungeons & Dragons — ${rulesMode === "full" ? "full 5e" : "rules-light"}` : "Story Engine"}</strong></div>
              <div className="summons-line"><span>Length</span><strong>{LENGTHS.find((l) => l.value === campaignLength)?.label}</strong></div>
              {surprise ? (
                <div className="summons-line"><span>Premise</span><strong>Sealed — revealed at the table</strong></div>
              ) : (
                <>
                  <div className="summons-line"><span>Title</span><strong>{title.trim() || "The Oracle will name it"}</strong></div>
                  <div className="summons-line"><span>Premise</span><strong>{story.trim() ? `${story.trim().slice(0, 160)}${story.trim().length > 160 ? "…" : ""}` : "Woven from the party's characters"}</strong></div>
                  <div className="summons-line"><span>Cast</span><strong>{npcs.length ? npcs.map((npc) => npc.name || "Unnamed").join(", ") : "The Weaver's own"}</strong></div>
                </>
              )}
            </div>
            <button className="summon-button" disabled={busy !== null} onClick={summon}>
              {busy === "summon" ? "Raising the table…" : "⟡ Raise the Table"}
            </button>
          </section>
        ) : null}

        {step < 3 ? (
          <footer className="wizard-foot">
            <button className="primary-button" disabled={!canAdvance || busy !== null} onClick={next}>
              Continue →
            </button>
          </footer>
        ) : null}
      </div>
    </div>
  );
}
