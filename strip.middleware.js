// magpie gateway middleware: conservatively clean configured harness identity
// from supported system/developer targets while preserving protocol structure.

const MAX_RULES = 100
const MAX_REGEX_LENGTH = 512
const MAX_MATCH_LENGTH = 4096
const MAX_TARGET_LENGTH = 1048576
let cachedRuleSignature = null
let cachedRuleCompilation = null

function log(options, message) {
  if (options && options.debug === true && typeof console !== "undefined" && console.log) {
    console.log("[strip-harness] " + message)
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function compileRules(options) {
  if (!options || !Object.prototype.hasOwnProperty.call(options, "rules")) {
    return { rules: [], error: null }
  }
  if (options.patterns !== undefined || options.stripAll !== undefined) {
    return { rules: [], error: "legacy patterns/stripAll options are not supported; use versioned rules" }
  }
  const config = options.rules
  if (!config || typeof config !== "object" || Array.isArray(config) || config.version !== 1 || !Array.isArray(config.rules)) {
    return { rules: [], error: "rules must be { version: 1, rules: [...] }" }
  }
  let signature
  try { signature = JSON.stringify(config) } catch (e) { return { rules: [], error: "rules configuration must be serializable" } }
  if (signature === cachedRuleSignature) return cachedRuleCompilation
  if (config.rules.length > MAX_RULES) return { rules: [], error: "rule limit exceeded" }

  const compiled = []
  const ids = Object.create(null)
  for (let i = 0; i < config.rules.length; i++) {
    const rule = config.rules[i]
    if (!rule || typeof rule !== "object" || Array.isArray(rule) || typeof rule.id !== "string" || !rule.id.trim()) {
      return { rules: [], error: "rule " + i + " requires a non-empty id" }
    }
    if (ids[rule.id]) return { rules: [], error: "duplicate rule id: " + rule.id }
    ids[rule.id] = true
    if (!Array.isArray(rule.roles) || rule.roles.length === 0) return { rules: [], error: rule.id + ": roles must be a non-empty array" }
    for (let j = 0; j < rule.roles.length; j++) {
      if (rule.roles[j] !== "system" && rule.roles[j] !== "developer") return { rules: [], error: rule.id + ": unsupported role" }
    }
    if (["span", "line", "block", "target"].indexOf(rule.unit) === -1) return { rules: [], error: rule.id + ": unsupported unit" }
    if (!rule.match || typeof rule.match !== "object" || ["exact", "contains", "regex"].indexOf(rule.match.type) === -1 || typeof rule.match.value !== "string" || !rule.match.value) {
      return { rules: [], error: rule.id + ": invalid match" }
    }
    if (rule.match.value.length > MAX_MATCH_LENGTH) return { rules: [], error: rule.id + ": match length limit exceeded" }
    if (!rule.action || typeof rule.action !== "object" || ["delete", "replace", "drop-target"].indexOf(rule.action.type) === -1) {
      return { rules: [], error: rule.id + ": invalid action" }
    }
    if ((rule.unit === "target") !== (rule.action.type === "drop-target")) return { rules: [], error: rule.id + ": target units require drop-target; other units cannot drop-target" }
    if (rule.action.type === "replace" && typeof rule.action.value !== "string") return { rules: [], error: rule.id + ": replace action requires a string value" }
    if (rule.action.type !== "replace" && rule.action.value !== undefined) return { rules: [], error: rule.id + ": only replace action accepts a value" }

    let source = rule.match.value
    let flags = rule.match.flags || ""
    if (rule.match.type === "regex") {
      if (source.length > MAX_REGEX_LENGTH) return { rules: [], error: rule.id + ": regex length limit exceeded" }
      if (/[^imsu]/.test(flags) || /(.).*\1/.test(flags)) return { rules: [], error: rule.id + ": unsupported regex flags" }
    } else {
      if (rule.match.flags !== undefined) return { rules: [], error: rule.id + ": flags are only valid for regex matches" }
      source = escapeRegExp(source)
      flags = "g"
      if (rule.match.type === "exact") source = "^(?:" + source + ")$"
    }
    if (rule.match.type === "regex" && rule.unit === "span") flags += flags.indexOf("g") === -1 ? "g" : ""
    let expression
    try { expression = new RegExp(source, flags) } catch (e) { return { rules: [], error: rule.id + ": invalid regex: " + e.message } }
    compiled.push({
      id: rule.id,
      roles: rule.roles.slice(),
      unit: rule.unit,
      matchType: rule.match.type,
      expression: expression,
      action: rule.action.type,
      value: rule.action.value
    })
  }
  cachedRuleSignature = signature
  cachedRuleCompilation = { rules: compiled, error: null }
  return cachedRuleCompilation
}

function supportsRole(rule, role) {
  return rule.roles.indexOf(role) !== -1
}

function matches(rule, text) {
  rule.expression.lastIndex = 0
  return rule.expression.test(text)
}

function replaceMatches(rule, text, replacement) {
  rule.expression.lastIndex = 0
  return text.replace(rule.expression, replacement === undefined ? rule.value : replacement)
}

function transformLine(text, rule) {
  const parts = text.split(/(\r\n|\n|\r)/)
  const kept = []
  let changed = false
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i]
    const separator = parts[i + 1] || ""
    if (matches(rule, line)) {
      if (rule.action === "delete") {
        changed = true
        continue
      }
      if (rule.action === "replace" && line !== rule.value) {
        kept.push(rule.value + separator)
        changed = true
        continue
      }
    }
    kept.push(line + separator)
  }
  const rewritten = changed ? kept.join("") : text
  return { text: rewritten, changed: changed, deleted: changed && rewritten.trim().length === 0 }
}

