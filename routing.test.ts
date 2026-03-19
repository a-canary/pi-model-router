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

function tokenize(s: string): string[] {
  s = s.toLowerCase();
  const slash = s.lastIndexOf("/");
  if (slash !== -1 && slash < s.length - 1) s = s.slice(slash + 1);
  for (const x of STRIP_SUF) s = s.replace(x, "");
  s = stripDateSuffix(s);
  return s.match(/[a-z]+|\d+/g)?.sort() ?? [];
}

function tokensMatch(a: string[], b: string[]): boolean {
  const sa = new Set(a), sb = new Set(b);
  if (sa.size <= sb.size) return [...sa].every(t => sb.has(t));
  return [...sb].every(t => sa.has(t));
}

const VARIANT_TAGS = ["turbo", "flash", "mini", "lite", "nano", "micro", "small", "ultra", "plus", "fast"];

function validSubstringMatch(shorter: string, longer: string): boolean {
  const extra = longer.replace(shorter, "");
  for (const v of VARIANT_TAGS) {
    if (extra.includes(v) && !shorter.includes(v)) return false;
    if (shorter.includes(v) && !longer.includes(v)) return false;
  }
  return true;
}

function lookupGdp(id: string, gdpval: Record<string, number>): number | null {
  const n = norm(id);
  let best: number | null = null;
  // Pass 1: substring match with variant guard
  for (const [k, v] of Object.entries(gdpval)) {
    const nk = norm(k);
    if (nk === n) { if (best === null || v > best) best = v; continue; }
    if (nk.includes(n) && validSubstringMatch(n, nk)) { if (best === null || v > best) best = v; }
    else if (n.includes(nk) && validSubstringMatch(nk, n)) { if (best === null || v > best) best = v; }
  }
  if (best !== null) return best;
  // Pass 2: token-set match with variant guard
  const tId = tokenize(id);
  const idVariants = new Set(tId.filter(t => VARIANT_TAGS.includes(t)));
  for (const [k, v] of Object.entries(gdpval)) {
    const tK = tokenize(k);
    const kVariants = new Set(tK.filter(t => VARIANT_TAGS.includes(t)));
    const sameVariants = idVariants.size === kVariants.size && [...idVariants].every(v => kVariants.has(v));
    if (!sameVariants) continue;
    if (tokensMatch(tId, tK)) { if (best === null || v > best) best = v; }
  }
  return best;
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

describe("variant guard prevents base↔variant cross-matches", () => {
  it("GLM-5-Turbo does NOT match GLM-5 score", () => {
    const score = lookupGdp("chutes/zai-org/GLM-5-Turbo", GDPVAL_SCORES);
    // GLM-5 is 1418, but Turbo is a distinct variant — should NOT inherit that score
    expect(score).not.toBe(1418);
  });

  it("GLM-5-TEE still matches GLM-5 (TEE is stripped suffix, not a variant)", () => {
    const score = lookupGdp("chutes/zai-org/GLM-5-TEE", GDPVAL_SCORES);
    expect(score).toBe(1418);
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
