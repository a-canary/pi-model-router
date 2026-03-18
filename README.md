# pi-model-router

> Pi extension that routes model group names to concrete provider/model pairs. Auto-discovers models and pricing. Balances intelligence (GDPval), cost, and availability.

## Install

```bash
pi install git:github.com/a-canary/pi-model-router
# Or symlink for development
ln -s ~/pi-model-router ~/.pi/agent/extensions/pi-model-router
```

Then `/reload` in pi.

## How It Works

### Auto-Discovery

On startup, the router automatically:

1. **Discovers API keys** from env vars, `~/.pi/agent/auth.json`, `pass` store, and CLI OAuth files (qwen, gemini)
2. **Scans models** from Chutes, OpenRouter, and direct provider APIs (Anthropic, OpenAI, Google, Mistral, DeepSeek)
3. **Scrapes GDPval scores** from [Artificial Analysis](https://artificialanalysis.ai/evaluations/gdpval-aa) with hardcoded fallbacks
4. **Caches pricing** per provider/model from APIs, with OpenRouter backfill for providers without pricing endpoints

All scanning is async and non-blocking.

### Group Selection

Each group auto-discovers available models, filters by quality, and selects by billing preference:

| Group | Method | Quality Filter | Use For |
|-------|--------|---------------|---------|
| **strategic** | `best` | — | Best model available. Critical decisions. |
| **tactical** | `tiered` | ≥75th pct | Top quality, cost-optimized. Planning. |
| **operational** | `tiered` | ≥50th pct | Good quality, cheapest. Daily coding. |
| **scout** | `tiered` | ≥25th pct | Acceptable quality, cheapest. Exploration. |
| **fallback** | `tiered` | ≥0th pct | Any available. Last resort. |

**Billing preference**: free → subscription (lowest rate-limit pressure) → local → pay-per-token (by cost)

No curated model lists. Groups draw from all discovered models automatically.

### Rate Limits & Failover

On HTTP 429:
1. **Key rotation** — try next API key for the provider (1hr cooldown on current key)
2. **Model backoff** — exponential (1m→2m→4m→...→90m cap), immediate failover to next candidate
3. **costMux** — on 4th consecutive 429, provider gets permanent cost penalty

### Stream Retry

Group streams detect soft failures (empty responses, timeouts) and automatically retry with the next candidate model.

## Configuration

`router-config.json`:

```jsonc
{
  "providers": {
    "anthropic": { "billing": "subscription", "keys": [{ "key": "!pass show api/claude/token" }] },
    "chutes": { "billing": "subscription" },
    "openrouter": { "billing": "pay_per_token" }
  },
  "model_groups": {
    "strategic": { "method": "best" },
    "tactical": { "method": "tiered", "min_gdpval_pct": 75 },
    "scout": { "method": "tiered", "min_gdpval_pct": 25 }
  },
  "model_metrics": {}
}
```

Groups need no `models` arrays — everything is auto-discovered.

### Adding a Provider

Use the built-in skill: `/skill:router-login`

Or manually:
1. Set API key via env var, `pass`, or `pi auth <provider>`
2. Restart pi — the router discovers keys and scans models automatically

### Supported Providers (24)

anthropic, openai, google, openrouter, chutes, mistral, groq, cerebras, xai, zai, huggingface, kimi-coding, minimax, minimax-cn, opencode, opencode-go, vercel-ai-gateway, azure-openai, deepseek, github-copilot, qwen-cli, gemini-cli, ollama, lm-studio

## Commands

| Command | Description |
|---------|-------------|
| `/router` | Overview: providers, groups, selections, rate limits |
| `/router <group>` | Detailed view of a group with ranked candidates |
| `/router scan` | Re-scan models and GDPval scores |
| `/router reload` | Hot-reload config and cache |

## Tools

| Tool | Purpose |
|------|---------|
| `set_model_from_group` | Switch session to best model from a group |
| `resolve_model_group` | Preview what a group would resolve to |
| `update_model_metrics` | Manual metric override |

## Footer

```
strategic/anthropic/claude-opus-4-6 | int:1450 tps:80 | 12k/8k $1.43 62% | ⏱14m | ⌂ proj | ⎇ main | ⛔2
```

## License

MIT
