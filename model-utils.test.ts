import { describe, it, expect } from "vitest";
import {
  normalizeModelName,
  stripDateSuffix,
  modelNamesMatch,
  splitModelRef,
  formatCompact,
  formatDuration,
  calculateBackoff,
  calculateEffectiveCost,
  parseOpenRouterPricing,
  getUsageFromLog,
} from "./model-utils.js";

describe("normalizeModelName", () => {
  it("strips provider prefixes", () => {
    expect(normalizeModelName("anthropic/claude-opus-4")).toBe("claudeopus4");
    expect(normalizeModelName("openrouter/qwen/qwen3.5-397b")).toBe("qwen35397b");
    expect(normalizeModelName("chutes/zai-org/GLM-5-TEE")).toBe("glm5"); // zai-org/ stripped
    expect(normalizeModelName("mistralai/mistral-large")).toBe("mistrallarge");
  });

  it("strips known suffixes", () => {
    expect(normalizeModelName("model-tee")).toBe("model");
    expect(normalizeModelName("model:free")).toBe("model");
    expect(normalizeModelName("model-instruct")).toBe("model");
    expect(normalizeModelName("model-thinking")).toBe("model");
  });

  it("strips date suffixes", () => {
    expect(normalizeModelName("claude-opus-4-6-20250514")).toBe("claudeopus46");
    expect(normalizeModelName("model-2507")).toBe("model");
    expect(normalizeModelName("model-0324")).toBe("model");
  });

  it("handles combined transformations", () => {
    // Config format → normalized
    expect(normalizeModelName("anthropic/claude-opus-4-6-20250514")).toBe("claudeopus46");
    // OpenRouter format → normalized (should match)
    expect(normalizeModelName("anthropic/claude-opus-4.6")).toBe("claudeopus46");
  });

  it("normalizes case", () => {
    expect(normalizeModelName("CLAUDE-OPUS-4")).toBe("claudeopus4");
    expect(normalizeModelName("Qwen-3.5")).toBe("qwen35");
  });

  it("removes dots and special chars", () => {
    expect(normalizeModelName("qwen3.5-397b")).toBe("qwen35397b");
    expect(normalizeModelName("gpt-4.5")).toBe("gpt45");
  });
});

describe("stripDateSuffix", () => {
  it("strips 8-digit dates", () => {
    expect(stripDateSuffix("claude-opus-4-6-20250514")).toBe("claude-opus-4-6");
  });

  it("strips 6-digit dates", () => {
    expect(stripDateSuffix("model-250514")).toBe("model");
    expect(stripDateSuffix("model-0324")).toBe("model"); // 4-digit YYMM/MMDD now stripped
  });

  it("preserves names without dates", () => {
    expect(stripDateSuffix("claude-opus-4")).toBe("claude-opus-4");
  });
});

describe("modelNamesMatch", () => {
  it("matches identical normalized names", () => {
    expect(modelNamesMatch("claude-opus-4", "claude-opus-4")).toBe(true);
  });

  it("matches config format to OpenRouter format", () => {
    // The key matching case
    expect(modelNamesMatch(
      "anthropic/claude-opus-4-6-20250514",
      "anthropic/claude-opus-4.6"
    )).toBe(true);
  });

  it("matches partial names", () => {
    expect(modelNamesMatch("glm-5", "zai-org/glm-5-tee")).toBe(true);
    expect(modelNamesMatch("qwen3.5", "qwen/qwen3.5-397b")).toBe(true);
  });

  it("does not match different models", () => {
    expect(modelNamesMatch("claude-opus-4", "claude-sonnet-4")).toBe(false);
    expect(modelNamesMatch("gpt-4", "gpt-3.5")).toBe(false);
  });
});

describe("splitModelRef", () => {
  it("splits provider/modelId", () => {
    expect(splitModelRef("anthropic/claude-opus-4")).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-4",
    });
  });

  it("handles nested slashes", () => {
    expect(splitModelRef("chutes/zai-org/GLM-5-TEE")).toEqual({
      provider: "chutes",
      modelId: "zai-org/GLM-5-TEE",
    });
  });

  it("handles missing provider", () => {
    expect(splitModelRef("just-a-model")).toEqual({
      provider: "just-a-model",
      modelId: "just-a-model",
    });
  });
});

describe("formatCompact", () => {
  it("formats small numbers as-is", () => {
    expect(formatCompact(500)).toBe("500");
    expect(formatCompact(999)).toBe("999");
  });

  it("formats thousands with k", () => {
    expect(formatCompact(1500)).toBe("1.5k");
    expect(formatCompact(50000)).toBe("50.0k");
  });

  it("formats millions with m", () => {
    expect(formatCompact(1_500_000)).toBe("1.5m");
    expect(formatCompact(10_000_000)).toBe("10.0m");
  });
});

describe("formatDuration", () => {
  it("formats seconds", () => {
    expect(formatDuration(5000)).toBe("5s");
    expect(formatDuration(30000)).toBe("30s");
  });

  it("formats minutes", () => {
    expect(formatDuration(60000)).toBe("1m");
    expect(formatDuration(90000)).toBe("1m30s");
    expect(formatDuration(3540000)).toBe("59m"); // just under an hour
  });

  it("formats hours", () => {
    expect(formatDuration(5_400_000)).toBe("1h30m");
    expect(formatDuration(7200000)).toBe("2h");
  });
});

