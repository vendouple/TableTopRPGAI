"use client";

import { useEffect, useState } from "react";
import { api, CampaignSummary } from "@/lib/client/api";
import CosmosCanvas from "@/components/three/CosmosCanvas";

/**
 * The front door. A dark astral table with three ways in: forge a new
 * legend, reopen a saga, or step through to the phone controller.
 */
export default function Portal({
  onCreate,
  onResume,
  onJoin
}: {
  onCreate: () => void;
  onResume: (campaignId: string) => void;
  onJoin: () => void;
}) {
  const [campaigns, setCampaigns] = useState<CampaignSummary[] | null>(null);
  const [sagasOpen, setSagasOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.listCampaigns()
      .then(({ campaigns: list }) => {
        if (!cancelled) setCampaigns(list);
      })
      .catch(() => {
        if (!cancelled) setCampaigns([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const removeCampaign = async (id: string) => {
    setConfirmDelete(null);
    setCampaigns((prev) => (prev ? prev.filter((item) => item.id !== id) : prev));
    try {
      await api.deleteCampaign(id);
    } catch {
      const { campaigns: list } = await api.listCampaigns().catch(() => ({ campaigns: [] as CampaignSummary[] }));
      setCampaigns(list);
    }
  };

  const sagas = campaigns || [];

  return (
    <div className="portal screen">
      <CosmosCanvas drama={sagasOpen ? 0.35 : 0.7} />
      <div className="portal-veil" />

      <header className="portal-mast">
        <div className="brand-sigil" aria-hidden>✦</div>
        <h1 className="brand-title">Mythweaver</h1>
        <p className="brand-sub">An AI game master for the living room — the screen is the stage, your phones are the hands of fate.</p>
      </header>

      {!sagasOpen ? (
        <main className="portal-choices">
          <button className="portal-card" onClick={onCreate}>
            <span className="portal-card-rune" aria-hidden>⟡</span>
            <span className="portal-card-title">Forge a New Legend</span>
            <span className="portal-card-sub">Shape a world, gather the party, and let the Weaver narrate.</span>
          </button>
          <button
            className="portal-card"
            onClick={() => setSagasOpen(true)}
            disabled={campaigns !== null && sagas.length === 0}
          >
            <span className="portal-card-rune" aria-hidden>❖</span>
            <span className="portal-card-title">Reopen a Saga</span>
            <span className="portal-card-sub">
              {campaigns === null
                ? "Consulting the archive…"
                : sagas.length === 0
                  ? "The archive is empty — forge your first legend."
                  : `${sagas.length} ${sagas.length === 1 ? "tale waits" : "tales wait"} in the archive.`}
            </span>
          </button>
          <button className="portal-card portal-card-join" onClick={onJoin}>
            <span className="portal-card-rune" aria-hidden>➶</span>
            <span className="portal-card-title">Join a Table</span>
            <span className="portal-card-sub">On a phone? Enter a table code and take your seat.</span>
          </button>
        </main>
      ) : (
        <main className="portal-archive">
          <div className="archive-head">
            <h2 className="panel-title">The Archive</h2>
            <button className="ghost-button" onClick={() => setSagasOpen(false)}>← Back</button>
          </div>
          <div className="archive-list">
            {sagas.map((saga) => (
              <div key={saga.id} className="archive-row">
                <button className="archive-open" onClick={() => onResume(saga.id)}>
                  <span className="archive-title">{saga.title}</span>
                  <span className="archive-meta">
                    <span className={`archive-status status-${saga.status}`}>
                      {saga.status === "active" ? "In progress" : "Gathering"}
                    </span>
                    <span>{saga.playerCount} {saga.playerCount === 1 ? "hero" : "heroes"}</span>
                    <span>{saga.campaignType === "dnd" ? "D&D" : "Story RPG"}</span>
                    <span className="archive-code">Code {saga.joinCode}</span>
                  </span>
                </button>
                {confirmDelete === saga.id ? (
                  <span className="archive-confirm">
                    <button className="danger-button" onClick={() => removeCampaign(saga.id)}>Burn it</button>
                    <button className="ghost-button" onClick={() => setConfirmDelete(null)}>Keep</button>
                  </span>
                ) : (
                  <button className="archive-delete" title="Delete campaign" onClick={() => setConfirmDelete(saga.id)}>✕</button>
                )}
              </div>
            ))}
          </div>
        </main>
      )}

      <footer className="portal-foot">
        <span>Phones join at this address — or scan the lobby QR.</span>
      </footer>
    </div>
  );
}
