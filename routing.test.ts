/**
 * Routing integration test — verifies strategic group resolves to claude-opus-4-6
 *
 * Tests the full chain: gdpval lookup → model scoring → group resolution
 * Uses simulated cache/config matching real production state.
 */
import { describe, it, expect, beforeEach } from "vitest";

// ── Replicate core routing logic from index.ts ──────────────────────────

const STRIP_SUF = ["-tee", ":free", ":api", "-instruct", "-thinking", "-chat", "-reasoning",
  "-fp8", "-preview", "-2507", "-0324", "-0528"];

function stripDateSuffix(s: string): string {
  return s.replace(/-\d{6,8}$/, "");
}

function norm(s: string): string {
  s = s.toLowerCase();
  const slash = s.lastIndexOf("/");
  if (slash !== -1 && slash < s.length - 1) s = s.slice(slash + 1);
  for (const x of STRIP_SUF) s = s.replace(x, "");
  s = stripDateSuffix(s);
  return s.replace(/[^a-z0-9]/g, "");
}

// GDPval parameter suffixes — same base model, different inference params
const PARAM_SUFFIXES = ["-non-reasoning-low-effort", "-non-reasoning-high-effort",
  "-adaptive", "-non-reasoning", "-reasoning", "-thinking",
  "-low-effort", "-high-effort", "-max-effort"];

function baseTokens(s: string): Set<string> {
  s = s.toLowerCase();
  const slash = s.lastIndexOf("/");
  if (slash !== -1 && slash < s.length - 1) s = s.slice(slash + 1);
  for (const ps of PARAM_SUFFIXES) s = s.replace(ps, "");
  for (const x of STRIP_SUF) s = s.replace(x, "");
  s = stripDateSuffix(s);
  return new Set(s.match(/[a-z]+|\d+/g) ?? []);
}

function lookupGdp(id: string, gdpval: Record<string, number>): number | null {
  // Build index: base-token-key → best score
  const index = new Map<string, number>();
  for (const [slug, score] of Object.entries(gdpval)) {
    const key = [...baseTokens(slug)].sort().join("|");
    const existing = index.get(key);
    if (existing === undefined || score > existing) index.set(key, score);
  }
  const key = [...baseTokens(id)].sort().join("|");
  return index.get(key) ?? null;
}

interface Metrics { gdpval: number; throughput_tps: number; avg_latency_ms: number; cost_per_m: number; }
interface AvailableModel { id: string; provider: string; cost_per_m: number; }

function buildMetrics(
  availableModels: AvailableModel[],
  gdpvalScores: Record<string, number>,
  providers: Record<string, { billing: string }>
): Record<string, Metrics> {
  const result: Record<string, Metrics> = {};
  for (const m of availableModels) {
    const ref = `${m.provider}/${m.id}`;
    const gdp = lookupGdp(ref, gdpvalScores) ?? 50;
    result[ref] = { gdpval: gdp, throughput_tps: 100, avg_latency_ms: 1000, cost_per_m: m.cost_per_m };
  }
  return result;
}

function resolveStrategic(
  availableModels: AvailableModel[],
  gdpvalScores: Record<string, number>,
  providers: Record<string, { billing: string }>
): string | null {
  const metrics = buildMetrics(availableModels, gdpvalScores, providers);
  // Strategic: sort by max_gdpval
  const refs = availableModels.map(m => `${m.provider}/${m.id}`);
  const sorted = refs.sort((a, b) => metrics[b].gdpval - metrics[a].gdpval);
  return sorted[0] ?? null;
}

// ── Test data matching production state ─────────────────────────────────

const GDPVAL_SCORES: Record<string, number> = {
  // Slug-format keys (from scraper)
  "claude-sonnet-4-6-adaptive": 1633,
  "claude-opus-4-6-adaptive": 1606,
  "claude-opus-4-6": 1579,
  "claude-sonnet-4-6": 1553,
  "claude-opus-4-5": 1416,
  "claude-4-5-haiku": 1147,
  "claude-4-5-haiku-reasoning": 1173,
  "claude-4-sonnet": 1149,
  "claude-4-sonnet-thinking": 1151,
  "glm-5": 1418,
  "glm-5-non-reasoning": 1334,
  "deepseek-v3-2": 1098,
  "minimax-m2-5": 1096,
  "qwen3-max": 833,
};

const AVAILABLE_MODELS: AvailableModel[] = [
  // Anthropic models (from API discovery)
  { id: "claude-opus-4-6", provider: "anthropic", cost_per_m: 0 },
  { id: "claude-sonnet-4-6", provider: "anthropic", cost_per_m: 0 },
  { id: "claude-sonnet-4-20250514", provider: "anthropic", cost_per_m: 0 },
  { id: "claude-opus-4-5-20251101", provider: "anthropic", cost_per_m: 0 },
  { id: "claude-haiku-4-5-20251001", provider: "anthropic", cost_per_m: 0 },
  // Chutes models
  { id: "zai-org/GLM-5-TEE", provider: "chutes", cost_per_m: 0.95 },
  { id: "deepseek-ai/DeepSeek-V3-0324", provider: "chutes", cost_per_m: 0 },
  { id: "MiniMaxAI/MiniMax-M2.5-TEE", provider: "chutes", cost_per_m: 0.3 },
];

const PROVIDERS = {
  anthropic: { billing: "subscription" },
  chutes: { billing: "subscription" },
};

// ── Tests ───────────────────────────────────────────────────────────────

