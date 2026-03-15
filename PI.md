# pi-model-router

Route model group names (strategic, tactical, operational, scout) to concrete provider/model pairs. Balance intelligence, cost, and availability automatically.

## Core loop

1. Groups define candidate pool + selection pipeline (`max_gdpval top_k → min_cost`)
2. `effectiveCost = (baseCost || 0.01) × subDiscount(0.5) × costMux[provider]`
3. On 429: exponential backoff per model (1m→2m→4m→8m→16m→32m→64m→90m cap), immediate failover
4. On 4th consecutive 429: `costMux[provider] += 1` (max 1/day, validated, never decays)
5. On success: reset model's consecutive hit count

## Files

```
index.ts              ~450 lines. Extension entry point.
router-config.json    Groups, providers, seed metrics.
.cache/scan-cache.json  GDPval (forever), models (24hr), benchmarks, costMux.
PI.md                 This file. Design source of truth.
README.md             Quick-start reference.
```

## Data flow (passive except set_model_from_group tool)

```
session_start → load config + cache, background scan
turn_start    → record time + model ref
turn_end      → update throughput/latency EMA, recordSuccess
tool_result   → detect 429 → backoff + costMux at 4th hit
```

## Key functions

- `resolve(name)` → pipeline sort, filter rate-limited → {selected, candidates}
- `effCost(ref)` → base × subDiscount × costMux
- `recordLimit(ref)` → backoff schedule + costMux bump at hit 4
- `recordOk(ref)` → reset hit count
- `lookupGdp(id)` → fuzzy match normalized model name against score table
- `scan()` → scrape GDPval (once forever) + fetch free models (24hr)

## Backoff schedule

| Hit | Cooldown | Effect |
|-----|----------|--------|
| 1 | 1m | failover |
| 2 | 2m | |
| 3 | 4m | |
| 4 | 8m | **costMux[provider] += 1** |
| 5-7 | 16-64m | |
| 8+ | 90m cap | |

Guards: max 1 costMux bump/provider/day. Validates provider still hosts model. Never decays.

## Config shape

```jsonc
{
  "providers": { "<name>": { "billing": "subscription|pay_per_token" } },
  "model_groups": {
    "<name>": {
      "method": "pipeline",
      "pipeline": [{ "method": "max_gdpval", "top_k": N }, { "method": "min_cost", "top_k": 1 }],
      "models": ["provider/model-id", ...],
      "filter_free": false
    }
  },
  "model_metrics": { "<provider/model-id>": { "gdpval": N, "throughput_tps": N, "avg_latency_ms": N } }
}
```

## Footer

```
{group}/{provider}/{modelId} | int:{gdpval} tps:{tps} | {in}/{out} ${cost} {ctx%} | ⏱{time} | ⌂ {cwd} | ⎇ {branch} | ⛔{N}
```

Replaces `~/.pi/agent/extensions/custom-footer.ts` (disabled to `.disabled`).

## Tools

| Tool | Purpose |
|------|---------|
| `set_model_from_group` | Switch session to best model from a group |
| `resolve_model_group` | Read-only: what would a group resolve to? |
| `update_model_metrics` | Manual metric override (rarely needed) |

## What NOT to add

- Token budget tracking (providers don't expose limits)
- Proactive load balancing (429 is the signal)
- Auto-switching mid-session (only via explicit tool call)
- Complex health checks (backoff + costMux is sufficient)
