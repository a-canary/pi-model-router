# pi-model-router

> Pi extension that routes model group names to concrete provider/model pairs. Balances intelligence (GDPval), cost, and availability automatically.

## Install

```bash
# As a pi extension (symlink)
ln -s ~/pi-model-router ~/.pi/agent/extensions/pi-model-router

# Or via npm (coming soon)
pi install npm:pi-model-router
```

Then `/reload` in pi.

## How It Works

### Selection Pipeline

Each model group defines a **pipeline** of sorting/filtering steps. For example, `strategic` uses:

```
max_gdpval top_k:2 → min_cost top_k:1
```

This means: rank all candidates by GDPval (intelligence score), keep the top 2, then pick the cheapest. The result is the smartest affordable model.

### Effective Cost

```
effectiveCost = (baseCost || 0.01) × subDiscount(0.5) × costMux[provider]
```

- **baseCost**: per-million-token cost (free models get 0.01 so costMux still differentiates them)
- **subDiscount**: 0.5× multiplier for subscription providers (sunk cost preference)
- **costMux**: permanent per-provider multiplier that increases on repeated rate limits

### Auto-Discovery (24 Providers)

On startup, the router automatically discovers API keys from three sources:

| Source | Example | Label |
|--------|---------|-------|
| Environment variables | `ANTHROPIC_API_KEY=sk-...` | `env:ANTHROPIC_API_KEY` |
| `~/.pi/agent/auth.json` | `{ "anthropic": { "key": "..." } }` | `auth.json` |
| Pass store (`pass ls`) | `api/claude/oauth-token` | `pass:api/claude/oauth-token` |

**Supported providers:** anthropic, openai, google, openrouter, chutes, mistral, groq, cerebras, xai, zai, huggingface, kimi-coding, minimax, minimax-cn, opencode, opencode-go, vercel-ai-gateway, azure-openai, deepseek, github-copilot, gemini-cli, antigravity, ollama, lm-studio

Discovered keys merge into the in-memory provider config (config file keys take priority). Local providers (ollama, lm-studio) are detected without keys. Use `/router` to see all discovered providers and their key counts.

### Multi-Key Rotation

Providers can have multiple API keys or OAuth tokens. On 429, the router first tries rotating to the next available key — avoiding model-level backoff entirely:

```jsonc
"providers": {
  "anthropic": {
    "billing": "subscription",
    "keys": [
      { "key": "!pass show api/claude/token-1", "label": "primary" },
      { "key": "!pass show api/claude/token-2", "label": "backup" }
    ]
  }
}
```

On rate limit:
1. Current key marked exhausted (1hr cooldown)
2. Next available key activated → `~/.pi/agent/auth.json` updated → no model backoff needed
3. If all keys exhausted → falls through to model-level backoff below

Keys support `!pass show <path>` syntax for secret resolution via `pass`.

### Rate Limit Handling

On HTTP 429 (after key rotation is exhausted or unavailable), the model enters exponential backoff and the router fails over to the next candidate:

| Hit | Cooldown | Side Effect |
|-----|----------|-------------|
| 1   | 1 min    | Failover only |
| 2   | 2 min    | |
| 3   | 4 min    | |
| 4   | 8 min    | **costMux[provider] += 1** (max 1/day) |
| 5   | 16 min   | |
| 6   | 32 min   | |
| 7   | 64 min   | |
| 8+  | 90 min   | Cap |

On success, the consecutive hit count resets. costMux never decays — providers that rate-limit you stay deprioritized permanently.

### Passive Metrics

The router passively observes every turn to track:
- **Throughput** (tokens/sec) — EMA with α=0.3
- **Latency** (ms) — EMA with α=0.3
- **GDPval** — scraped from [Artificial Analysis](https://artificialanalysis.ai/evaluations/gdpval-aa) on first run, with hardcoded fallbacks

No probes, no health checks. 429 responses are the only signal.

## Model Groups

| Group | Pipeline | Pool | Use For |
|-------|----------|------|---------|
| **strategic** | `max_gdpval:2 → min_cost:1` | Top models across providers | Critical decisions, architecture |
| **tactical** | `max_gdpval:4 → min_cost:1` | Wider pool | Planning, coordination |
| **operational** | `max_gdpval:8 → min_cost:1` | Broad pool | Coding, execution |
| **scout** | `max_gdpval:16 → min_cost:1` | Free models only | Exploration, recon |
| **fallback** | `failover` (ordered) | Minimal chain | Last resort |

## Configuration

Edit `router-config.json`:

```jsonc
{
  "providers": {
    "anthropic": { "billing": "subscription" },
    "chutes": { "billing": "subscription" },
    "openrouter": { "billing": "pay_per_token" }
  },
  "model_groups": {
    "strategic": {
      "method": "pipeline",
      "pipeline": [
        { "method": "max_gdpval", "top_k": 2 },
        { "method": "min_cost", "top_k": 1 }
      ],
      "models": ["anthropic/claude-opus-4-6-20250514", "chutes/zai-org/GLM-5-TEE", "..."]
    }
  },
  "model_metrics": {
    "anthropic/claude-opus-4-6-20250514": {
      "gdpval": 1450, "throughput_tps": 80, "avg_latency_ms": 2000
    }
  }
}
```

### Pipeline Methods

| Method | Sorts By | Direction |
|--------|----------|-----------|
| `max_gdpval` | Intelligence score | Descending |
| `min_cost` | Effective cost | Ascending |
| `max_throughput` | Tokens/sec | Descending |
| `min_latency` | Response time | Ascending |
| `roundrobin` | Rotating index | — |
| `failover` | Config order | — |

### Group Options

- **`filter_free: true`** — Only consider models with cost_per_m = 0 (used by `scout`)
- **`top_k`** — Limit candidates at each pipeline step

## Tools

The extension registers three tools available to the pi agent:

| Tool | Purpose |
|------|---------|
| `set_model_from_group` | Resolve group → switch session to best model |
| `resolve_model_group` | Read-only: preview what a group would resolve to |
| `update_model_metrics` | Manual metric override (gdpval, tps, latency) |

## Commands

| Command | Description |
|---------|-------------|
| `/router` | Overview: providers, groups, current selections, rate limits |
| `/router <group>` | Detailed view of a specific group with ranked candidates |
| `/router scan` | Re-scrape GDPval scores + refresh free model lists |
| `/router reload` | Hot-reload config and cache from disk |

## Footer

The router replaces the default pi footer with a rich status line:

```
strategic/anthropic/claude-opus-4-6 | int:1450 tps:80 | 12k/8k $1.43 62% | ⏱14m | ⌂ proj | ⎇ main | ⛔2
```

Fields: `group/provider/model | intelligence throughput | tokens_in/out cost context% | elapsed | cwd | branch | rate_limited_count`

## Scanning

On session start, the router runs a background scan:
- **GDPval scores**: scraped once (cached forever) from Artificial Analysis
- **Free models**: fetched from Chutes + OpenRouter APIs (cached 24hr)
- Builtin GDPval fallbacks for 30+ models ensure routing works offline

## Data Flow

```
session_start  → load config + cache, background scan, set footer
turn_start     → record timestamp + model ref
turn_end       → update throughput/latency EMA, mark success
tool_result    → detect 429 → backoff + costMux at 4th consecutive hit
```

The router is fully passive — it only acts when `set_model_from_group` is called or a 429 is detected.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry point (~450 lines) |
| `router-config.json` | Groups, providers, seed metrics |
| `.cache/scan-cache.json` | GDPval scores, model lists, benchmarks, costMux |
| `PI.md` | Design document (source of truth) |

## License

MIT
