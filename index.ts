/**
 * pi-model-router — Passive model group routing for pi
 *
 * Routes group names (strategic/tactical/operational/scout) to concrete models.
 * Balances intelligence, cost, and availability via:
 *   - GDPval-ranked selection pipelines
 *   - Subscription cost discount (sunk cost preference)
 *   - Exponential backoff on 429 + permanent costMux per provider
 *   - Passive throughput/latency tracking from observed turns
 */
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { truncateToWidth } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { homedir } from "node:os";

// ── Types ──────────────────────────────────────────────────────────────────

interface Metrics { gdpval: number; throughput_tps: number; avg_latency_ms: number; cost_per_m: number; last_updated: number; }
interface RateLimit { cooldown_until: number; backoff_ms: number; hits: number; }
interface PipeStep { method: string; top_k?: number; }
interface Group { description?: string; method: string; top_k?: number; pipeline?: PipeStep[]; models: string[]; filter_free?: boolean; }
interface ProviderKey { key: string; label?: string; }
interface ProviderConfig { billing: string; monthly_cost_usd?: number; keys?: ProviderKey[]; }
interface Config {
  providers?: Record<string, ProviderConfig>;
  model_groups: Record<string, Group>;
  model_metrics: Record<string, Partial<Metrics>>;
  gdpval_builtin?: Record<string, number>;
}
interface Cache {
  gdpval_scores?: Record<string, number>; gdpval_scraped?: boolean;
  models_cached?: string; available_models?: { id: string; provider: string; cost_per_m: number }[];
  benchmarks?: Record<string, number>;
  cost_mux?: Record<string, number>; cost_mux_last_bump?: Record<string, string>;
  exhausted_keys?: Record<string, number>; // "provider:keyIdx" → exhausted_until timestamp
}

// ── Constants ──────────────────────────────────────────────────────────────

const BACKOFF = [1, 2, 4, 8, 16, 32, 64, 90].map(m => m * 60_000); // minutes → ms
const COST_MUX_AT_HIT = 4;
const SUB_DISCOUNT = 0.5;
const MODELS_TTL = 24 * 3_600_000;
const GDPVAL_URL = "https://artificialanalysis.ai/evaluations/gdpval-aa";

const GDPVAL_BUILTIN: Record<string, number> = {
  "glm-5": 1418, "glm-4.7": 1209, "glm-4.6": 1046, "kimi-k2.5": 1291,
  "minimax-m2.5": 1215, "minimax-m2": 1057, "mimo-v2-flash": 1115,
  "qwen3.5-397b": 1258, "qwen3.5-27b": 1208, "qwen3-coder-next": 944,
  "qwen3-235b-a22b": 840, "qwen3-32b": 540, "qwen3-coder-plus": 944, "qwen3-coder-flash": 800,
  "deepseek-v3.2": 1202, "deepseek-v3.1": 1116, "deepseek-v3": 470, "deepseek-r1-0528": 712,
  "mistral-large-3": 893, "mistral-small-3.1": 386,
  "gpt-oss-120b": 971, "gpt-oss-20b": 694,
  "llama-3.3-70b": 453, "hermes-4-405b": 623,
  "claude-opus-4": 1450, "claude-sonnet-4": 1380, "claude-haiku-4": 1100,
  "gpt-4.5": 1320, "gpt-4o": 1200, "o3": 1400, "o4-mini": 1250,
};

// ── Provider Discovery Map ─────────────────────────────────────────────

interface ProviderDef {
  envVar?: string;        // e.g. "ANTHROPIC_API_KEY"
  authKey?: string;       // key in ~/.pi/agent/auth.json
  passPatterns?: string[]; // glob-ish prefixes to match in `pass ls`
  cliAuthFiles?: { path: string; tokenField: string }[]; // CLI tool auth files (e.g. ~/.qwen/oauth_creds.json)
  local?: boolean;        // ollama/lm-studio — no key needed
  billing?: string;       // default billing type
}