describe("calculateBackoff", () => {
  it("returns 1 minute for first hit", () => {
    expect(calculateBackoff(1)).toBe(60_000);
  });

  it("returns 2 minutes for second hit", () => {
    expect(calculateBackoff(2)).toBe(120_000);
  });

  it("returns 4 minutes for third hit", () => {
    expect(calculateBackoff(3)).toBe(240_000);
  });

  it("returns 8 minutes for fourth hit (costMux trigger)", () => {
    expect(calculateBackoff(4)).toBe(480_000);
  });

  it("caps at 90 minutes", () => {
    expect(calculateBackoff(10)).toBe(90 * 60_000);
    expect(calculateBackoff(100)).toBe(90 * 60_000);
  });
});

describe("calculateEffectiveCost", () => {
  it("applies subscription discount", () => {
    // $10/M subscription → $5/M effective
    expect(calculateEffectiveCost(10, "subscription", 1)).toBe(5);
  });

  it("does not discount pay_per_token", () => {
    // $10/M pay-per-token → $10/M effective
    expect(calculateEffectiveCost(10, "pay_per_token", 1)).toBe(10);
  });

  it("applies costMux multiplier", () => {
    // $10/M with costMux ×2 → $20/M
    expect(calculateEffectiveCost(10, "pay_per_token", 2)).toBe(20);
  });

  it("applies both discount and multiplier", () => {
    // $10/M subscription with costMux ×2 → $5 × 2 = $10
    expect(calculateEffectiveCost(10, "subscription", 2)).toBe(10);
  });

  it("uses 0.01 fallback for zero/negative cost", () => {
    expect(calculateEffectiveCost(0, "subscription", 1)).toBe(0.005);
  });
});

describe("parseOpenRouterPricing", () => {
  it("parses per-token to per-million", () => {
    // $0.000005/token → $5/M
    expect(parseOpenRouterPricing("0.000005")).toBe(5);
    // $0.000025/token → $25/M
    expect(parseOpenRouterPricing("0.000025")).toBe(25);
  });

  it("handles zero", () => {
    expect(parseOpenRouterPricing("0")).toBe(0);
  });

  it("handles free tier", () => {
    expect(parseOpenRouterPricing("0.00000005")).toBeCloseTo(0.05);
  });
});

describe("getUsageFromLog", () => {
  const now = 1000000000000; // Fixed timestamp for tests
  const oneDayMs = 24 * 60 * 60 * 1000;

  const log = [
    { ref: "anthropic/claude-opus-4", tokens: 1000, ts: now - 1000 }, // 1s ago
    { ref: "anthropic/claude-opus-4", tokens: 2000, ts: now - oneDayMs - 1000 }, // > 1 day ago
    { ref: "anthropic/claude-opus-4", tokens: 500, ts: now - oneDayMs * 3 }, // 3 days ago
    { ref: "anthropic/claude-sonnet-4", tokens: 3000, ts: now - 1000 }, // different model
  ];

  it("sums tokens for model in last 1 day", () => {
    expect(getUsageFromLog(log, "anthropic/claude-opus-4", 1, now)).toBe(1000);
  });

  it("sums tokens for model in last 7 days", () => {
    expect(getUsageFromLog(log, "anthropic/claude-opus-4", 7, now)).toBe(3500); // 1000 + 2000 + 500 (all within 7 days)
  });

  it("sums tokens for model in last 30 days", () => {
    expect(getUsageFromLog(log, "anthropic/claude-opus-4", 30, now)).toBe(3500); // all
  });

  it("returns 0 for model not in log", () => {
    expect(getUsageFromLog(log, "unknown/model", 30, now)).toBe(0);
  });

  it("only counts matching ref", () => {
    expect(getUsageFromLog(log, "anthropic/claude-sonnet-4", 1, now)).toBe(3000);
  });
});

describe("pricing integration", () => {
  it("Claude Opus config matches OpenRouter format", () => {
    const configName = "anthropic/claude-opus-4-6-20250514";
    const orName = "anthropic/claude-opus-4.6";

    expect(normalizeModelName(configName)).toBe(normalizeModelName(orName));
    expect(modelNamesMatch(configName, orName)).toBe(true);
  });

  it("Claude Sonnet config matches OpenRouter format", () => {
    const configName = "anthropic/claude-sonnet-4-5-20250514";
    const orName = "anthropic/claude-sonnet-4.5";

    expect(modelNamesMatch(configName, orName)).toBe(true);
  });

  it("different Claude versions do not match", () => {
    const sonnet45 = "anthropic/claude-sonnet-4-5-20250514";
    const sonnet46 = "anthropic/claude-sonnet-4.6";

    expect(modelNamesMatch(sonnet45, sonnet46)).toBe(false);
  });

  it("GLM-5 matches across formats", () => {
    const configName = "chutes/zai-org/GLM-5-TEE";
    const gdpvalName = "glm-5";

    expect(modelNamesMatch(configName, gdpvalName)).toBe(true);
  });
});