function transformSegment(text, rule) {
  if (rule.unit === "line") return transformLine(text, rule)
  if (rule.unit === "block") {
    if (!matches(rule, text)) return { text: text, deleted: false, changed: false }
    if (rule.action === "delete") return { text: "", deleted: true, changed: true }
    if (rule.action === "replace") return { text: rule.value, deleted: false, changed: text !== rule.value }
  }
  if (rule.unit === "span") {
    if (!matches(rule, text)) return { text: text, deleted: false, changed: false }
    const rewritten = rule.action === "delete" ? replaceMatches(rule, text, "") : replaceMatches(rule, text)
    return { text: rewritten, deleted: false, changed: rewritten !== text }
  }
  return { text: text, deleted: false, changed: false }
}

function executeTarget(target, rules) {
  const segments = target.segments.map(function (segment) {
    return { text: segment.text, index: segment.index, kind: segment.kind, deleted: false }
  })
  let dropTarget = false
  const changes = []
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]
    if (!supportsRole(rule, target.role)) continue
    if (rule.unit === "target") {
      const whole = segments.filter(function (segment) { return !segment.deleted }).map(function (segment) { return segment.text }).join("\n")
      if (whole.length <= MAX_TARGET_LENGTH && matches(rule, whole)) {
        dropTarget = true
        changes.push({ ruleId: rule.id, action: "drop-target" })
        break
      }
      continue
    }
    for (let j = 0; j < segments.length; j++) {
      const segment = segments[j]
      if (segment.deleted) continue
      const result = transformSegment(segment.text, rule)
      if (!result.changed) continue
      segment.text = result.text
      segment.deleted = result.deleted === true
      changes.push({ ruleId: rule.id, action: rule.action, segment: segment.index })
    }
  }
  if (dropTarget) return { changed: true, drop: true, segments: segments, changes: changes }
  if (changes.length === 0) return { changed: false, segments: segments, changes: [] }
  const live = segments.filter(function (segment) { return !segment.deleted })
  const hasRemainingText = live.some(function (segment) { return segment.text.trim().length > 0 })
  const hasNonText = target.format !== "string" && target.source.some(function (item) {
    return !(item && typeof item === "object" && typeof item.text === "string") && !(target.format === "gemini-parts" && typeof item === "string")
  })
  return { changed: true, drop: !hasRemainingText && !hasNonText, segments: segments, changes: changes }
}

function makeContentTarget(role, content, id, stringParts) {
  if (typeof content === "string") {
    if (content.length > MAX_TARGET_LENGTH) return null
    return { id: id, role: role, format: "string", source: content, segments: [{ index: 0, kind: "string", text: content }] }
  }
  if (!Array.isArray(content)) return null
  const segments = []
  for (let i = 0; i < content.length; i++) {
    const item = content[i]
    if (item && typeof item === "object" && typeof item.text === "string") segments.push({ index: i, kind: "text-object", text: item.text })
    else if (stringParts && typeof item === "string") segments.push({ index: i, kind: "text-string", text: item })
  }
  if (!segments.length || segments.some(function (segment) { return segment.text.length > MAX_TARGET_LENGTH })) return null
  return { id: id, role: role, format: "array", source: content, segments: segments }
}

function readRoleTargets(items, idPrefix, stringParts) {
  const targets = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!item || (item.role !== "system" && item.role !== "developer")) continue
    const target = makeContentTarget(item.role, item.content, idPrefix + ":" + i, stringParts)
    if (target) {
      target.index = i
      target.sourceMessage = item
      targets.push(target)
    }
  }
  return targets
}

