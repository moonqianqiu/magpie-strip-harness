import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { onRequest } from "./strip.middleware.js"

const pkg = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"))
const defaults = pkg.magpie.options
const identity = "You are ZCode, an interactive agent."
let passed = 0

function test(name, fn) {
  try {
    fn()
    passed++
    console.log("ok - " + name)
  } catch (error) {
    console.error("not ok - " + name)
    throw error
  }
}

function context(protocol, options = defaults) {
  return { protocol, model: "test/model", options }
}

function lineRule(id, value, action = { type: "delete" }, roles = ["system"]) {
  return { id, roles, unit: "line", match: { type: "regex", value, flags: "i" }, action }
}

function config(rules) {
  return { rules: { version: 1, rules }, debug: false }
}

test("high-confidence defaults strip identity lines but retain neighboring instructions", () => {
  const body = { messages: [{ role: "system", content: identity + "\nYou are a helpful coding assistant.\n# ZCode Desktop Context\nKeep this instruction." }] }
  onRequest(body, context("chat"))
  assert.equal(body.messages[0].content, "You are a helpful coding assistant.\n# Desktop Context\nKeep this instruction.")
})

test("sample-derived DSH and ZCode defaults remove identity framing only", () => {
  const dshOpener = "You are an AI agent powered by DeepSeek Harness."
  const dshFollowing = "You are a coding agent powered by the selected model."
  const dshBody = { messages: [{ role: "system", content: dshOpener + "\n\n" + dshFollowing }] }
  onRequest(dshBody, context("chat"))
  assert.ok(!dshBody.messages[0].content.includes(dshOpener))
  assert.ok(dshBody.messages[0].content.includes(dshFollowing))

  const zcodeBody = { messages: [{ role: "system", content: [
    "You are ZCode, an interactive agent",
    "You are an agent working with the user toward their goals.",
    "# Harness",
    "Tools run behind a user-selected permission mode.",
    "# ZCode Desktop Context",
    "Use the restricted window.zcode bridge.",
    "Working directory: C:\\Users\\WindLight\\.zcode\\workspace"
  ].join("\n") }] }
  onRequest(zcodeBody, context("chat"))
  const cleaned = zcodeBody.messages[0].content
  assert.ok(!cleaned.includes("You are ZCode, an interactive agent"))
  assert.ok(cleaned.includes("You are an agent working with the user toward their goals."))
  assert.ok(cleaned.includes("# Harness"))
  assert.ok(cleaned.includes("# Desktop Context"))
  assert.ok(cleaned.includes("window.zcode"))
  assert.ok(cleaned.includes(".zcode\\workspace"))
})

test("product name mentions and API instructions are not default deletion signals", () => {
  const original = "Prefer DeepSeek Harness-compatible tool names.\nUse window.zcode to access the runtime API.\nA .zcode path may be configured."
  const body = { messages: [{ role: "system", content: original }] }
  onRequest(body, context("chat"))
  assert.equal(body.messages[0].content, original)
})

test("anchored line regexes match individual CRLF lines", () => {
  const body = { messages: [{ role: "system", content: "Keep this.\r\n" + identity + "\r\nKeep that." }] }
  onRequest(body, context("chat"))
  assert.equal(body.messages[0].content, "Keep this.\r\nKeep that.")
})

test("line deletion preserves original separators around untouched text", () => {
  const rules = [lineRule("drop", "^REMOVE$")]
  const body = { messages: [{ role: "system", content: "first\r\nREMOVE\r\nlast" }] }
  onRequest(body, context("chat", config(rules)))
  assert.equal(body.messages[0].content, "first\r\nlast")
})

test("rules execute in configured order on updated text", () => {
  const rules = [
    lineRule("rename", "^Old$", { type: "replace", value: "New" }),
    lineRule("remove-renamed", "^New$")
  ]
  const body = { messages: [{ role: "system", content: "Old\nKeep" }] }
  onRequest(body, context("chat", config(rules)))
  assert.equal(body.messages[0].content, "Keep")
})

