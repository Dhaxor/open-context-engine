import { execSync } from "child_process";

export interface RecencyScores {
  scores: Map<string, number>;
  computedAt: number;
}

const DECAY_RATE = 0.1;

export function getFileRecencyScores(workspaceRoot: string, windowDays = 30): RecencyScores {
  const scores = new Map<string, number>();
  try {
    const since = `${windowDays} days ago`;
    const raw = execSync(
      `git log --name-only --format=%at --since="${since}"`,
      { cwd: workspaceRoot, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 15000 },
    );
    const now = Date.now() / 1000;
    let currentTimestamp = 0;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^\d+$/.test(trimmed)) {
        currentTimestamp = parseInt(trimmed, 10);
      } else if (currentTimestamp > 0) {
        const daysSince = Math.max(0, (now - currentTimestamp) / 86400);
        const score = 1 / (1 + daysSince * DECAY_RATE);
        const existing = scores.get(trimmed);
        if (!existing || score > existing) {
          scores.set(trimmed, score);
        }
      }
    }
  } catch {
    // git not available or not a git repo — return empty scores
  }
  return { scores, computedAt: Date.now() };
}

export function applyRecencyBoost(
  results: { chunk: { path: string }; score: number }[],
  recency: RecencyScores,
  weight = 0.3,
): typeof results {
  if (!recency.scores.size) return results;
  return results
    .map(r => {
      const recencyScore = recency.scores.get(r.chunk.path) ?? 0;
      const boosted = r.score * (1 + weight * recencyScore);
      return { ...r, score: boosted };
    })
    .sort((a, b) => b.score - a.score);
}
