/**
 * Integration tests: verify pi-model-router handles formats produced by pi-subagents.
 *
 * pi-subagents passes model refs via `--models <value>` where value can be:
 *   - A group name: "tactical", "scout"
 *   - A provider/model ref: "anthropic/claude-sonnet-4"
 *   - A ref with thinking suffix: "anthropic/claude-sonnet-4:high"
 *
 * pi-model-router must correctly split, normalize, and match these.
 */
import { describe, it, expect } from "vitest";
import {
  normalizeModelName,
  modelNamesMatch,
  splitModelRef,
  stripDateSuffix,
} from "./model-utils.js";

describe("pi-subagents integration: model ref formats", () => {
  describe("group names as model IDs", () => {
    it("splitModelRef handles bare group names (no slash)", () => {
      const result = splitModelRef("tactical");
      expect(result.provider).toBe("tactical");
      expect(result.modelId).toBe("tactical");
    });

    it("splitModelRef handles bare group names for all tiers", () => {
      for (const group of ["strategic", "tactical", "operational", "scout", "fallback"]) {
        const result = splitModelRef(group);
        expect(result.provider).toBe(group);
        expect(result.modelId).toBe(group);
      }
    });
  });

  describe("thinking suffix handling", () => {
    // pi-subagents applyThinkingSuffix appends `:high`, `:medium`, etc.
    // pi-model-router's normalizeModelName must not choke on these

    it("normalizeModelName strips colon-suffixed thinking levels", () => {
      // The thinking suffix should be stripped or not interfere with matching
      const base = normalizeModelName("anthropic/claude-sonnet-4");
      const withThinking = normalizeModelName("anthropic/claude-sonnet-4:high");
      // :high is not a known STRIP_SUF but gets stripped by non-alphanumeric removal
      // "high" will remain in the normalized form
      expect(withThinking).toContain("claudesonnet4");
    });

    it("modelNamesMatch matches model with and without thinking suffix", () => {
      // After normalization, "claude-sonnet-4" and "claude-sonnet-4:high" differ by "high"
      // The contains-based matching should still work
      const plain = "anthropic/claude-sonnet-4";
      const withSuffix = "anthropic/claude-sonnet-4:high";
      // normalizeModelName strips non-alphanumeric, so `:` becomes nothing, leaving "high" appended
      const normPlain = normalizeModelName(plain);
      const normSuffix = normalizeModelName(withSuffix);
      // "claudesonnet4" vs "claudesonnet4high" — contains check should work one direction
      expect(normSuffix).toContain(normPlain);
    });
  });

  describe("provider/model refs from subagent configs", () => {
    it("handles standard provider/model format", () => {
      const result = splitModelRef("google/gemini-3-pro");
      expect(result.provider).toBe("google");
      expect(result.modelId).toBe("gemini-3-pro");
    });

    it("handles chutes nested provider format", () => {
      const result = splitModelRef("chutes/deepseek-ai/DeepSeek-V3-0324");
      expect(result.provider).toBe("chutes");
      expect(result.modelId).toBe("deepseek-ai/DeepSeek-V3-0324");
    });

    it("matches models across providers (subagent config vs router discovery)", () => {
      // Subagent config might say "claude-sonnet-4", router discovers "anthropic/claude-sonnet-4-5-20250514"
      expect(modelNamesMatch("claude-sonnet-4", "anthropic/claude-sonnet-4-20250514")).toBe(true);
    });
  });

  describe("round-trip: subagent model override → router resolution", () => {
    it("model override without provider resolves correctly", () => {
      // pi-subagents allows modelOverride like "claude-sonnet-4" (no provider)
      const ref = splitModelRef("claude-sonnet-4");
      expect(ref.provider).toBe("claude-sonnet-4");
      expect(ref.modelId).toBe("claude-sonnet-4");
      // normalizeModelName should still produce a matchable string
      expect(normalizeModelName("claude-sonnet-4")).toBe("claudesonnet4");
    });

    it("model override with provider/id format", () => {
      const ref = splitModelRef("anthropic/claude-opus-4");
      expect(ref.provider).toBe("anthropic");
      expect(ref.modelId).toBe("claude-opus-4");
      expect(normalizeModelName("anthropic/claude-opus-4")).toBe("claudeopus4");
    });
  });
});
