import { Campaign, Player } from "./types";

/**
 * Two-mode turn system (feedback #1).
 *   exploration – simultaneous lock-in: every able+present player picks, then
 *                 ONE combined DM turn resolves them together. No per-player
 *                 freeze — the others just see "waiting for the party".
 *   combat      – sequential initiative: the active player acts, it resolves,
 *                 control passes to the next, then the enemies act, then loop.
 *
 * This module is pure state logic (no I/O) so both the API route and the DM
 * engine can share it.
 */

/** Per-turn / per-round idle deadline. Past it, absent/idle actors are skipped. */
export const TURN_TIMEOUT_MS = Math.max(15000, Number(process.env.TURN_TIMEOUT_MS) || 90000);

/** The "enemies act" pseudo-slot used between the last player and the next round. */
export const ENEMY_SLOT = "enemies";

export function turnMode(campaign: Campaign): "exploration" | "combat" {
  return campaign.turnState?.mode === "combat" ? "combat" : "exploration";
}

/** A player can take part in a round if they're not incapacitated and not away. */
export function isEligible(player: Player): boolean {
  return player.canAct !== false && !player.away;
}

export function eligiblePlayerIds(campaign: Campaign): string[] {
  return campaign.players.filter(isEligible).map((p) => p.id);
}

/** True when every eligible player has locked in an exploration action. */
export function allLockedIn(campaign: Campaign): boolean {
  const ids = eligiblePlayerIds(campaign);
  if (!ids.length) return false;
  const pending = campaign.pendingActions || {};
  return ids.every((id) => !!pending[id]);
}

/** Whether it's this player's move right now (always true in exploration). */
export function canPlayerActNow(campaign: Campaign, playerId: string): boolean {
  const player = campaign.players.find((p) => p.id === playerId);
  if (!player || !isEligible(player)) return false;
  if (turnMode(campaign) === "combat") return campaign.turnState?.activeId === playerId;
  return true;
}

export function nowIso(): string {
  return new Date().toISOString();
}

function deadline(): string {
  return new Date(Date.now() + TURN_TIMEOUT_MS).toISOString();
}

/** Begin sequential initiative. `order` defaults to the eligible players. */
export function startCombat(campaign: Campaign, order?: string[]) {
  const valid = (order && order.length ? order : eligiblePlayerIds(campaign)).filter((id) =>
    campaign.players.some((p) => p.id === id)
  );
  const ids = valid.length ? valid : eligiblePlayerIds(campaign);
  campaign.turnState = {
    mode: "combat",
    order: ids,
    activeId: ids[0],
    round: 1,
    deadlineAt: deadline()
  };
  campaign.pendingActions = {};
}

/** Return to free exploration. */
export function endCombat(campaign: Campaign) {
  campaign.turnState = { mode: "exploration" };
  campaign.pendingActions = {};
}

/**
 * Advance the combat pointer after the current actor finished. Prunes dead/away
 * players from the order, inserts an "enemies" phase after the last player, and
 * bumps the round when wrapping. Returns the new activeId (may be ENEMY_SLOT).
 */
export function advanceCombat(campaign: Campaign): string | undefined {
  const ts = campaign.turnState;
  if (!ts || ts.mode !== "combat") return undefined;
  const order = (ts.order || []).filter((id) =>
    campaign.players.some((p) => p.id === id && isEligible(p))
  );
  ts.order = order;
  if (!order.length) {
    endCombat(campaign);
    return undefined;
  }
  if (ts.activeId === ENEMY_SLOT) {
    ts.activeId = order[0];
    ts.round = (ts.round || 1) + 1;
  } else {
    const idx = order.indexOf(ts.activeId || "");
    if (idx === -1 || idx >= order.length - 1) {
      ts.activeId = ENEMY_SLOT; // everyone has gone → enemies act
    } else {
      ts.activeId = order[idx + 1];
    }
  }
  ts.deadlineAt = deadline();
  return ts.activeId;
}

/** Reset the exploration round timer (called when the first lock-in lands). */
export function armExplorationDeadline(campaign: Campaign) {
  if (!campaign.turnState) campaign.turnState = { mode: "exploration" };
  if (campaign.turnState.mode !== "exploration") return;
  if (!campaign.turnState.deadlineAt) campaign.turnState.deadlineAt = deadline();
}

/** True when the current turn/round deadline has passed. */
export function deadlinePassed(campaign: Campaign): boolean {
  const at = campaign.turnState?.deadlineAt;
  if (!at) return false;
  return Date.now() > new Date(at).getTime();
}

/**
 * Build the combined user message for an exploration round from the locked-in
 * actions, honoring "together" agreement: a party action fires as JOINT only
 * when every eligible player opted into the SAME partyActionId; otherwise the
 * opt-ins fall back to acting individually and dissenters act on their own.
 */
export function buildExplorationResolution(campaign: Campaign): {
  action: string;
  displays: Array<{ playerId: string; name: string; display: string; action: string }>;
} {
  const pending = campaign.pendingActions || {};
  const displays: Array<{ playerId: string; name: string; display: string; action: string }> = [];
  const eligible = eligiblePlayerIds(campaign);

  // Group opt-ins by partyActionId to detect unanimous "together" actions.
  const byParty: Record<string, string[]> = {};
  for (const id of eligible) {
    const pa = pending[id];
    if (pa?.partyActionId) (byParty[pa.partyActionId] ||= []).push(id);
  }
  const unanimousParty = Object.entries(byParty).find(
    ([, ids]) => ids.length === eligible.length && eligible.length > 1
  );

  const nameOf = (pid: string) => {
    const p = campaign.players.find((x) => x.id === pid);
    return p?.characterName || p?.name || "A player";
  };

  const lines: string[] = [];
  for (const id of eligible) {
    const pa = pending[id];
    if (!pa) continue;
    displays.push({ playerId: id, name: nameOf(id), display: pa.display || pa.action, action: pa.action });
    lines.push(`- ${nameOf(id)}: ${pa.action}`);
  }

  let header: string;
  if (unanimousParty) {
    header = `The whole party acts TOGETHER this round on a shared plan. Resolve it as one coordinated action, then the consequences for everyone:`;
  } else {
    header =
      lines.length > 1
        ? `The party acts simultaneously this round. Resolve ALL of these together in one flowing narration; a bad roll by one can complicate the others:`
        : `A party member acts:`;
  }
  return { action: `${header}\n${lines.join("\n")}`, displays };
}
