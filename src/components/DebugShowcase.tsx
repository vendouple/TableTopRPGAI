"use client";

import { useEffect } from "react";
import type { Campaign } from "@/lib/campaign/types";
import { bgmStop } from "@/lib/client/audio";
import HostStage from "@/components/HostStage";
import MusicWidget from "@/components/MusicWidget";

const timestamp = "2026-01-01T00:00:00.000Z";

const debugCampaign: Campaign = {
  id: "debug-showcase",
  title: "Mythweaver UI Showcase",
  joinCode: "DEBUG",
  status: "active",
  players: [
    {
      id: "debug-hero",
      name: "Preview Player",
      characterName: "Aster Vale",
      status: "Ready",
      inventory: ["Star-forged blade", "Healing draught"],
      abilities: ["Radiant Guard", "Fate Step"],
      notes: "UI preview character",
      stats: [{ name: "HP", value: 18, maxValue: 24 }],
      color: "gold"
    }
  ],
  startingStory: "A visual preview outside the saved campaign archive.",
  storyCharacters: [
    {
      id: "debug-npc",
      name: "The Adversary",
      description: "A stand-in for NPC presentation.",
      status: "Watching",
      inventory: [],
      abilities: ["Threaten"],
      color: "red"
    }
  ],
  currentScene: "The UI showcase waits beyond the edge of the story.",
  overview: "Use the debug gallery to preview menus, themes, moods, effects, dice, and the outro.",
  displayEvents: [
    {
      id: "debug-narration",
      type: "narration",
      speaker: "NARRATOR",
      content: "The stage is yours. Every visual system is ready for inspection.",
      createdAt: timestamp
    }
  ],
  suggestedActions: [],
  playerActions: {},
  partyActions: [],
  memory: "Debug showcase only.",
  images: [],
  portraits: [],
  ambience: { mood: "calm", intensity: 0.65, note: "UI preview", updatedAt: timestamp },
  effects: [],
  messages: [],
  campaignType: "tabletop",
  musicTheme: "fantasy",
  campaignLength: "short",
  rulesMode: "casual",
  difficulty: "medium",
  rollMode: "standard",
  questLog: "Inspect every menu\nPreview the final outro",
  showQuestOnTV: true,
  showQuestOnController: true,
  showPartyInventories: true,
  showPartyAbilities: true,
  showNpcInventories: true,
  showNpcAbilities: true,
  createdAt: timestamp,
  updatedAt: timestamp
};

export default function DebugShowcase({ onExit }: { onExit: () => void }) {
  // The gallery previews music (mood/outro/theme tabs) — silence the bard on exit.
  useEffect(() => () => bgmStop(), []);
  return (
    <>
      <HostStage campaign={debugCampaign} onExit={onExit} theme="fantasy" debugMode />
      <MusicWidget />
    </>
  );
}