test("explicit empty configuration disables processing", () => {
  const body = { messages: [{ role: "system", content: identity }] }
  onRequest(body, context("chat", config([])))
  assert.equal(body.messages[0].content, identity)
})

test("invalid configuration does not fall back to defaults", () => {
  const body = { messages: [{ role: "system", content: identity }] }
  onRequest(body, context("chat", { rules: { version: 1, rules: [lineRule("bad", "[")] }, debug: false }))
  assert.equal(body.messages[0].content, identity)
})

test("invalid configuration reports an error in debug logs", () => {
  const original = console.log
  const logs = []
  console.log = function (message) { logs.push(String(message)) }
  try {
    onRequest({ messages: [] }, context("chat", { rules: { version: 1, rules: [lineRule("bad", "[")] }, debug: true }))
  } finally { console.log = original }
  assert.match(logs[0], /invalid configuration: bad: invalid regex/)
})

test("roles are explicit and developer is not touched by system-only rules", () => {
  const body = { messages: [{ role: "developer", content: identity }, { role: "system", content: identity }] }
  onRequest(body, context("chat"))
  assert.equal(body.messages.length, 1)
  assert.equal(body.messages[0].role, "developer")
})

test("a configured developer rule can target developer messages", () => {
  const body = { messages: [{ role: "developer", content: identity }] }
  onRequest(body, context("chat", config([lineRule("dev", "^You are ZCode, an interactive agent\\.?$", undefined, ["developer"])])))
  assert.deepEqual(body.messages, [])
})

test("Anthropic block updates preserve metadata and non-text content", () => {
  const cacheControl = { type: "ephemeral" }
  const image = { type: "image", source: { type: "base64", data: "abc" } }
  const body = { system: [
    { type: "text", text: identity, cache_control: cacheControl },
    image,
    { type: "text", text: "Keep this instruction.", cache_control: cacheControl }
  ] }
  const rules = [lineRule("identity", "^You are ZCode, an interactive agent\\.?$")]
  onRequest(body, context("anthropic", config(rules)))
  assert.equal(body.system.length, 2)
  assert.equal(body.system[0], image)
  assert.equal(body.system[1].text, "Keep this instruction.")
  assert.equal(body.system[1].cache_control, cacheControl)
})

test("Responses handles instructions and system/developer input targets", () => {
  const body = { instructions: identity, input: [
    { role: "developer", content: identity },
    { role: "user", content: identity }
  ] }
  const rules = [lineRule("both-roles", "^You are ZCode, an interactive agent\\.?$", undefined, ["system", "developer"])]
  onRequest(body, context("responses", config(rules)))
  assert.equal(Object.hasOwn(body, "instructions"), false)
  assert.deepEqual(body.input, [{ role: "user", content: identity }])
})

test("Gemini removes an emptied system target and keeps unrelated request fields", () => {
  const body = { systemInstruction: { parts: [{ text: identity }, { text: "Also injected." }], other: true }, contents: [{ role: "user" }] }
  const rules = [lineRule("identity", "^(You are ZCode, an interactive agent\\.?|Also injected\\.)$")]
  onRequest(body, context("gemini", config(rules)))
  assert.equal(Object.hasOwn(body, "systemInstruction"), false)
  assert.deepEqual(body.contents, [{ role: "user" }])
})

test("Gemini preserves part metadata and non-text parts", () => {
  const image = { inlineData: { mimeType: "image/png", data: "x" } }
  const textPart = { text: identity, metadata: "keep" }
  const body = { systemInstruction: { parts: [textPart, image], other: 1 } }
  const rules = [lineRule("identity", "^You are ZCode, an interactive agent\\.?$")]
  onRequest(body, context("gemini", config(rules)))
  assert.equal(body.systemInstruction.parts.length, 1)
  assert.equal(body.systemInstruction.parts[0], image)
  assert.equal(body.systemInstruction.other, 1)
})

