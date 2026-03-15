/**
 * Pure utility functions for model routing — extracted for testability
 */

// Prefixes to strip from model names
const STRIP_PRE = ["chutes/","chutesai/","deepseek-ai/","qwen/","moonshotai/","zai-org/","z-ai/",
  "xiaomimimo/","minimaxai/","minimax-ai/","openai/","nvidia/","google/","mistralai/","mistral-ai/",
  "openrouter/","meta-llama/","nousresearch/","unsloth/","liquid/","tngtech/","arcee-ai/","stepfun/",
  "cognitivecomputations/","rednote-hilab/","anthropic/"];

// Suffixes to strip from model names
const STRIP_SUF = ["-tee",":free",":api","-instruct","-thinking","-chat","-reasoning",
  "-fp8","-preview","-2507","-0324","-0528"];

/**
 * Strip trailing date suffixes like -20250514 or -250514
 */
export function stripDateSuffix(s: string): string {
  return s.replace(/-\d{6,8}$/, "");
}

/**
 * Normalize model name for fuzzy matching
 * Strips provider prefixes, known suffixes, date suffixes, and non-alphanumeric chars
 */
export function normalizeModelName(s: string): string {
  s = s.toLowerCase();
  for (const p of STRIP_PRE) s = s.replace(p, "");
  for (const x of STRIP_SUF) s = s.replace(x, "");
  s = stripDateSuffix(s);
  return s.replace(/[^a-z0-9]/g, "");
}

/**
 * Check if two model names match (after normalization)
 */
export function modelNamesMatch(a: string, b: string): boolean {
  const na = normalizeModelName(a);
  const nb = normalizeModelName(b);
  return na === nb || na.includes(nb) || nb.includes(na);
}

/**
 * Split a model reference "provider/model-id" into parts
 */
export function splitModelRef(ref: string): { provider: string; modelId: string } {
  const i = ref.indexOf("/");
  return i === -1
    ? { provider: ref, modelId: ref }
    : { provider: ref.slice(0, i), modelId: ref.slice(i + 1) };
}

/**
 * Format number compactly (e.g., 1500 → "1.5k")
 */
export function formatCompact(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}

/**
 * Format duration in ms to human readable (e.g., 65000 → "1m5s")
 */
export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60) return `${m}m${rs ? rs + "s" : ""}`;
  return `${Math.floor(m / 60)}h${m % 60 ? (m % 60) + "m" : ""}`;
}

/**
 * Calculate exponential backoff duration
 */
export function calculateBackoff(hitNumber: number): number {
  const BACKOFF = [1, 2, 4, 8, 16, 32, 64, 90].map(m => m * 60_000);
  return BACKOFF[Math.min(hitNumber - 1, BACKOFF.length - 1)];
}

/**
 * Calculate effective cost with subscription discount and cost multiplier
 */
export function calculateEffectiveCost(
  baseCostPerM: number,
  billing: "subscription" | "pay_per_token",
  costMux: number
): number {
  const SUB_DISCOUNT = 0.5;
  let base = baseCostPerM || 0.01;
  if (billing === "subscription") base *= SUB_DISCOUNT;
  return base * costMux;
}

/**
 * Parse OpenRouter pricing string to per-million cost
 */
export function parseOpenRouterPricing(pricePerToken: string): number {
  return parseFloat(pricePerToken) * 1_000_000;
}

/**
 * Get usage stats from log
 */
export function getUsageFromLog(
  log: Array<{ ref: string; tokens: number; ts: number }>,
  ref: string,
  days: number,
  now: number = Date.now()
): number {
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  return log
    .filter(e => e.ref === ref && e.ts > cutoff)
    .reduce((sum, e) => sum + e.tokens, 0);
}