function createAdapters() {
  return {
    chat: {
      readTargets: function (body) { return Array.isArray(body.messages) ? readRoleTargets(body.messages, "messages", false) : null },
      applyChanges: function (body, targets, results) {
        const byIndex = Object.create(null)
        targets.forEach(function (target) { if (results[target.id] && results[target.id].changed) byIndex[target.index] = { target: target, result: results[target.id] } })
        const messages = []
        for (let i = 0; i < body.messages.length; i++) {
          const update = byIndex[i]
          if (!update) messages.push(body.messages[i])
          else if (!update.result.drop) messages.push(Object.assign({}, body.messages[i], { content: buildContent(update.target, update.result) }))
        }
        body.messages = messages
      }
    },
    anthropic: {
      readTargets: function (body) {
        if (body.system === undefined) return null
        const target = makeContentTarget("system", body.system, "system", false)
        return target ? [target] : null
      },
      applyChanges: function (body, targets, results) {
        const result = results.system
        if (!result || !result.changed) return
        if (result.drop) delete body.system
        else body.system = buildContent(targets[0], result)
      }
    },
    responses: {
      readTargets: function (body) {
        const targets = []
        if (typeof body.instructions === "string") {
          const instruction = makeContentTarget("system", body.instructions, "instructions", false)
          if (instruction) targets.push(instruction)
        }
        if (Array.isArray(body.input)) targets.push.apply(targets, readRoleTargets(body.input, "input", false))
        return targets.length ? targets : null
      },
      applyChanges: function (body, targets, results) {
        const byIndex = Object.create(null)
        targets.forEach(function (target) { if (target.id.indexOf("input:") === 0 && results[target.id] && results[target.id].changed) byIndex[target.index] = { target: target, result: results[target.id] } })
        if (Array.isArray(body.input)) {
          const input = []
          for (let i = 0; i < body.input.length; i++) {
            const update = byIndex[i]
            if (!update) input.push(body.input[i])
            else if (!update.result.drop) input.push(Object.assign({}, body.input[i], { content: buildContent(update.target, update.result) }))
          }
          body.input = input
        }
        const instruction = results.instructions
        if (instruction && instruction.changed) {
          if (instruction.drop) delete body.instructions
          else body.instructions = buildContent(targets.filter(function (target) { return target.id === "instructions" })[0], instruction)
        }
      }
    },
    gemini: {
      readTargets: function (body) {
        const key = body.systemInstruction !== undefined ? "systemInstruction" : body.system_instruction !== undefined ? "system_instruction" : null
        if (!key) return null
        const instruction = body[key]
        let target = null
        if (typeof instruction === "string") target = makeContentTarget("system", instruction, key, false)
        else if (instruction && typeof instruction === "object" && Array.isArray(instruction.parts)) {
          target = makeContentTarget("system", instruction.parts, key, true)
          if (target) { target.format = "gemini-parts"; target.sourceInstruction = instruction; target.key = key }
        }
        return target ? [target] : null
      },
      applyChanges: function (body, targets, results) {
        const target = targets[0]
        const result = results[target.id]
        if (!result || !result.changed) return
        if (result.drop) { delete body[target.id]; return }
        if (target.format === "gemini-parts") {
          const updated = Object.assign({}, target.sourceInstruction, { parts: buildContent(target, result) })
          if (updated.parts.length === 0) delete body[target.key]
          else body[target.key] = updated
        } else body[target.id] = buildContent(target, result)
      }
    }
  }
}

const ADAPTERS = createAdapters()

function buildContent(target, result) {
  if (target.format === "gemini-parts") {
    const arrayTarget = Object.assign({}, target, { format: "array", source: target.sourceInstruction.parts })
    return buildContent(arrayTarget, result)
  }
  if (target.format === "string") return result.segments[0] && !result.segments[0].deleted ? result.segments[0].text : ""
  const updates = Object.create(null)
  for (let i = 0; i < result.segments.length; i++) updates[result.segments[i].index] = result.segments[i]
  const output = []
  for (let i = 0; i < target.source.length; i++) {
    const updated = updates[i]
    const original = target.source[i]
    if (!updated) output.push(original)
    else if (!updated.deleted) {
      if (updated.kind === "text-object") output.push(updated.text === original.text ? original : Object.assign({}, original, { text: updated.text }))
      else output.push(updated.text)
    }
  }
  return output
}

export function onRequest(body, ctx) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body
  const options = ctx && typeof ctx === "object" ? ctx.options : null
  const compilation = compileRules(options)
  if (compilation.error) {
    log(options, "invalid configuration: " + compilation.error)
    return body
  }
  if (compilation.rules.length === 0) return body
  const protocol = ctx && ctx.protocol
  const adapter = ADAPTERS[protocol]
  if (!adapter) {
    log(options, "unsupported protocol: " + String(protocol || "unknown"))
    return body
  }
  const targets = adapter.readTargets(body)
  if (!targets) return body
  const results = Object.create(null)
  let modifications = 0
  const appliedRules = []
  for (let i = 0; i < targets.length; i++) {
    const result = executeTarget(targets[i], compilation.rules)
    results[targets[i].id] = result
    if (result.changed) {
      modifications += result.changes.length
      for (let j = 0; j < result.changes.length; j++) appliedRules.push(result.changes[j].ruleId + ":" + result.changes[j].action)
    }
  }
  if (modifications === 0) return body
  adapter.applyChanges(body, targets, results)
  log(options, protocol + " " + (ctx && ctx.model ? ctx.model : "?") + ": applied " + modifications + " rule change(s): " + appliedRules.join(", "))
  return body
}
