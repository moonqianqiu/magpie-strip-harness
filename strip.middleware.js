// magpie-strip-harness — magpie 网关中间件
// 由 patterns 驱动的通用 system 身份提示剥离：在请求路由前，把 agent 请求体
// system role 里由任意 harness 注入的身份提示剥离，其余内容原样保留。
// 只改请求，不碰回复与事件。具体 harness 的规则全部由配置提供，代码不内置。
//
// 运行环境是 moejs（网关内置 JS 引擎）：只有标准 JS，可用的语法刻意保持保守
// （无可选链 / 空值合并 / 展开运算符 / 后行断言）。
//
// patterns 两种条目：
//   1) 普通字符串（"/regex/flags" 或大小写不敏感子串）——段落级删除。
//      按空行分段丢整段；没有空行结构、或段落级会清空全文时退化为丢命中行。
//   2) 对象 { match, replace? } ——行级。
//      replace 把命中片段就地中和并保留整行其余内容；省略则删除命中行。
// 行级规则按配置顺序依次作用于当前行（前面规则改写过的版本）。

// 出厂默认配置，与 package.json 的 magpie.options.patterns 保持一致。
// 这只是可整体替换的示例默认值，不是逻辑的一部分。
const DEFAULT_PATTERNS = [
  "/deepseek[\\s_-]*harness/i",
  { match: "/You are ZCode, an interactive agent/i" },
  { match: "/^# ZCode Desktop Context\\s*$/i", replace: "# Desktop Context" },
  { match: "/window\\.zcode/i", replace: "window" },
  { match: ".zcode" },
  { match: "/[._-]*z[._-]*code/i", replace: "" }
]

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// 编译成统一 rule：{ line, deletion, test, replace }。
// "/regex/flags" 用正则，其余字符串按大小写不敏感字面量匹配。
function compilePattern(p) {
  let spec, line, replacement
  if (typeof p === "string") {
    spec = p.trim()
    line = false
    replacement = null
  } else if (p && typeof p === "object" && !Array.isArray(p) && typeof p.match === "string") {
    spec = p.match.trim()
    line = true
    replacement = typeof p.replace === "string" ? p.replace : null
  } else {
    return null
  }
  if (!spec) return null

  const m = /^\/(.+)\/([a-z]*)$/.exec(spec)
  const src = m ? m[1] : escapeRegExp(spec)
  const flags = m ? m[2] || "i" : "i"

  let testRe
  try {
    // test 用的正则去掉 g，避免 lastIndex 状态污染。
    testRe = new RegExp(src, flags.replace(/g/g, "") || "i")
  } catch (e) {
    return null // 非法正则：跳过该条，等效于不存在
  }
  let globalRe = null
  if (replacement !== null) {
    try {
      globalRe = new RegExp(src, flags.indexOf("g") === -1 ? flags + "g" : flags)
    } catch (e) {
      globalRe = null
    }
  }
  const gr = globalRe
  return {
    line: line,
    deletion: replacement === null,
    test: function (t) { return testRe.test(t) },
    replace: function (t) { return gr ? t.replace(gr, replacement) : t }
  }
}

function getMatchers(options) {
  const src =
    options && Array.isArray(options.patterns) && options.patterns.length > 0
      ? options.patterns
      : DEFAULT_PATTERNS
  const out = []
  for (let i = 0; i < src.length; i++) {
    const m = compilePattern(src[i])
    if (m) out.push(m)
  }
  if (out.length === 0 && src !== DEFAULT_PATTERNS) {
    // patterns 全部无效（如正则笔误）时退回默认，避免清洗整个静默失效
    for (let j = 0; j < DEFAULT_PATTERNS.length; j++) {
      const m = compilePattern(DEFAULT_PATTERNS[j])
      if (m) out.push(m)
    }
  }
  return out
}

function hit(text, rules) {
  for (let i = 0; i < rules.length; i++) {
    try {
      if (rules[i].test(text)) return true
    } catch (e) {
      /* 单条模式对当前输入抛错时视为不命中 */
    }
  }
  return false
}

