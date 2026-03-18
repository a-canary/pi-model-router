---
name: router-login
description: Guide through adding a new AI provider to pi-model-router. Discovers API keys, validates connectivity, and registers the provider for auto-discovery. Use when user runs /router login or wants to add a new provider.
---

# Router Login — Add a New Provider

## Overview

Walk the user through connecting a new AI provider to the model router. The router auto-discovers models and pricing, so this is purely about authentication.

## Steps

### 1. Identify the provider

Ask which provider to add. Show the known providers from `PROVIDER_MAP` in `index.ts` that don't yet have valid keys configured.

```bash
# Check which providers already have keys
cat ~/.pi/agent/auth.json
```

### 2. Obtain the API key

Guide based on provider type:

| Provider | How to get a key |
|----------|-----------------|
| anthropic | https://console.anthropic.com/settings/keys — or use OAuth via `pi auth anthropic` |
| openai | https://platform.openai.com/api-keys |
| google | https://aistudio.google.com/apikey |
| openrouter | https://openrouter.ai/keys |
| mistral | https://console.mistral.ai/api-keys |
| deepseek | https://platform.deepseek.com/api_keys |
| groq | https://console.groq.com/keys |
| cerebras | https://cloud.cerebras.ai/platform |
| xai | https://console.x.ai |
| chutes | https://chutes.ai/app/api-keys — subscription required |
| huggingface | https://huggingface.co/settings/tokens |

For CLI-auth providers (qwen-cli, gemini-cli):
- These use OAuth via their CLI tools, not API keys
- Auth is stored in `~/.qwen/oauth_creds.json` or `~/.gemini/oauth_creds.json`
- Run `qwen auth login` or `gemini auth login` to authenticate
- Tokens expire and need periodic refresh

For providers not listed, ask the user for:
1. The API key
2. The base URL (if non-standard)

### 3. Store the key securely

**Preferred: `pass` (password store)**
```bash
# Store in pass for secure retrieval
pass insert api/<provider-name>
# Then reference in router-config.json:
# { "key": "!pass show api/<provider-name>", "label": "primary" }
```

**Alternative: auth.json**
```bash
# pi's built-in auth — stored at ~/.pi/agent/auth.json
pi auth <provider-name>
```

**Alternative: environment variable**
```bash
# Export the env var — the router discovers it automatically
export <PROVIDER_ENV_VAR>=sk-...
```

The router auto-discovers keys from all three sources (pass, auth.json, env vars) on startup via `discoverKeys()`. No manual config editing required for basic setup.

### 4. Validate connectivity

After the key is stored, verify:

```bash
# Force a model scan to discover available models
# The router's scan() function will hit the provider's /v1/models endpoint
```

Ask the user to run `/router scan` or restart pi. Then check:
- Does the provider appear in `/router` output?
- Are models listed for the provider?
- Is key health showing "valid"?

### 5. Register models (if no auto-discovery)

Some providers (qwen-cli, gemini-cli, ollama, antigravity) don't have scannable `/v1/models` endpoints. For these, models must be registered manually in `router-config.json` under `model_metrics`:

```json
{
  "model_metrics": {
    "qwen-cli/qwen3-coder-plus": {
      "gdpval": 944,
      "throughput_tps": 120,
      "avg_latency_ms": 1000
    }
  }
}
```

Ask the user which models they want to use. Look up gdpval scores from the `/router` display or https://www.gdpval.com.

For providers with `modelsUrl` in PROVIDER_MAP (anthropic, openai, google, mistral, deepseek), this step is automatic.

### 6. Verify pricing

Models should appear with pricing. Pricing sources (in priority order):
1. `cost_per_m` set in `model_metrics` config
2. Direct pricing from the provider's API (Chutes)
3. Backfill from OpenRouter's paid pricing for the same model name

If pricing still shows `$0.0` for a paid model, set `cost_per_m` ($/1M input tokens) in `model_metrics`.

Check: "Does `/router` show correct pricing for the new provider's models?"

### 7. Confirm group selection

The new models automatically participate in group selection based on their gdpval scores:
- **strategic**: best available model by intelligence
- **tactical**: top 25% quality, cheapest by billing preference
- **operational**: top 50% quality, cheapest by billing preference  
- **scout**: top 25% quality, cheapest by billing preference
- **fallback**: any available, cheapest by billing preference

Billing preference order: free → subscription → local → pay-per-token

Ask: "Run `/router` to verify the new models appear in the appropriate groups."

## Checklist

- [ ] Provider identified
- [ ] API key obtained (or CLI OAuth completed)
- [ ] Key stored securely (pass / auth.json / env var / CLI auth)
- [ ] Connectivity validated — models discovered or manually registered
- [ ] Models registered in `model_metrics` (if no auto-discovery)
- [ ] Pricing verified — not showing $0.0 for paid models
- [ ] Group selection confirmed — models appear in expected tiers
