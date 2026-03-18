import { describe, it, expect } from "vitest";

/**
 * Extracted pass tree parsing logic for testability.
 * Must stay in sync with parsePassTree() in index.ts.
 */
function parsePassOutput(raw: string): string[] {
  const lines = raw.split("\n");
  const stack: string[] = [];
  const entries: string[] = [];
  for (let line of lines) {
    // Strip ANSI escape codes (colors from pass ls output)
    line = line.replace(/\x1b\[[0-9;]*m/g, "");
    if (line === "Password Store" || !line.trim()) continue;
    const stripped = line.replace(/[│├└─\s]/g, "");
    if (!stripped) continue;
    // Depth: count non-alphanumeric prefix chars, divide by 4 (each tree level is 4 chars)
    const depth = Math.floor((line.length - line.replace(/^[^a-zA-Z0-9]+/, "").length) / 4);
    stack.length = depth;
    stack[depth] = stripped;
    entries.push(stack.filter(Boolean).join("/"));
  }
  return entries;
}

describe("parsePassTree", () => {
  it("parses clean tree output (no ANSI codes)", () => {
    const input = `Password Store
├── api
│   ├── claude
│   │   └── oauth-token
│   ├── openrouter
│   │   └── api-key
│   └── chutes
│       └── api-key
└── discord
    └── bot-token`;

    const entries = parsePassOutput(input);
    expect(entries).toContain("api");
    expect(entries).toContain("api/claude");
    expect(entries).toContain("api/claude/oauth-token");
    expect(entries).toContain("api/openrouter");
    expect(entries).toContain("api/openrouter/api-key");
    expect(entries).toContain("api/chutes");
    expect(entries).toContain("api/chutes/api-key");
    expect(entries).toContain("discord");
    expect(entries).toContain("discord/bot-token");
  });

  it("handles ANSI color codes in directory names", () => {
    const input = `Password Store
├── \x1b[01;34mapi\x1b[0m
│   ├── \x1b[01;34mopenrouter\x1b[0m
│   │   └── api-key
│   └── \x1b[01;34mchutes\x1b[0m
│       └── api-key`;

    const entries = parsePassOutput(input);
    expect(entries).toContain("api/openrouter/api-key");
    expect(entries).toContain("api/chutes/api-key");
  });

  it("handles non-breaking spaces (\\xa0) in tree prefixes", () => {
    // Real pass output uses \xa0 (non-breaking space) in some positions
    const nbsp = "\u00a0";
    const input = `Password Store
├── api
│${nbsp}${nbsp} ├── openrouter
│${nbsp}${nbsp} │${nbsp}${nbsp} └── api-key`;

    const entries = parsePassOutput(input);
    expect(entries).toContain("api");
    expect(entries).toContain("api/openrouter");
    expect(entries).toContain("api/openrouter/api-key");
  });

  it("handles combined ANSI codes + non-breaking spaces", () => {
    const nbsp = "\u00a0";
    const input = `Password Store
├── \x1b[01;34mapi\x1b[0m
│${nbsp}${nbsp} ├── \x1b[01;34mopenrouter\x1b[0m
│${nbsp}${nbsp} │${nbsp}${nbsp} └── api-key`;

    const entries = parsePassOutput(input);
    expect(entries).toContain("api/openrouter");
    expect(entries).toContain("api/openrouter/api-key");
  });

  it("pattern matching works for discoverKeys", () => {
    const entries = parsePassOutput(`Password Store
├── api
│   ├── openrouter
│   │   └── api-key
│   └── chutes
│       └── api-key`);

    const orPattern = "api/openrouter";
    const orMatches = entries.filter(e => e.startsWith(orPattern + "/") || e === orPattern);
    expect(orMatches).toContain("api/openrouter");
    expect(orMatches).toContain("api/openrouter/api-key");

    const chPattern = "api/chutes";
    const chMatches = entries.filter(e => e.startsWith(chPattern + "/") || e === chPattern);
    expect(chMatches).toContain("api/chutes");
    expect(chMatches).toContain("api/chutes/api-key");
  });

  it("deeply nested paths maintain correct depth", () => {
    const input = `Password Store
├── alpaca
│   ├── live
│   │   ├── api-key-id
│   │   └── api-secret-key
│   └── paper
│       ├── api-key-id
│       └── api-secret-key`;

    const entries = parsePassOutput(input);
    expect(entries).toContain("alpaca/live/api-key-id");
    expect(entries).toContain("alpaca/live/api-secret-key");
    expect(entries).toContain("alpaca/paper/api-key-id");
    expect(entries).toContain("alpaca/paper/api-secret-key");
  });

  it("empty output returns empty array", () => {
    expect(parsePassOutput("Password Store\n")).toEqual([]);
    expect(parsePassOutput("")).toEqual([]);
  });
});