describe("GDPval lookup with slug-format scores", () => {
  it("matches anthropic/claude-opus-4-6 to slug 'claude-opus-4-6'", () => {
    const score = lookupGdp("anthropic/claude-opus-4-6", GDPVAL_SCORES);
    // Should match claude-opus-4-6 (1579) or claude-opus-4-6-adaptive (1606)
    // Takes highest: 1606
    expect(score).toBeGreaterThanOrEqual(1579);
  });

  it("matches anthropic/claude-sonnet-4-6 to slug 'claude-sonnet-4-6'", () => {
    const score = lookupGdp("anthropic/claude-sonnet-4-6", GDPVAL_SCORES);
    expect(score).toBeGreaterThanOrEqual(1553);
  });

  it("matches chutes/zai-org/GLM-5-TEE to slug 'glm-5'", () => {
    const score = lookupGdp("chutes/zai-org/GLM-5-TEE", GDPVAL_SCORES);
    expect(score).toBe(1418);
  });

  it("matches anthropic/claude-opus-4-5-20251101 to slug 'claude-opus-4-5'", () => {
    const score = lookupGdp("anthropic/claude-opus-4-5-20251101", GDPVAL_SCORES);
    expect(score).toBe(1416);
  });

  it("does NOT match opus to sonnet", () => {
    // norm("claude-opus-4-6") = "claudeopus46"
    // norm("claude-sonnet-4-6") = "claudesonnet46"
    // Neither is a substring of the other
    const opusNorm = norm("claude-opus-4-6");
    const sonnetNorm = norm("claude-sonnet-4-6");
    expect(opusNorm.includes(sonnetNorm)).toBe(false);
    expect(sonnetNorm.includes(opusNorm)).toBe(false);
  });
});

describe("norm() strips provider and org prefixes via lastIndexOf", () => {
  it("strips single provider prefix", () => {
    expect(norm("anthropic/claude-opus-4-6")).toBe("claudeopus46");
  });

  it("strips nested provider/org prefix to last segment", () => {
    expect(norm("chutes/zai-org/GLM-5-TEE")).toBe("glm5");
  });

  it("strips date suffix", () => {
    expect(norm("claude-opus-4-5-20251101")).toBe("claudeopus45");
  });

  it("leaves bare model names unchanged (except normalization)", () => {
    expect(norm("claude-opus-4-6")).toBe("claudeopus46");
  });

  it("handles slug-format gdpval keys", () => {
    expect(norm("claude-opus-4-6-adaptive")).toBe("claudeopus46adaptive");
  });
});

describe("exact token-set matching prevents cross-model contamination", () => {
  it("GLM-5-Turbo does NOT match GLM-5 score (different model)", () => {
    const score = lookupGdp("chutes/zai-org/GLM-5-Turbo", GDPVAL_SCORES);
    expect(score).toBeNull();
  });

  it("GLM-5-TEE matches GLM-5 (TEE is stripped suffix)", () => {
    const score = lookupGdp("chutes/zai-org/GLM-5-TEE", GDPVAL_SCORES);
    expect(score).toBe(1418);
  });

  it("claude-sonnet-4 does NOT match claude-sonnet-4-6 (different version)", () => {
    const score4 = lookupGdp("anthropic/claude-sonnet-4-20250514", GDPVAL_SCORES);
    const score46 = lookupGdp("anthropic/claude-sonnet-4-6", GDPVAL_SCORES);
    expect(score4).not.toBe(score46);
  });

  it("GDPval parameter variants map to same base model", () => {
    // claude-sonnet-4-6, claude-sonnet-4-6-adaptive, claude-sonnet-4-6-non-reasoning-low-effort
    // all share base tokens [4, 6, claude, sonnet] → highest score wins
    const score = lookupGdp("anthropic/claude-sonnet-4-6", GDPVAL_SCORES);
    expect(score).toBe(1633); // from claude-sonnet-4-6-adaptive
  });
});

describe("strategic group resolves to top claude model", () => {
  it("selects anthropic/claude-sonnet-4-6 as highest gdpval (sonnet 4.6 > opus 4.6 on GDPval-AA)", () => {
    const selected = resolveStrategic(AVAILABLE_MODELS, GDPVAL_SCORES, PROVIDERS);
    expect(selected).toBe("anthropic/claude-sonnet-4-6");
  });

  it("top model has gdpval >= 1600", () => {
    const selected = resolveStrategic(AVAILABLE_MODELS, GDPVAL_SCORES, PROVIDERS);
    const metrics = buildMetrics(AVAILABLE_MODELS, GDPVAL_SCORES, PROVIDERS);
    expect(metrics[selected!].gdpval).toBeGreaterThanOrEqual(1600);
  });

  it("sonnet-4-6 scores higher than opus-4-6", () => {
    const metrics = buildMetrics(AVAILABLE_MODELS, GDPVAL_SCORES, PROVIDERS);
    expect(metrics["anthropic/claude-sonnet-4-6"].gdpval)
      .toBeGreaterThan(metrics["anthropic/claude-opus-4-6"].gdpval);
  });

  it("all anthropic models get non-default gdpval scores", () => {
    const metrics = buildMetrics(AVAILABLE_MODELS, GDPVAL_SCORES, PROVIDERS);
    for (const m of AVAILABLE_MODELS.filter(m => m.provider === "anthropic")) {
      const ref = `${m.provider}/${m.id}`;
      expect(metrics[ref].gdpval, `${ref} should have gdpval > 50`).toBeGreaterThan(50);
    }
  });
});