// 段落级：按空行分段，丢弃命中的整段；没有空行结构、或段落级会清空全文时，
// 改为丢弃命中的行，避免误杀无匹配的行。
function stripParagraphs(str, paraRules) {
  const paras = str.split(/\n[ \t]*\n/)
  if (paras.length > 1) {
    const kept = []
    let removed = 0
    for (let i = 0; i < paras.length; i++) {
      if (hit(paras[i], paraRules)) removed++
      else kept.push(paras[i])
    }
    if (removed > 0 && kept.length > 0) return { text: kept.join("\n\n"), changed: true }
  }
  const lines = str.split(/\n/)
  const keptLines = []
  let removedLines = 0
  for (let j = 0; j < lines.length; j++) {
    if (lines[j].length > 0 && hit(lines[j], paraRules)) removedLines++
    else keptLines.push(lines[j])
  }
  return { text: keptLines.join("\n"), changed: removedLines > 0 }
}

// 行级：最小删除单位是行。规则按配置顺序作用在当前行。
function applyLineRules(text, lineRules) {
  const lines = String(text).split("\n")
  const out = []
  let changed = false
  for (let i = 0; i < lines.length; i++) {
    let cur = lines[i]
    let drop = false
    for (let r = 0; r < lineRules.length; r++) {
      const rule = lineRules[r]
      let matched = false
      try {
        matched = rule.test(cur)
      } catch (e) {
        matched = false
      }
      if (!matched) continue
      if (rule.deletion) {
        drop = true
        break
      }
      let next = cur
      try {
        next = rule.replace(cur)
      } catch (e) {
        next = cur
      }
      if (next !== cur) {
        cur = next
        changed = true
      }
    }
    if (drop) {
      changed = true
      continue
    }
    out.push(cur)
  }
  if (!changed) return { text: String(text), changed: false }
  return { text: out.join("\n"), changed: true }
}

function stripText(text, rules) {
  const str = String(text)
  if (!str || !hit(str, rules)) return { text: str, changed: false }

  const paraRules = []
  const lineRules = []
  for (let i = 0; i < rules.length; i++) {
    if (rules[i].line) lineRules.push(rules[i])
    else paraRules.push(rules[i])
  }

  const afterPara = stripParagraphs(str, paraRules)
  if (lineRules.length === 0) return afterPara
  const lineResult = applyLineRules(afterPara.text, lineRules)
  return { text: lineResult.text, changed: afterPara.changed || lineResult.changed }
}

// stripAll: 命中即移除整个 system 内容（该消息/字段整体删除）
function processText(text, rules, stripAll) {
  const str = String(text)
  if (stripAll) {
    if (!str || !hit(str, rules)) return { text: str, changed: false }
    return { text: "", changed: true }
  }
  return stripText(text, rules)
}

// 对一段 content（字符串或 parts 数组）做剔除。
// 返回 null 表示结构不适用；changed=false 表示原样保留。
function stripContent(content, rules, stripAll) {
  if (typeof content === "string") {
    const r = processText(content, rules, stripAll)
    if (!r.changed) return { changed: false }
    if (!String(r.text).trim()) return { changed: true, removedAll: true }
    return { changed: true, content: r.text }
  }
  if (Array.isArray(content)) {
    let changed = false
    const out = []
    for (let i = 0; i < content.length; i++) {
      const part = content[i]
      if (part && typeof part.text === "string") {
        const r = processText(part.text, rules, stripAll)
        if (r.changed) {
          changed = true
          if (String(r.text).trim()) out.push(Object.assign({}, part, { text: r.text }))
          // 变空的 part 直接丢弃
        } else {
          out.push(part)
        }
      } else {
        out.push(part)
      }
    }
    if (!changed) return { changed: false }
    if (out.length === 0) return { changed: true, removedAll: true }
    return { changed: true, content: out }
  }
  return null
}

// chat completions：messages 里 role 为 system / developer 的条目
function stripChatSystem(body, rules, stripAll) {
  if (!Array.isArray(body.messages)) return false
  let changed = false
  const out = []
  for (let i = 0; i < body.messages.length; i++) {
    const msg = body.messages[i]
    if (!msg || (msg.role !== "system" && msg.role !== "developer")) {
      out.push(msg)
      continue
    }
    const res = stripContent(msg.content, rules, stripAll)
    if (res && res.changed) {
      changed = true
      if (!res.removedAll) out.push(Object.assign({}, msg, { content: res.content }))
      // 清空后整条消息移除
      continue
    }
    out.push(msg)
  }
  if (changed) body.messages = out
  return changed
}

