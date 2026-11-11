# magpie-strip-harness

English | [简体中文](README.zh-CN.md)

A [magpie](https://usemagpie.ai) gateway middleware that strips **harness-injected identity prompts** from the `system` role of agent requests before they are routed to any provider. It is entirely **config-driven**: the middleware knows nothing about any particular harness — you describe what to remove with `patterns`, and the same machinery works for DeepSeek Harness, ZCode, or your own agent.

It edits requests only; replies and stream events pass through untouched. It applies to every provider behind the magpie gateway.

## Why

Agent harnesses typically prepend identity framing to the system prompt — an opener ("You are X, an interactive agent"), product headings, workspace paths, or embedded API names. Through a reverse proxy that framing is visible to the upstream model. This middleware removes it at the gateway so you do not have to touch every client's config.

The tricky part is that identity tokens are often mixed into lines that also carry **executable rules**. Dropping whole paragraphs would delete those rules, so `patterns` supports both paragraph-level deletion and precise line-level deletion / in-place replacement. You pick the granularity per rule.

## Install

```sh
git clone https://github.com/aqiu817/magpie-strip-harness.git
magpie plugin add ./magpie-strip-harness
```

(or add the cloned folder path in the app: Plugins → Add plugin). The package has no `main`/`exports`, so magpie treats it as pure middleware.

## How it strips

Two granularities, chosen by the shape of each `patterns` entry:

1. **Plain string** (`"/regex/i"` or a case-insensitive substring) — **paragraph-level**. Split on blank lines and drop matching paragraphs; if there is no blank-line structure, or that would wipe the whole text, drop matching *lines* instead. Plain strings keep the original conservative behavior, so existing configs keep working.
2. **Object** `{ "match": "...", "replace": "..." }` — **line-level**, applied in config order to each line:
   - without `replace`, drop the matching **line** — never a heading plus all its subsections;
   - with `replace`, substitute the matched span *in place*, keeping the rest of the line. This neutralizes a token embedded in an executable instruction without losing the instruction.

The minimum deletion unit for object rules is a **line**: if only some lines of a section match, the heading and the other lines survive. Paragraph rules run first, then line rules.

A message/field that ends up empty is removed entirely (`body.system` deleted, empty chat `system` message dropped). Anthropic `cache_control` and other block fields are preserved on surviving blocks.

Works across protocols — the body is read in the agent's own API format:

| Protocol | Fields handled |
| --- | --- |
| `chat` | `messages[]` with `role: system` / `developer` (string or content parts) |
| `anthropic` | `system` (string or blocks array) |
| `responses` | `instructions` + `input[]` system/developer items |
| `gemini` | `systemInstruction` / `system_instruction` (string or `{parts}`) |
| unknown | tries all of the above shapes defensively |

## Options

Edit in the app (Plugins → installed → options) or:

```sh
magpie plugin options magpie-strip-harness '{"debug": true}'
```

| Option | Default | Meaning |
| --- | --- | --- |
| `patterns` | see [Example configs](#example-configs) | Two kinds of entry. A **plain string** (`"/regex/i"`, or any other string treated as a case-insensitive substring) is a paragraph-level delete rule. An **object** `{ "match": "...", "replace": "..." }` is a line-level rule: `replace` substitutes the matched span in place (keeping the rest of the line), omit it to delete matching lines. Rules apply in order to each line. Providing `patterns` **replaces** the defaults; if every entry is invalid (e.g. a regex typo), the defaults are used instead so stripping never silently turns off. |
| `stripAll` | `false` | When any pattern matches a system text, remove the whole system content instead of surgical stripping. |
| `debug` | `false` | Log one line to the magpie log (`plugin: [strip-harness] …`) per modified request. |

## Example configs

The shipped default (`package.json` → `magpie.options.patterns`) is only one example and can be replaced wholesale. Nothing in the processing code is tied to a specific harness.

### Minimal: one paragraph-level rule (DeepSeek Harness)

```json
{ "patterns": ["/deepseek[\\s_-]*harness/i"] }
```

Whole paragraphs mentioning the harness are dropped. Works when identity framing lives in its own paragraph.

### Full: line-level deletion + in-place replacement (ZCode)

```json
{
  "patterns": [
    "/deepseek[\\s_-]*harness/i",
    { "match": "/You are ZCode, an interactive agent/i" },
    { "match": "/^# ZCode Desktop Context\\s*$/i", "replace": "# Desktop Context" },
    { "match": "/window\\.zcode/i", "replace": "window" },
    { "match": ".zcode" },
    { "match": "/[._-]*z[._-]*code/i", "replace": "" }
  ]
}
```

- Delete the identity opener line, keep the generic agent description on the next line.
- Rename the heading; keep every subsection.
- Delete `.zcode` path lines wholesale (no broken paths left behind).
- Replace `window.zcode` in place so "Load the skill before generating an interactive view." survives.
- The last rule is a catch-all that neutralizes any remaining token.

**Order matters**: rules act on the line as left by the previous ones. The `window.zcode` rewrite must come before the `.zcode` deletion rule, otherwise that instruction line gets dropped. A bare `"/[._-]*z[._-]*code/i"` is a *paragraph* rule and will delete whole sections — use the object form for line precision.

### Template: your own harness

```json
{
  "patterns": [
    { "match": "/You are MyAgent, a CLI helper/i" },
    { "match": "/^# MyAgent Context$/i", "replace": "# Context" },
    { "match": "/window\\.myagent/i", "replace": "window" },
    { "match": ".myagent" }
  ]
}
```

Replace `MyAgent` / `myagent` with your harness's names. The same four moves apply to any harness: delete the opener line, soften the heading, delete product-specific path lines, neutralize embedded API names.

## Verify

```sh
magpie plugin options magpie-strip-harness '{"debug": true}'
# then send a request through the gateway with a harness opener in the system role, e.g.
curl http://127.0.0.1:3425/v1/chat/completions \
  -H "Authorization: Bearer <gateway-key>" -H "content-type: application/json" \
  -d '{"model":"<provider>/<model>","messages":[{"role":"system","content":"You are an AI agent powered by DeepSeek Harness.\n\nBe concise."},{"role":"user","content":"hi"}]}'
```

The magpie log shows `[strip-harness] chat <model>: removed harness prompt from system role`, and the upstream request goes out without the opener. Settings → Plugins also shows the middleware's call count and failures.

## Limits

- Object rules remove at **line** granularity and can rewrite a matched span in place. Plain-string rules still operate on blank-line paragraphs. A system prompt squeezed into one line cannot be partially stripped at line granularity — use `stripAll` or a `replace` rule.
- Editing the system prompt naturally invalidates provider-side prompt caching for that request.
- magpie's own internal requests (session titles, router classification) never pass through middleware.