const PROVIDER_MAP: Record<string, ProviderDef> = {
  "anthropic":           { envVar: "ANTHROPIC_API_KEY",    authKey: "anthropic",             passPatterns: ["api/claude", "api/anthropic"],   billing: "subscription" },
  "openai":              { envVar: "OPENAI_API_KEY",       authKey: "openai",                passPatterns: ["api/openai"],                    billing: "pay_per_token" },
  "google":              { envVar: "GEMINI_API_KEY",       authKey: "google",                passPatterns: ["api/gemini", "api/google"],      billing: "pay_per_token" },
  "openrouter":          { envVar: "OPENROUTER_API_KEY",   authKey: "openrouter",            passPatterns: ["api/openrouter"],                billing: "pay_per_token" },
  "chutes":              { envVar: "CHUTES_API_KEY",       authKey: "chutes",                passPatterns: ["api/chutes"],                    billing: "subscription" },
  "mistral":             { envVar: "MISTRAL_API_KEY",      authKey: "mistral",               passPatterns: ["api/mistral"],                   billing: "pay_per_token" },
  "groq":                { envVar: "GROQ_API_KEY",         authKey: "groq",                  passPatterns: ["api/groq"],                      billing: "pay_per_token" },
  "cerebras":            { envVar: "CEREBRAS_API_KEY",     authKey: "cerebras",              passPatterns: ["api/cerebras"],                  billing: "pay_per_token" },
  "xai":                 { envVar: "XAI_API_KEY",          authKey: "xai",                   passPatterns: ["api/xai"],                       billing: "pay_per_token" },
  "zai":                 { envVar: "ZAI_API_KEY",          authKey: "zai",                   passPatterns: ["api/zai"],                       billing: "pay_per_token" },
  "huggingface":         { envVar: "HF_TOKEN",             authKey: "huggingface",           passPatterns: ["api/huggingface", "api/hf"],     billing: "pay_per_token" },
  "kimi-coding":         { envVar: "KIMI_API_KEY",         authKey: "kimi-coding",           passPatterns: ["api/kimi"],                      billing: "pay_per_token" },
  "minimax":             { envVar: "MINIMAX_API_KEY",      authKey: "minimax",               passPatterns: ["api/minimax"],                   billing: "pay_per_token" },
  "minimax-cn":          { envVar: "MINIMAX_CN_API_KEY",   authKey: "minimax-cn",            passPatterns: [],                                billing: "pay_per_token" },
  "opencode":            { envVar: "OPENCODE_API_KEY",     authKey: "opencode",              passPatterns: ["api/opencode"],                  billing: "pay_per_token" },
  "opencode-go":         { envVar: "OPENCODE_API_KEY",     authKey: "opencode-go",           passPatterns: [],                                billing: "pay_per_token" },
  "vercel-ai-gateway":   { envVar: "AI_GATEWAY_API_KEY",   authKey: "vercel-ai-gateway",     passPatterns: ["api/vercel"],                    billing: "pay_per_token" },
  "azure-openai":        { envVar: "AZURE_OPENAI_API_KEY", authKey: "azure-openai-responses",passPatterns: ["api/azure"],                     billing: "pay_per_token" },
  "deepseek":            { envVar: "DEEPSEEK_API_KEY",     authKey: "deepseek",              passPatterns: ["api/deepseek"],                  billing: "pay_per_token" },
  "github-copilot":      {                                 authKey: "github-copilot",        passPatterns: [],                                billing: "subscription" },
  "qwen-cli":            {                                 authKey: "qwen-cli",              passPatterns: [],  cliAuthFiles: [{ path: "~/.qwen/oauth_creds.json", tokenField: "access_token" }],  billing: "subscription" },
  "gemini-cli":          {                                 authKey: "gemini-cli",            passPatterns: [],  cliAuthFiles: [{ path: "~/.gemini/oauth_creds.json", tokenField: "access_token" }],  billing: "subscription" },
  "antigravity":         {                                 authKey: "antigravity",           passPatterns: [],                                billing: "subscription" },
  "ollama":              { local: true,                                                      passPatterns: [],                                billing: "subscription" },
  "lm-studio":           { local: true,                                                      passPatterns: [],                                billing: "subscription" },
};

const STRIP_PRE = ["chutesai/","deepseek-ai/","qwen/","moonshotai/","zai-org/","z-ai/",
  "xiaomimimo/","minimaxai/","openai/","nvidia/","google/","mistralai/","openrouter/",
  "meta-llama/","nousresearch/","unsloth/","liquid/","tngtech/","arcee-ai/","stepfun/",
  "cognitivecomputations/","rednote-hilab/"];
const STRIP_SUF = ["-tee",":free",":api","-instruct","-thinking","-chat","-reasoning",
  "-fp8","-preview","-2507","-0324","-0528"];

// ── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const extDir = path.dirname(new URL(import.meta.url).pathname);
  const cfgPath = path.join(extDir, "router-config.json");
  const cachePath = path.join(extDir, ".cache/scan-cache.json");

  let cfg: Config;
  let cache: Cache = {};
  let metrics: Record<string, Metrics> = {};
  let limits = new Map<string, RateLimit>();
  let rrCounters: Record<string, number> = {};
  let gdpval: Record<string, number> = { ...GDPVAL_BUILTIN };
  let scanning = false;
  let activeGroup: string | null = null;
  let sessionStart = Date.now();
  let turnStart = 0;
  let curModel = "";

  // ── Helpers ────────────────────────────────────────────────────────────

  function norm(s: string): string {
    s = s.toLowerCase();
    for (const p of STRIP_PRE) s = s.replace(p, "");
    for (const x of STRIP_SUF) s = s.replace(x, "");
    return s.replace(/[^a-z0-9]/g, "");
  }

  function lookupGdp(id: string): number | null {
    const n = norm(id);
    let best: number | null = null;
    for (const [k, v] of Object.entries(gdpval)) {
      const nk = norm(k);
      if (nk.includes(n) || n.includes(nk)) { if (best === null || v > best) best = v; }
    }
    return best;
  }

  function splitRef(ref: string) {
    const i = ref.indexOf("/");
    return i === -1 ? { provider: ref, modelId: ref } : { provider: ref.slice(0, i), modelId: ref.slice(i + 1) };
  }

  function fmt(n: number) { return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`; }

  function fmtTime(ms: number) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60), rs = s % 60;
    if (m < 60) return `${m}m${rs ? rs + "s" : ""}`;
    return `${Math.floor(m / 60)}h${m % 60 ? (m % 60) + "m" : ""}`;
  }

  // ── Config + Cache ─────────────────────────────────────────────────────

  function load() {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    if (cfg.gdpval_builtin) Object.assign(gdpval, cfg.gdpval_builtin);
  }

  function loadCache() {
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      if (fs.existsSync(cachePath)) {
        cache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
        if (cache.gdpval_scores) gdpval = { ...GDPVAL_BUILTIN, ...cache.gdpval_scores };
        if (cache.benchmarks) {
          for (const [ref, tps] of Object.entries(cache.benchmarks)) {
            if (!metrics[ref]) metrics[ref] = { gdpval: lookupGdp(ref) ?? 50, throughput_tps: tps, avg_latency_ms: tps > 0 ? 100000 / tps : 1000, cost_per_m: 0, last_updated: Date.now() };
          }
        }
      }
    } catch { /* first run */ }
  }

  function saveCache() {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  }

  // ── Key Discovery ───────────────────────────────────────────────────────

  let passEntries: string[] | null = null; // cached pass ls output
  let discoveredProviders = new Set<string>();

  function parsePassTree(): string[] {
    if (passEntries !== null) return passEntries;
    try {
      const raw = execSync("pass ls", { encoding: "utf-8", timeout: 5000 });
      // Parse tree output: extract leaf paths from lines like "├── api-key" or "│   └── token"
      const lines = raw.split("\n");
      const stack: string[] = [];
      const entries: string[] = [];
      for (const line of lines) {
        if (line === "Password Store" || !line.trim()) continue;
        // Determine depth by counting tree prefixes (each level is 4 chars: "│   " or "    ")
        const stripped = line.replace(/[│├└─\s]/g, "");
        if (!stripped) continue;
        const depth = Math.floor((line.length - line.replace(/^[│ ├└─]+/, "").length) / 4);
        stack.length = depth;
        stack[depth] = stripped;
        entries.push(stack.filter(Boolean).join("/"));
      }
      passEntries = entries;
    } catch { passEntries = []; }
    return passEntries;
  }

  function discoverKeys() {
    const auth = loadAuth();
    const entries = parsePassTree();

    for (const [provId, def] of Object.entries(PROVIDER_MAP)) {
      if (!cfg.providers) cfg.providers = {};
      if (!cfg.providers[provId]) cfg.providers[provId] = { billing: def.billing ?? "pay_per_token" };
      const prov = cfg.providers[provId];
      if (!prov.keys) prov.keys = [];

      const existingLabels = new Set(prov.keys.map(k => k.label ?? k.key));

      // 1. Env var
      if (def.envVar && process.env[def.envVar]) {
        const label = `env:${def.envVar}`;
        if (!existingLabels.has(label)) {
          prov.keys.push({ key: def.envVar, label });
          existingLabels.add(label);
        }
      }

      // 2. auth.json
      if (def.authKey && auth[def.authKey]) {
        const authEntry = auth[def.authKey];
        const label = "auth.json";
        if (!existingLabels.has(label)) {
          // Store as reference — the key field from auth.json if it's an api_key type
          if (authEntry.key) {
            prov.keys.push({ key: authEntry.key, label });
          } else if (authEntry.type === "oauth" || authEntry.refresh) {
            // OAuth — mark as available but key rotation doesn't apply
            prov.keys.push({ key: `__oauth__:${def.authKey}`, label: "auth.json:oauth" });
          }
          existingLabels.add(label);
        }
      }

      // 3. Pass store
      if (def.passPatterns) {
        for (const pattern of def.passPatterns) {
          const matches = entries.filter(e => e.startsWith(pattern + "/") || e === pattern);
          for (const m of matches) {
            const label = `pass:${m}`;
            if (!existingLabels.has(label)) {
              prov.keys.push({ key: `!pass show ${m}`, label });
              existingLabels.add(label);
            }
          }
        }
      }

      // 4. CLI auth files (e.g. ~/.qwen/oauth_creds.json, ~/.gemini/oauth_creds.json)
      if (def.cliAuthFiles) {
        for (const af of def.cliAuthFiles) {
          const filePath = af.path.replace("~", homedir());
          const label = `cli:${af.path}`;
          if (!existingLabels.has(label)) {
            try {
              if (fs.existsSync(filePath)) {
                const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
                if (data[af.tokenField]) {
                  prov.keys.push({ key: `__cli_oauth__:${filePath}:${af.tokenField}`, label });
                  existingLabels.add(label);
                }
              }
            } catch { /* unreadable */ }
          }
        }
      }

      // 5. Local providers — just mark as available
      if (def.local) {
        if (!existingLabels.has("local")) {
          prov.keys.push({ key: "__local__", label: "local" });
          existingLabels.add("local");
        }
      }

      // Track discovered (has at least one key not from config)
      if (prov.keys.length > 0) discoveredProviders.add(provId);

      // Clean up empty providers
      if (prov.keys.length === 0) delete cfg.providers[provId];
    }
  }

  // ── Scan (GDPval forever, models 24hr) ─────────────────────────────────

  async function scan(force = false) {
    if (scanning) return;
    scanning = true;
    try {
      if (!cache.gdpval_scraped || force) {
        try {
          const html = execSync(`curl -sL --max-time 30 -A "Mozilla/5.0" "${GDPVAL_URL}"`, { encoding: "utf-8", maxBuffer: 5e6 });
          const re = /<div[^>]*>([^<]{3,80})<\/div><\/td>\s*<td[^>]*>(\d{3,4})<\/td>/g;
          let m; const scores: Record<string, number> = {};
          while ((m = re.exec(html))) { const nm = m[1].trim(); if (nm && /[A-Za-z]/.test(nm) && !nm.startsWith("<")) scores[nm] = +m[2]; }
          if (Object.keys(scores).length) { gdpval = { ...GDPVAL_BUILTIN, ...scores }; cache.gdpval_scores = gdpval; cache.gdpval_scraped = true; }
        } catch { /* scrape failed, use builtins */ }
      }
      const age = cache.models_cached ? Date.now() - new Date(cache.models_cached).getTime() : Infinity;
      if (force || age > MODELS_TTL) {
        const models: Cache["available_models"] = [];
        try {
          const d = JSON.parse(execSync(`curl -sL --max-time 20 "https://llm.chutes.ai/v1/models"`, { encoding: "utf-8", maxBuffer: 2e6 }));
          for (const m of d.data ?? []) models.push({ id: m.id, provider: "chutes", cost_per_m: 0 });
        } catch {}
        try {
          const d = JSON.parse(execSync(`curl -sL --max-time 20 "https://openrouter.ai/api/v1/models"`, { encoding: "utf-8", maxBuffer: 5e6 }));
          for (const m of d.data ?? []) if (String(m.pricing?.prompt ?? "1") === "0") models.push({ id: m.id, provider: "openrouter", cost_per_m: 0 });
        } catch {}
        if (models.length) { cache.available_models = models; cache.models_cached = new Date().toISOString(); }
      }
      saveCache();
    } finally { scanning = false; }
  }

  // ── Metrics ────────────────────────────────────────────────────────────

  function getM(ref: string): Metrics {
    if (metrics[ref]) return metrics[ref];
    const cm = cfg.model_metrics[ref] ?? {};
    return metrics[ref] = { gdpval: lookupGdp(ref) ?? cm.gdpval ?? 50, throughput_tps: cm.throughput_tps ?? 100, avg_latency_ms: cm.avg_latency_ms ?? 1000, cost_per_m: cm.cost_per_m ?? 0, last_updated: Date.now() };
  }

  function updateMetrics(ref: string, latMs: number, tokens: number, durMs: number) {
    const m = getM(ref), α = 0.3;
    m.avg_latency_ms = m.avg_latency_ms * (1 - α) + latMs * α;
    if (durMs > 0 && tokens > 0) { m.throughput_tps = m.throughput_tps * (1 - α) + (tokens / durMs * 1000) * α; if (!cache.benchmarks) cache.benchmarks = {}; cache.benchmarks[ref] = m.throughput_tps; }
    m.last_updated = Date.now();
  }

  // ── Rate Limit + costMux ───────────────────────────────────────────────

  const AUTH_PATH = path.join(homedir(), ".pi", "agent", "auth.json");
  const KEY_COOLDOWN = 3_600_000; // 1hr per exhausted key
  let activeKeyIdx: Record<string, number> = {}; // provider → current key index

  function resolveKeyValue(key: string): string {
    if (key.startsWith("!pass show ")) {
      try { return execSync(key.slice(1), { encoding: "utf-8" }).trim(); }
      catch { return key; }
    }
    return key;
  }

  function loadAuth(): any {
    try { return JSON.parse(fs.readFileSync(AUTH_PATH, "utf-8")); } catch { return {}; }
  }

  function saveAuth(auth: any) {
    fs.writeFileSync(AUTH_PATH, JSON.stringify(auth, null, 2));
  }

  function isKeyExhausted(prov: string, idx: number): boolean {
    const until = cache.exhausted_keys?.[`${prov}:${idx}`];
    if (!until) return false;
    if (Date.now() >= until) { delete cache.exhausted_keys![`${prov}:${idx}`]; return false; }
    return true;
  }

  function exhaustKey(prov: string, idx: number) {
    if (!cache.exhausted_keys) cache.exhausted_keys = {};
    cache.exhausted_keys[`${prov}:${idx}`] = Date.now() + KEY_COOLDOWN;
    saveCache();
  }

  /** Try rotating to next available key for provider. Returns true if switched. */
  function rotateKey(prov: string): boolean {
    const keys = cfg.providers?.[prov]?.keys;
    if (!keys || keys.length <= 1) return false;
    const curIdx = activeKeyIdx[prov] ?? 0;
    exhaustKey(prov, curIdx);
    for (let i = 1; i < keys.length; i++) {
      const nextIdx = (curIdx + i) % keys.length;
      if (!isKeyExhausted(prov, nextIdx)) {
        const resolved = resolveKeyValue(keys[nextIdx].key);
        const auth = loadAuth();
        if (auth[prov]) {
          // Update the key/token in auth.json
          if (auth[prov].key) auth[prov].key = keys[nextIdx].key;
          else if (auth[prov].type === "api_key") auth[prov].key = keys[nextIdx].key;
          else auth[prov].key = keys[nextIdx].key; // fallback: set key field
          saveAuth(auth);
        }
        activeKeyIdx[prov] = nextIdx;
        return true;
      }
    }
    return false; // all keys exhausted
  }

  function activeKeyLabel(prov: string): string | null {
    const keys = cfg.providers?.[prov]?.keys;
    if (!keys || keys.length <= 1) return null;
    const idx = activeKeyIdx[prov] ?? 0;
    return keys[idx]?.label ?? `key-${idx}`;
  }

  function costMux(prov: string) { return cache.cost_mux?.[prov] ?? 1; }

  function bumpMux(prov: string, modelId: string) {
    // 1/day guard
    const last = cache.cost_mux_last_bump?.[prov];
    if (last && new Date(last).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10)) return;
    // verify model still hosted
    if (cache.available_models && !cache.available_models.some(m => m.provider === prov && m.id === modelId)) return;
    if (!cache.cost_mux) cache.cost_mux = {};
    if (!cache.cost_mux_last_bump) cache.cost_mux_last_bump = {};
    cache.cost_mux[prov] = (cache.cost_mux[prov] ?? 1) + 1;
    cache.cost_mux_last_bump[prov] = new Date().toISOString();
    saveCache();
  }

  function isLimited(ref: string) {
    const e = limits.get(ref);
    if (!e) return false;
    if (Date.now() >= e.cooldown_until) { limits.delete(ref); return false; }
    return true;
  }

  function recordLimit(ref: string): { rotated: boolean; newKey?: string } {
    const { provider } = splitRef(ref);
    // Try key rotation first — if we have another key, use it instead of backing off the model
    if (rotateKey(provider)) {
      const label = activeKeyLabel(provider) ?? "next";
      return { rotated: true, newKey: label };
    }
    // No keys to rotate — fall back to model-level backoff
    const prev = limits.get(ref);
    const hits = (prev?.hits ?? 0) + 1;
    const ms = BACKOFF[Math.min(hits - 1, BACKOFF.length - 1)];
    limits.set(ref, { cooldown_until: Date.now() + ms, backoff_ms: ms, hits });
    if (hits === COST_MUX_AT_HIT) { const { provider: p, modelId } = splitRef(ref); bumpMux(p, modelId); }
    return { rotated: false };
  }

  function recordOk(ref: string) { const e = limits.get(ref); if (e) e.hits = 0; }

  function limitSecs(ref: string) { const e = limits.get(ref); return e ? Math.max(0, Math.ceil((e.cooldown_until - Date.now()) / 1000)) : 0; }

  // ── Effective cost ─────────────────────────────────────────────────────

  function effCost(ref: string): number {
    const m = getM(ref), prov = ref.split("/")[0];
    let base = m.cost_per_m || 0.01; // tiny base so costMux differentiates free models
    if (cfg.providers?.[prov]?.billing === "subscription") base *= SUB_DISCOUNT;
    return base * costMux(prov);
  }

  // ── Resolution ─────────────────────────────────────────────────────────

  function available(g: Group) {
    let c = [...g.models];
    if (g.filter_free) c = c.filter(r => getM(r).cost_per_m === 0);
    return c.filter(r => !isLimited(r));
  }

  function sortBy(models: string[], method: string): string[] {
    const s = [...models];
    if (method === "min_latency") return s.sort((a, b) => getM(a).avg_latency_ms - getM(b).avg_latency_ms);
    if (method === "max_throughput") return s.sort((a, b) => getM(b).throughput_tps - getM(a).throughput_tps);
    if (method === "min_cost") return s.sort((a, b) => effCost(a) - effCost(b));
    if (method === "max_gdpval") return s.sort((a, b) => getM(b).gdpval - getM(a).gdpval);
    if (method === "roundrobin") return s; // handled in resolve
    return s; // failover: preserve order
  }

  function resolve(name: string): { selected: string; candidates: string[] } | null {
    const g = cfg.model_groups[name];
    if (!g) return null;
    let c = available(g);
    if (!c.length) return null;

    if (g.method === "pipeline" && g.pipeline) {
      for (const step of g.pipeline) { c = sortBy(c, step.method); if (step.top_k && step.top_k < c.length) c = c.slice(0, step.top_k); }
    } else if (g.method === "roundrobin") {
      const i = (rrCounters[name] ?? 0) % c.length; rrCounters[name] = i + 1;
      c = [...c.slice(i), ...c.slice(0, i)];
    } else {
      c = sortBy(c, g.method); if (g.top_k && g.top_k < c.length) c = c.slice(0, g.top_k);
    }
    return { selected: c[0], candidates: c };
  }

  // ── Format ─────────────────────────────────────────────────────────────

  function fmtModel(ref: string, i: number, sel: boolean) {
    const m = getM(ref), prov = ref.split("/")[0], mux = costMux(prov);
    const billing = cfg.providers?.[prov]?.billing === "subscription" ? "sub" : m.cost_per_m === 0 ? "free" : "ppt";
    const muxS = mux > 1 ? ` ×${mux}` : "";
    const rl = isLimited(ref) ? ` ⛔${limitSecs(ref)}s` : "";
    return `${i + 1}. ${ref}  gdp:${m.gdpval}  tps:${Math.round(m.throughput_tps)}  eff:$${effCost(ref).toFixed(3)}/M  [${billing}${muxS}]${rl}${sel ? " ←" : ""}`;
  }

  // Get top N models for a group, including rate-limited ones (for display)
  // The final pipeline step sorts but doesn't limit — we want to see failover options
  function getTopModels(groupName: string, n: number): { ref: string; limited: boolean; rank: number }[] {
    const g = cfg.model_groups[groupName];
    if (!g) return [];
    let c = [...g.models];
    if (g.filter_free) c = c.filter(r => getM(r).cost_per_m === 0);

    // Sort using the group's method but DON'T filter out limited models
    if (g.method === "pipeline" && g.pipeline) {
      for (let i = 0; i < g.pipeline.length; i++) {
        const step = g.pipeline[i];
        c = sortBy(c, step.method);
        // Only apply top_k for intermediate steps, not the final one (it's a ranker, not a limiter)
        const isLastStep = i === g.pipeline.length - 1;
        if (step.top_k && step.top_k < c.length && !isLastStep) {
          c = c.slice(0, step.top_k);
        }
      }
    } else {
      c = sortBy(c, g.method);
      // For non-pipeline, don't limit either — show full ranked list
    }

    // Split into available and limited, then interleave: available first, then limited
    const available = c.filter(ref => !isLimited(ref));
    const limited = c.filter(ref => isLimited(ref));
    const ranked = [...available, ...limited];

    return ranked.slice(0, n).map((ref, i) => ({ ref, limited: isLimited(ref), rank: i }));
  }

  function detectGroup(ref: string): string | null {
    if (activeGroup) return activeGroup;
    for (const [n, g] of Object.entries(cfg.model_groups)) if (g.models.includes(ref)) return n;
    return null;
  }

  // ── Events ─────────────────────────────────────────────────────────────

  load(); loadCache();

  pi.on("session_start", async (_ev, ctx) => {
    load(); loadCache(); sessionStart = Date.now();
    discoverKeys();
    scan().catch(() => {});

    // Footer
    ctx.ui.setFooter((tui, theme, fd) => {
      const unsub = fd.onBranchChange(() => tui.requestRender());
      const timer = setInterval(() => tui.requestRender(), 30000);
      return {
        dispose() { unsub(); clearInterval(timer); },
        invalidate() {},
        render(w: number): string[] {
          const ref = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
          const grp = ref ? detectGroup(ref) : null;
          const m = ref ? getM(ref) : null;
          const rStr = theme.fg("accent", `${grp ?? "—"}/${ctx.model?.provider ?? "?"}/${ctx.model?.id ?? "?"}`);
          const iStr = m ? theme.fg("warning", `int:${m.gdpval}`) : "";
          const tStr = m ? theme.fg("success", `tps:${Math.round(m.throughput_tps)}`) : "";

          let inp = 0, out = 0, cost = 0;
          for (const e of ctx.sessionManager.getBranch()) {
            if (e.type === "message" && e.message.role === "assistant") {
              const a = e.message as AssistantMessage; inp += a.usage.input; out += a.usage.output; cost += a.usage.cost.total;
            }
          }
          const u = ctx.getContextUsage(), pct = u?.percent ?? 0;
          const pCol = pct > 75 ? "error" : pct > 50 ? "warning" : "success";
          const tok = [theme.fg("accent", `${fmt(inp)}/${fmt(out)}`), theme.fg("warning", `$${cost.toFixed(2)}`), theme.fg(pCol, `${pct.toFixed(0)}%`)].join(" ");
          const el = theme.fg("dim", `⏱${fmtTime(Date.now() - sessionStart)}`);
          const pp = process.cwd().split("/"); const cwd = theme.fg("muted", `⌂ ${pp.length > 2 ? pp.slice(-2).join("/") : process.cwd()}`);
          const br = fd.getGitBranch(); const brS = br ? theme.fg("accent", `⎇ ${br}`) : "";
          const rlN = [...limits.keys()].filter(r => isLimited(r)).length;
          const rlS = rlN > 0 ? theme.fg("error", `⛔${rlN}`) : "";

          const sep = theme.fg("dim", " | ");
          const parts = [rStr]; if (iStr && tStr) parts.push(`${iStr} ${tStr}`);
          parts.push(tok, el, cwd); if (brS) parts.push(brS); if (rlS) parts.push(rlS);
          return [truncateToWidth(parts.join(sep), w)];
        },
      };
    });
  });

  pi.on("session_switch", async (ev) => { if (ev.reason === "new") sessionStart = Date.now(); });
  pi.on("model_select", async (ev) => { if (ev.source !== "restore") activeGroup = null; curModel = `${ev.model.provider}/${ev.model.id}`; });
  pi.on("turn_start", async (_ev, ctx) => { turnStart = Date.now(); if (ctx.model) curModel = `${ctx.model.provider}/${ctx.model.id}`; });

  pi.on("turn_end", async (ev) => {
    if (!curModel || !turnStart) return;
    const ms = Date.now() - turnStart, msg = ev.message;
    if (msg?.role === "assistant") {
      const txt = typeof msg.content === "string" ? msg.content : (msg.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      const tok = Math.ceil(txt.length / 4);
      if (tok > 0) { updateMetrics(curModel, ms, tok, ms); recordOk(curModel); }
    }
  });

  pi.on("tool_result", async (ev, ctx) => {
    if (ev.isError && curModel) {
      const txt = ev.content?.map((c: any) => c.text ?? "").join("") ?? "";
      if (txt.includes("429") || txt.toLowerCase().includes("rate limit")) {
        const result = recordLimit(curModel);
        if (result.rotated) {
          ctx.ui.notify(`🔑 Rate limited — rotated ${splitRef(curModel).provider} to key "${result.newKey}"`, "warning");
        }
      }
    }
  });

  let turns = 0;
  pi.on("turn_end", async () => { if (++turns % 10 === 0) saveCache(); });
  pi.on("session_shutdown", async () => saveCache());

  // ── Tools ──────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "set_model_from_group", label: "Set Model from Group",
    description: "Resolve a model group and immediately switch the current session to use the selected model. Combines resolve_model_group + model switch in one step.",
    promptGuidelines: ["When spawning subagents or selecting models for tasks, use resolve_model_group with the appropriate tier: strategic (best quality), tactical (quality/cost balance), operational (throughput/cost), scout (cheapest)."],
    parameters: Type.Object({ group: Type.String({ description: "Model group name" }) }),
    async execute(_id, params, _sig, _up, ctx) {
      load();
      const name = params.group.toLowerCase(), res = resolve(name);
      if (!res) throw new Error(`No models for group "${params.group}". Available: ${Object.keys(cfg.model_groups).join(", ")}`);
      for (const ref of res.candidates) {
        const { provider, modelId } = splitRef(ref);
        const model = ctx.modelRegistry.find(provider, modelId);
        if (model && await pi.setModel(model)) {
          activeGroup = name; const m = getM(ref);
          return { content: [{ type: "text", text: `${ref} (${name}, gdp:${m.gdpval}, tps:${Math.round(m.throughput_tps)})` }], details: { group: name, selected: ref, provider, modelId } };
        }
      }
      throw new Error(`No available model in "${name}". Tried: ${res.candidates.join(", ")}`);
    },
  });

  pi.registerTool({
    name: "resolve_model_group", label: "Resolve Model Group",
    description: "Resolve a model group name (strategic, tactical, operational, scout, fallback) to a concrete provider/model. Use this when you need to select a model for a subagent or task and want the router to pick the best one.",
    parameters: Type.Object({ group: Type.String({ description: "Model group name: strategic, tactical, operational, scout, fallback, or any custom group" }) }),
    async execute(_id, params) {
      load();
      const name = params.group.toLowerCase(), res = resolve(name);
      if (!res) throw new Error(`Unknown or empty group "${params.group}". Available: ${Object.keys(cfg.model_groups).join(", ")}`);
      const { provider, modelId } = splitRef(res.selected);
      const table = res.candidates.map((r, i) => fmtModel(r, i, i === 0)).join("\n");
      return { content: [{ type: "text", text: `"${name}" (${cfg.model_groups[name].method}) → ${res.selected}\n\n${table}` }], details: { group: name, selected: res.selected, provider, modelId, candidates: res.candidates } };
    },
  });

  pi.registerTool({
    name: "update_model_metrics", label: "Update Model Metrics",
    description: "Update runtime metrics (gdpval, throughput, latency) for a model in the router config.",
    parameters: Type.Object({ model_ref: Type.String({ description: "Model reference (provider/model-id)" }), gdpval: Type.Optional(Type.Number()), throughput_tps: Type.Optional(Type.Number()), avg_latency_ms: Type.Optional(Type.Number()) }),
    async execute(_id, p) {
      load(); const e = cfg.model_metrics[p.model_ref] ?? {};
      if (p.gdpval !== undefined) e.gdpval = p.gdpval; if (p.throughput_tps !== undefined) e.throughput_tps = p.throughput_tps; if (p.avg_latency_ms !== undefined) e.avg_latency_ms = p.avg_latency_ms;
      cfg.model_metrics[p.model_ref] = e; fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      if (metrics[p.model_ref]) Object.assign(metrics[p.model_ref], e, { last_updated: Date.now() });
      return { content: [{ type: "text", text: `Updated ${p.model_ref}: ${JSON.stringify(e)}` }], details: { model_ref: p.model_ref, metrics: e } };
    },
  });

  // ── Command: /router ───────────────────────────────────────────────────

  pi.registerCommand("router", {
    description: "Model router status. Usage: /router [group|scan|reload]",
    handler: async (args, ctx) => {
      load();
      const arg = args?.trim();
      if (arg === "reload") { load(); loadCache(); ctx.ui.notify("Reloaded", "success"); return; }
      if (arg === "scan") { ctx.ui.notify("Scanning...", "info"); await scan(true); ctx.ui.notify(`Done. ${Object.keys(gdpval).length} scores, ${cache.available_models?.length ?? 0} models.`, "success"); return; }

      if (arg && cfg.model_groups[arg]) {
        const g = cfg.model_groups[arg], res = resolve(arg);
        const desc = g.method === "pipeline" ? `pipeline(${g.pipeline!.map(s => `${s.method}:${s.top_k ?? "∞"}`).join("→")})` : g.method;
        const lines = [`${arg} | ${desc}`, g.description ?? "", ""];
        if (res) res.candidates.forEach((r, i) => lines.push(fmtModel(r, i, i === 0)));
        else lines.push("(no available models)");
        ctx.ui.notify(lines.filter(Boolean).join("\n"), "info"); return;
      }

      // Overview with table
      const lines: string[] = ["Model Router", ""];

      // Group tables with top 5 models (3 available + up to 2 limited)
      for (const [groupName, g] of Object.entries(cfg.model_groups)) {
        const top = getTopModels(groupName, 5);
        const method = g.method === "pipeline"
          ? g.pipeline!.map(s => `${s.method}${s.top_k ? `:${s.top_k}` : ""}`).join(" → ")
          : g.method;
        const active = curModel && g.models.includes(curModel);
        const activeMarker = active ? " ◀" : "";

        // Group header
        lines.push(`┌─ ${groupName}${activeMarker} `.padEnd(72, "─") + ` ${method} ─`);

        if (top.length === 0) {
          lines.push("│ (no models configured)");
        } else {
          // Table header
          lines.push("│ #   Model                           GDP    Lat    TPS    Cost/M   Mux   Status");
          lines.push("│ ─   ─────────────────────────────   ───    ───    ───    ───────   ───   ──────");

          for (const { ref, limited, rank } of top) {
            const m = getM(ref);
            const prov = ref.split("/")[0];
            const mux = costMux(prov);
            const cost = effCost(ref);
            const modelShort = ref.length > 32 ? "…" + ref.slice(-31) : ref;
            const isActive = curModel === ref ? "●" : " ";
            const status = limited ? `⛔${limitSecs(ref)}s` : isActive ? "active" : "";
            const muxStr = mux > 1 ? `×${mux}` : "1";

            lines.push(`│ ${rank + 1}   ${modelShort.padEnd(32)} ${String(m.gdpval).padStart(4)}   ${String(Math.round(m.avg_latency_ms)).padStart(4)}   ${String(Math.round(m.throughput_tps)).padStart(3)}   $${cost.toFixed(2).padStart(6)}   ${muxStr.padStart(3)}   ${status}`);
          }
        }
        lines.push("│");
      }

      // Rate-limited summary
      const rl = [...limits.keys()].filter(r => isLimited(r));
      if (rl.length) {
        lines.push("├─ Rate Limited ".padEnd(72, "─"));
        for (const r of rl) {
          const { provider, modelId } = splitRef(r);
          lines.push(`│ ⛔ ${provider}/${modelId} (${limitSecs(r)}s remaining)`);
        }
      }

      lines.push("└" + "─".repeat(71));
      lines.push("", "/router <group> | scan | reload");
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
