"use client";

import { useCallback, useEffect, useState } from "react";
import type { Campaign } from "@/lib/campaign/types";
import { loadSeat, StoredSeat } from "@/lib/client/api";
import Portal from "@/components/Portal";
import CreateWizard from "@/components/CreateWizard";
import HostExperience from "@/components/HostExperience";
import JoinFlow from "@/components/JoinFlow";
import Controller from "@/components/Controller";

type View =
  | { kind: "portal" }
  | { kind: "create" }
  | { kind: "host"; campaignId: string }
  | { kind: "join"; initialCode?: string }
  | { kind: "controller"; seat: StoredSeat };

/**
 * Thin shell: reads the URL once (?controller=1 / ?code= for phones,
 * ?stage= so a refreshed TV lands back on its saga) and hands off to the
 * right experience. All state lives with the server; this is just a door.
 */
export default function Home() {
  const [view, setView] = useState<View | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code") || undefined;
    const isController = params.get("controller") === "1" || !!code;
    const stage = params.get("stage");

    if (isController) {
      const seat = loadSeat();
      if (seat && !code) {
        setView({ kind: "controller", seat });
      } else {
        setView({ kind: "join", initialCode: code || undefined });
      }
    } else if (stage) {
      setView({ kind: "host", campaignId: stage });
    } else {
      setView({ kind: "portal" });
    }
  }, []);

  const setUrl = (query: string) => {
    window.history.replaceState(null, "", query ? `/?${query}` : "/");
  };

  const openHost = useCallback((campaignId: string) => {
    setUrl(`stage=${encodeURIComponent(campaignId)}`);
    setView({ kind: "host", campaignId });
  }, []);

  const toPortal = useCallback(() => {
    setUrl("");
    setView({ kind: "portal" });
  }, []);

  const seatPlayer = useCallback((seat: StoredSeat) => {
    setUrl("controller=1");
    setView({ kind: "controller", seat });
  }, []);

  if (!view) return <div className="screen boot" />;

  switch (view.kind) {
    case "portal":
      return (
        <Portal
          onCreate={() => setView({ kind: "create" })}
          onResume={openHost}
          onJoin={() => {
            setUrl("controller=1");
            setView({ kind: "join" });
          }}
        />
      );
    case "create":
      return <CreateWizard onBack={toPortal} onCreated={(campaign: Campaign) => openHost(campaign.id)} />;
    case "host":
      return <HostExperience campaignId={view.campaignId} onExit={toPortal} />;
    case "join":
      return <JoinFlow initialCode={view.initialCode} onSeated={seatPlayer} onBack={toPortal} />;
    case "controller":
      return (
        <Controller
          seat={view.seat}
          onLeave={() => {
            setUrl("controller=1");
            setView({ kind: "join" });
          }}
        />
      );
  }
}
