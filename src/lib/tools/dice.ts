export type DiceRoll = {
  notation: string;
  rolls: number[];
  modifier: number;
  total: number;
};

export type DiceOutcome =
  | "critical-success"
  | "strong-success"
  | "success"
  | "partial-success"
  | "failure"
  | "hard-failure"
  | "critical-failure";

export type Difficulty = "easy" | "medium" | "hard" | "insane";

const dicePattern = /^(\d*)d(\d+)([+-]\d+)?$/i;

export function rollDice(notation: string): DiceRoll {
  const normalized = notation.trim().replace(/\s+/g, "");
  const match = normalized.match(dicePattern);
  if (!match) throw new Error("Dice notation must look like 1d20, 2d6+3, or 4d8-1");

  const count = Number(match[1] || "1");
  const sides = Number(match[2]);
  const modifier = Number(match[3] || "0");

  if (count < 1 || count > 100 || sides < 2 || sides > 1000) {
    throw new Error("Dice count or sides out of allowed range");
  }

  const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
  const total = rolls.reduce((sum, roll) => sum + roll, 0) + modifier;
  return { notation: normalized, rolls, modifier, total };
}

export function rollD20Mode(mode: "normal" | "advantage" | "disadvantage" = "normal") {
  if (mode === "normal") return rollDice("1d20");
  const rolls = [rollDice("1d20").rolls[0], rollDice("1d20").rolls[0]];
  const chosen = mode === "advantage" ? Math.max(...rolls) : Math.min(...rolls);
  return { notation: `1d20 ${mode}`, rolls, modifier: 0, total: chosen };
}

/**
 * Judge a d20 check against a DC with a full outcome spectrum.
 * Difficulty gates partial successes: easy/medium allow them; hard/insane do not
 * (a near-miss is still a failure under pressure).
 */
export function judgeD20Outcome(opts: {
  total: number;
  natural?: number;
  dc?: number;
  difficulty?: Difficulty | string;
}): { outcome?: DiceOutcome; margin?: number } {
  const { total, natural, dc, difficulty } = opts;
  if (natural === 20) return { outcome: "critical-success", margin: dc !== undefined ? total - dc : undefined };
  if (natural === 1) return { outcome: "critical-failure", margin: dc !== undefined ? total - dc : undefined };
  if (dc === undefined || !Number.isFinite(dc)) return {};

  const margin = total - dc;
  const allowPartial = difficulty === "easy" || difficulty === "medium" || !difficulty;

  if (margin >= 5) return { outcome: "strong-success", margin };
  if (margin >= 0) return { outcome: "success", margin };
  if (margin >= -4) {
    return { outcome: allowPartial ? "partial-success" : "failure", margin };
  }
  return { outcome: "hard-failure", margin };
}

/** Base DC shift applied by campaign difficulty (before ability fit). */
export function difficultyDcBias(difficulty?: Difficulty | string): number {
  switch (difficulty) {
    case "easy": return -2;
    case "hard": return 2;
    case "insane": return 4;
    default: return 0;
  }
}

/**
 * The highest EFFECTIVE d20 DC that still leaves a check winnable, per
 * difficulty. A plain d20 tops out at 20, so any DC above 20 can only be beaten
 * by the nat-20 auto-crit — i.e. it is effectively impossible. The DM sometimes
 * stacks "Very Hard 25" + an insane +4 bias into the high 20s; this ceiling
 * pulls the effective DC back into the possible range so a roll always has a
 * real chance. Harder difficulties allow a steeper (but never impossible) wall.
 * `modifier` (real sheet/damage bonuses baked into the notation) raises the
 * ceiling in lockstep, since the roll's max total is 20 + modifier.
 */
export function clampD20Dc(dc: number, difficulty: Difficulty | string | undefined, modifier = 0): number {
  const ceilByDifficulty: Record<string, number> = { easy: 15, medium: 18, hard: 20, insane: 20 };
  const ceiling = (ceilByDifficulty[String(difficulty)] ?? 18) + Math.max(0, modifier);
  return Math.min(dc, ceiling);
}