test("unknown protocol and ambiguous request shapes are not guessed", () => {
  const body = { messages: [{ role: "system", content: identity }], system: identity }
  onRequest(body, context("custom-protocol"))
  assert.equal(body.messages[0].content, identity)
  assert.equal(body.system, identity)
})

test("target action is explicit and applies across text segments", () => {
  const rule = {
    id: "drop-known-target", roles: ["system"], unit: "target",
    match: { type: "regex", value: "IDENTITY\\s+HEADER", flags: "i" }, action: { type: "drop-target" }
  }
  const body = { system: [{ type: "text", text: "IDENTITY " }, { type: "text", text: "HEADER" }] }
  onRequest(body, context("anthropic", config([rule])))
  assert.equal(Object.hasOwn(body, "system"), false)
})

test("ordinary segment rules do not match across block boundaries", () => {
  const rule = lineRule("cross-block", "^IDENTITY HEADER$")
  const body = { system: [{ type: "text", text: "IDENTITY " }, { type: "text", text: "HEADER" }] }
  onRequest(body, context("anthropic", config([rule])))
  assert.equal(body.system.length, 2)
})

test("span rules change only matched text and support delete and replace", () => {
  const rules = [
    { id: "neutralize", roles: ["system"], unit: "span", match: { type: "contains", value: "window.zcode" }, action: { type: "replace", value: "window" } },
    { id: "remove-path-token", roles: ["system"], unit: "span", match: { type: "contains", value: ".zcode" }, action: { type: "delete" } }
  ]
  const body = { system: "Use window.zcode for the API; cache path: C:\\work\\.zcode\\tmp" }
  onRequest(body, context("anthropic", config(rules)))
  assert.equal(body.system, "Use window for the API; cache path: C:\\work\\\\tmp")
})

test("all four protocol adapters preserve unrelated fields and targets", () => {
  const rule = lineRule("identity", "^You are ZCode, an interactive agent\\.?$")
  const options = config([rule])
  const chat = { model: "m", messages: [{ role: "system", content: identity }, { role: "user", content: "hi" }], temperature: 0.2 }
  const anthropic = { model: "m", system: identity, messages: [{ role: "user", content: "hi" }] }
  const responses = { model: "m", instructions: identity, input: [{ role: "user", content: "hi" }] }
  const gemini = { model: "m", system_instruction: identity, contents: [{ role: "user", parts: [{ text: "hi" }] }] }
  onRequest(chat, context("chat", options))
  onRequest(anthropic, context("anthropic", options))
  onRequest(responses, context("responses", options))
  onRequest(gemini, context("gemini", options))
  assert.equal(chat.messages.length, 1)
  assert.equal(anthropic.system, undefined)
  assert.equal(responses.instructions, undefined)
  assert.equal(gemini.system_instruction, undefined)
  assert.equal(chat.temperature, 0.2)
  assert.equal(anthropic.messages[0].content, "hi")
  assert.equal(responses.input[0].content, "hi")
  assert.equal(gemini.contents[0].parts[0].text, "hi")
})

test("cleaning is idempotent", () => {
  const body = { messages: [{ role: "system", content: identity + "\nKeep this." }] }
  const options = context("chat")
  onRequest(body, options)
  const once = body.messages[0].content
  onRequest(body, options)
  assert.equal(body.messages[0].content, once)
})

test("regex state flags are rejected and never create sticky behavior", () => {
  const body = { messages: [{ role: "system", content: identity }] }
  const rule = lineRule("stateful", "ZCode")
  rule.match.flags = "y"
  onRequest(body, context("chat", config([rule])))
  assert.equal(body.messages[0].content, identity)
})

test("non-object bodies pass through", () => {
  assert.equal(onRequest(null, context("chat")), null)
  assert.equal(onRequest("text", context("chat")), "text")
})

console.log("\n" + passed + "/" + passed + " passed")
