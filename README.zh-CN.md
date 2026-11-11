# magpie-strip-harness

[English](README.md) | 简体中文

一个 [magpie](https://usemagpie.ai) **网关中间件**：在请求路由到任何供应商之前，把 agent 请求体 `system` role 里由 harness 注入的**身份提示**剔除。它完全是**配置驱动**的——中间件本身不认识任何具体 harness，你用 `patterns` 描述要删什么，同一套机制对 DeepSeek Harness、ZCode 或你自己写的 agent 都一样生效。只改请求，不碰回复与事件，对所有供应商生效。

## 为什么

各类 agent harness 通常会在 system 提示里注入身份框架：开场白（"You are X, an interactive agent"）、产品标题、工作目录路径、内嵌 API 名等。经反代转发时，这些框架对上游模型是可见的。这个中间件在网关层把它们剔除，不必逐个改客户端配置。

难点在于身份 token 常常和**可执行规则**混在同一行。整段删除会连带删掉那些规则，所以 `patterns` 同时支持段落级删除、行级删除和就地替换，粒度由你按规则指定。

## 安装

```sh
git clone https://github.com/aqiu817/magpie-strip-harness.git
magpie plugin add ./magpie-strip-harness
```

也可以在应用里：插件 → 添加插件，填入克隆下来的文件夹路径。包里没有 `main`/`exports`，magpie 会把它当纯中间件加载。

## 剔除逻辑

`patterns` 有两种条目，粒度不同：

1. **普通字符串**（`"/regex/i"` 或大小写不敏感子串）——**段落级**：按空行分段，命中整段丢弃；没有空行结构、或段落级会清空全文时改为丢弃命中的**行**。普通字符串保持原来的保守行为，已有配置继续有效。
2. **对象规则**（`{ match, replace? }`）——**行级**，按配置顺序作用于每一行：
   - 不带 `replace`：只删命中的**行**，绝不删「标题 + 全部子节」；
   - 带 `replace`：把命中片段**就地替换**，保留整行其余内容（例如把 `restricted window.zcode bridge` 中和成 `restricted window bridge`，同时保住 "Load the skill before..." 指令）。

对象规则的删除最小单位是**行**；某节只有部分行命中时，只删命中行，节标题与其余行保留。段落规则先跑，行规则后跑。

清空后的消息/字段整个移除（删掉 `body.system`、丢掉空的 chat system 消息）。Anthropic 块上的 `cache_control` 等字段在幸存块上原样保留。

按 agent 自己的 API 格式读取请求体，四种协议都支持：`chat`（messages 里 system/developer）、`anthropic`（`system` 字符串或 blocks）、`responses`（`instructions` + input 里的 system 条目）、`gemini`（`systemInstruction`）；协议未知时逐个形状防御性尝试。

## 选项

在应用里（插件 → 已安装 → 选项）编辑，或：

```sh
magpie plugin options magpie-strip-harness '{"debug": true}'
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `patterns` | 见[示例配置](#示例配置) | 两种条目：普通字符串（`"/regex/i"` 编译为正则，其余按大小写不敏感子串匹配）= 段落级删除；对象 `{ "match": "...", "replace": "..." }` = 行级，`replace` 把命中片段就地替换并保留整行其余内容，省略则删除命中行。规则按配置顺序作用于每一行。设置后**替换**默认值；全部无效时回退默认，清洗不会静默失效。 |
| `stripAll` | `false` | 命中即移除整个 system 内容，而不是精准剔除。 |
| `debug` | `false` | 每次改写请求时向 magpie 日志输出一行。 |

## 示例配置

随 `package.json` 出厂的默认配置只是**一个例子**，可以整体替换。处理逻辑里没有任何与具体 harness 绑定的代码。

### 最简：一条段落级规则（DeepSeek Harness）

```json
{ "patterns": ["/deepseek[\\s_-]*harness/i"] }
```

命中 harness 的整段删除。适用于身份框架独占一段的情况。

### 完整：行级删除 + 就地替换（ZCode）

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

- 删掉身份开场白那一行，保留紧随其后的通用行为描述。
- 标题改名，下属子节全部保留。
- `.zcode` 路径行整行删（不留破损路径）。
- `window.zcode` 就地替换，保住 "Load the skill before generating an interactive view."。
- 最后一条是兜底，中和任何残留 token。

**顺序有意义**：规则作用于「上一条规则改写后的当前行」，所以 `window.zcode` 的替换必须排在 `.zcode` 删行之前，否则那条含 "Load the skill" 的指令行会被整行删掉。单独的 `"/[._-]*z[._-]*code/i"` 是**段落级**规则，会整段删掉子节——要行级精度就用对象形式。

### 模板：你自己的 harness

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

把 `MyAgent` / `myagent` 换成你 harness 的名字。同样四个动作适用于任意 harness：删开场白行、弱化标题、删产品专属路径行、中和内嵌 API 名。

## 验证

开着 debug，通过网关发一条带身份开场白的请求，上游收到的请求里就没有那句话了。magpie 的用量记录里能看到特征：中间件首次生效时，该会话的下一条请求前缀缓存会失效（`cache_read=0`）并随即在新前缀上重建。

## 局限

- 对象规则按**行**删除、并支持就地替换；普通字符串规则仍是空行段落级。如果 system 全挤在一行没有换行，行级无法部分剔除——用 `stripAll` 或 `replace` 规则。
- 修改 system 会让该请求的供应商侧提示词缓存失效，属预期代价。
- magpie 自己的内部请求（会话标题、路由分类）不经过中间件。

## 测试

```sh
node test.mjs
```

## 许可

MIT