// anthropic messages：body.system（字符串或 blocks 数组，保留 cache_control 等字段）
function stripAnthropicSystem(body, rules, stripAll) {
  const sys = body.system
  if (typeof sys !== "string" && !Array.isArray(sys)) return false
  const res = stripContent(sys, rules, stripAll)
  if (!res || !res.changed) return false
  if (res.removedAll) delete body.system
  else body.system = res.content
  return true
}

// responses：body.instructions + input 里 role 为 system / developer 的条目
function stripResponsesSystem(body, rules, stripAll) {
  let changed = false
  if (typeof body.instructions === "string") {
    const r = processText(body.instructions, rules, stripAll)
    if (r.changed) {
      changed = true
      if (!String(r.text).trim()) delete body.instructions
      else body.instructions = r.text
    }
  }
  if (Array.isArray(body.input)) {
    const out = []
    let touched = false
    for (let i = 0; i < body.input.length; i++) {
      const item = body.input[i]
      const role = item && item.role
      if (role === "system" || role === "developer") {
        const res = stripContent(item.content, rules, stripAll)
        if (res && res.changed) {
          touched = true
          changed = true
          if (!res.removedAll) out.push(Object.assign({}, item, { content: res.content }))
          continue
        }
      }
      out.push(item)
    }
    if (touched) body.input = out
  }
  return changed
}

// gemini：systemInstruction / system_instruction（字符串或 {parts:[...]}）
function stripGeminiSystem(body, rules, stripAll) {
  let key = null
  let si = null
  if (body.systemInstruction !== undefined) {
    key = "systemInstruction"
    si = body.systemInstruction
  } else if (body.system_instruction !== undefined) {
    key = "system_instruction"
    si = body.system_instruction
  }
  if (!key) return false
  let changed = false
  let next = si
  if (typeof si === "string") {
    const r = processText(si, rules, stripAll)
    if (r.changed) {
      changed = true
      next = String(r.text).trim() ? r.text : ""
    }
  } else if (si && typeof si === "object" && Array.isArray(si.parts)) {
    const out = []
    let touched = false
    for (let i = 0; i < si.parts.length; i++) {
      const p = si.parts[i]
      const t = p && typeof p === "object" ? p.text : p
      if (typeof t === "string") {
        const r = processText(t, rules, stripAll)
        if (r.changed) {
          touched = true
          changed = true
          if (String(r.text).trim()) {
            out.push(typeof p === "object" ? Object.assign({}, p, { text: r.text }) : r.text)
          }
          continue
        }
      }
      out.push(p)
    }
    if (touched) next = Object.assign({}, si, { parts: out })
  }
  if (!changed) return false
  if (typeof next === "string" && !next.trim()) delete body[key]
  else body[key] = next
  return true
}

export function onRequest(body, ctx) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body
  const options = ctx && typeof ctx === "object" ? ctx.options : null
  const rules = getMatchers(options)
  if (rules.length === 0) return body
  const stripAll = !!(options && options.stripAll === true)
  const protocol = ctx && ctx.protocol

  let changed = false
  if (protocol === "chat") changed = stripChatSystem(body, rules, stripAll)
  else if (protocol === "anthropic") changed = stripAnthropicSystem(body, rules, stripAll)
  else if (protocol === "responses") changed = stripResponsesSystem(body, rules, stripAll)
  else if (protocol === "gemini") changed = stripGeminiSystem(body, rules, stripAll)
  else {
    // 协议未知时按已知形状逐个尝试（各函数只读自己的字段，互不干扰）
    changed = stripChatSystem(body, rules, stripAll)
    if (!changed) changed = stripAnthropicSystem(body, rules, stripAll)
    if (!changed) changed = stripResponsesSystem(body, rules, stripAll)
    if (!changed) changed = stripGeminiSystem(body, rules, stripAll)
  }

  if (changed && options && options.debug === true) {
    const tag = protocol || "unknown"
    const model = ctx && ctx.model ? ctx.model : "?"
    console.log("[strip-harness] " + tag + " " + model + ": removed harness prompt from system role")
  }
  return body
}
