# 模型与提供商 · 思考档位 · 统计 · 提示词预设（后端对接设计）

本文件给下一阶段（VPS 上的 FastAPI + SQLite）用。样稿里的所有模型请求、Key、余额、usage 都是本地假数据；下面写的是**正式版应该怎么落地**，以及样稿里已经写好的、可以直接复用的函数。

---

## 0. 一句话原则

**浏览器不直接拿 API Key 发模型请求。** Key 存 VPS 后端，所有模型请求由后端转发；这同时解决浏览器直连中转站的 CORS 问题。样稿阶段为了演示，Key 暂存 `localStorage`，界面始终掩码，导出的提供商 JSON 默认不带 Key。

---

## 1. 数据模型

### 1.1 提供商 provider

```ts
{
  id: string,                 // 内部 id，前端生成 / 后端 uuid
  name: string,               // 显示名，如「白露中转」
  icon: string,               // 图标 key（见 §2.5），空 = 按名称自动匹配
  protocol: 'openai' | 'openai_responses' | 'anthropic' | 'gemini' | 'deepseek' | 'openrouter',
  baseUrl: string,            // 例如 https://api.deepseek.com
  apiPath: string,            // 例如 /chat/completions 或 /v1/messages
  apiKey: string,             // 样稿存 localStorage；正式版只存后端并加密
  enabled: boolean,           // 停用后不出现在聊天模型弹层
  models: string[],           // 这里存 model.id 列表
  balance: {
    supported: boolean,       // 是否走官方余额接口
    amount: number | null,
    currency: '¥' | '$',
    at: string,               // 上次成功查询时间
    failed?: boolean,
    failKind?: string         // 上次失败分类（classifyApiError.kind）
  },
  advanced: {
    responseApi: boolean,     // 是否使用 /responses
    returnThinking: boolean,  // 是否在回复里回传历史思考过程
    fetchBalance: boolean,
    demo400: boolean,         // 样稿演示开关，正式版删除
    timeout: number           // 秒
  },
  source: 'preset' | 'user' | 'copy' | 'imported',
  extras: object              // 不认识的字段口袋，导入时原样保留
}
```

### 1.2 模型 model

```ts
{
  id: string,
  providerId: string,
  name: string,               // 显示名，如「Claude Sonnet 4.5」
  modelId: string,            // 请求里真正发的 id，如 claude-sonnet-4-5
  icon: string,               // 可空，空则按 modelId 关键词匹配
  caps: { vision: boolean, tools: boolean, reasoning: boolean },
  context: number,            // 上下文 token 数
  favorite: boolean,
  price: null | { input: number, cache: number, output: number, currency: '¥' | '$' }, // 每百万 token
  reasoning: {
    mode: 'none' | 'openai_effort' | 'anthropic_budget' | 'gemini_budget'
        | 'deepseek' | 'openrouter' | 'relay_suffix',
    levels: string[],         // off / auto / low / medium / high / max / on
    defaultLevel: string,
    map?: { [level: string]: string },  // relay_suffix：档位 -> modelId
    note: string
  },
  source: 'preset' | 'user' | 'pulled' | 'imported'
}
```

### 1.3 聊天与预设的绑定

取用顺序（和用户设定一致）：**这场聊天指定 > 角色默认 > 全局默认**。

```ts
conversation.preset_id?: string
character.default_preset_id?: string
user_settings.default_preset_id: string
```

聊天记录在样稿里额外存 `presetId`、`modelId`、`reasoningLevel`；正式版这三项也应落到 conversation 上（模型与档位是「这一场」的状态）。

---

## 2. 协议适配

### 2.1 URL 拼接

```
url = baseUrl.replace(/\/+$/, '') + apiPath
```

| 协议 | Base URL 示例 | 聊天路径 | 拉取模型 |
| --- | --- | --- | --- |
| OpenAI 兼容 | `https://api.openai.com/v1` | `/chat/completions` | GET `{base}/models` |
| OpenAI Responses | `https://api.openai.com/v1` | `/responses` | GET `{base}/models` |
| Anthropic Messages | `https://api.anthropic.com` | `/v1/messages` | GET `{base}/v1/models` |
| Google Gemini | `https://generativelanguage.googleapis.com` | `/v1beta/models/{model}:generateContent` | GET `{base}/v1beta/models` |
| DeepSeek 官方 | `https://api.deepseek.com` | `/chat/completions` | GET `{base}/models` |
| OpenRouter | `https://openrouter.ai/api/v1` | `/chat/completions` | GET `{base}/models` |

Gemini 的 API Key 放 query：`?key=...`；其余放 Header。

### 2.2 请求头

```ts
// OpenAI / DeepSeek / OpenRouter / 中转站
{ 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' }

// Anthropic
{
  'x-api-key': apiKey,
  'anthropic-version': '2023-06-01',
  'anthropic-dangerous-direct-browser-access': 'true', // 仅浏览器直连时需要；正式版走后端可去掉
  'Content-Type': 'application/json'
}

// Gemini
// key 放 query，不需要 Authorization
```

### 2.3 请求体最小形态

OpenAI 兼容 / DeepSeek / OpenRouter：

```json
{
  "model": "deepseek-chat",
  "messages": [{ "role": "system", "content": "..." }, { "role": "user", "content": "..." }],
  "stream": true,
  "stream_options": { "include_usage": true },
  "temperature": 0.85,
  "top_p": 0.95,
  "max_tokens": 1200,
  "frequency_penalty": 0.2,
  "presence_penalty": 0.1
}
```

Anthropic Messages：

```json
{
  "model": "claude-sonnet-4-5",
  "system": "（角色 + 世界书 + 用户设定 + 预设前置拼好的系统段）",
  "messages": [{ "role": "user", "content": "..." }],
  "max_tokens": 28672,
  "temperature": 0.85,
  "thinking": { "type": "enabled", "budget_tokens": 24576 }
}
```

Gemini：

```json
{
  "contents": [{ "role": "user", "parts": [{ "text": "..." }] }],
  "systemInstruction": { "parts": [{ "text": "..." }] },
  "generationConfig": {
    "temperature": 0.85,
    "maxOutputTokens": 1200,
    "thinkingConfig": { "thinkingBudget": 8192 }
  }
}
```

OpenAI Responses：

```json
{ "model": "gpt-5", "input": [{ "role": "user", "content": "..." }], "reasoning": { "effort": "high" } }
```

> 正式版建议：后端统一成一种内部消息结构，再按 protocol 转成上述三种请求体；不要把协议判断散在前端。

### 2.4 拉取模型

```
GET {base}/models                    // OpenAI 兼容 / DeepSeek / OpenRouter / OpenAI Responses
GET {base}/v1/models                 // Anthropic（Header 同上）
GET {base}/v1beta/models?key=...     // Gemini
```

解析：

- OpenAI 系：`json.data[].id`
- Anthropic：`json.data[].id`
- Gemini：`json.models[].name`，去掉 `models/` 前缀

拉回后由用户勾选再写入本地模型表（样稿已实现交互；失败时会用一份示例列表，正式版删掉示例分支）。

### 2.5 官方图标匹配

`src/icons/` 里 19 个 SVG（MIT，见 THIRD_PARTY_NOTICES.md），构建时内联。匹配规则在 `app.js` 的 `ICON_RULES`：

| 关键词（modelId / 显示名，小写包含） | 图标 |
| --- | --- |
| deepseek | deepseek |
| claude / anthropic | claude |
| gemini | gemini |
| gpt / o1 / o3 / o4 / openai | openai |
| qwen / tongyi | qwen |
| kimi / moonshot | kimi |
| glm / zhipu | zhipu |
| doubao / volc | doubao |
| grok / xai | grok |
| mistral | mistral |
| llama / meta | meta |
| silicon | siliconcloud |
| openrouter | openrouter |
| google | google |

匹配不到就用中性的字母圆形（.p-icon--letter）。后端如果也做图标，可直接复用这张表。

---

## 3. 思考档位 `buildReasoningParams(model, level)`

样稿已实现为独立函数（`src/app.js`），返回：

```ts
{
  supported: boolean,
  mode: string,
  level: string,          // 实际生效档位（已按模型支持范围收敛）
  params: object | null,  // 合并进请求体的参数；null = 不带
  note: string            // 界面上给用户看的一句说明
}
```

### 3.1 档位取值

`off / auto / low / medium / high / max / on`，界面中文：关闭 / 自动 / 低 / 中 / 高 / 最高 / 开启。

- 大多数模型：关闭 / 自动 / 低 / 中 / 高。
- 支持「最高」的（如 OpenRouter、部分 Gemini 新模型）：额外出现 max。
- DeepSeek 官方：只有「关闭 / 开启」两档，**不要假装有低中高**。
- `mode: 'none'`：不支持，界面档位按钮置灰、请求里绝不带任何思考参数。

### 3.2 映射表

| mode | 档位 | 请求参数 | 备注 |
| --- | --- | --- | --- |
| `openai_effort` | off/auto/low/medium/high | chat：`{ reasoning_effort: "low" }`；Responses：`{ reasoning: { effort: "low" } }` | auto 不带参数，交给模型；off → `none` |
| `anthropic_budget` | off | 不带 thinking | |
| | auto | 不带 budget | |
| | low / medium / high | `{ thinking: { type: "enabled", budget_tokens: 2048/8192/24576 }, max_tokens: budget + 4096 }` | **max_tokens 必须大于 budget** |
| `gemini_budget` | off | `{ generationConfig: { thinkingConfig: { thinkingBudget: 0 } } }` | 只在模型允许时 |
| | auto | `thinkingBudget: -1` | |
| | low / medium / high | `thinkingBudget: 1024 / 8192 / 24576` | |
| | max（新模型） | `{ thinkingConfig: { thinkingLevel: "high" } }` | |
| `deepseek` | on | `{ thinking: { type: "enabled" } }` | 官方目前只有开/关；若走 deepseek-reasoner 模型，则用模型区分 |
| | off | `{ thinking: { type: "disabled" } }` | |
| `openrouter` | off | `{ reasoning: { enabled: false } }` | |
| | auto | `{ reasoning: { enabled: true } }` | |
| | low/medium/high | `{ reasoning: { effort: "low" } }` | |
| | max | `{ reasoning: { max_tokens: 32768 } }` | |
| `relay_suffix` | 任意 | `{ model: "<该档位对应的 modelId>" }` | 档位只是切换模型名，如 `xxx` → `xxx-thinking` |

### 3.3 400 兜底（必须）

服务器可能因为不认识思考参数返回 400/422。后端流程：

```text
1. 正常拼 request（含 reasoning params）发送
2. 如果 HTTP 400/422 且错误信息与 reasoning / thinking / budget / effort 有关：
     a. 去掉 reasoning 参数（或回退到该模型的默认档位）
     b. 记一条 warn 日志（provider、model、level、原始错误摘要）
     c. 重发一次
     d. 成功后在回复下方返回 fallbackNote：
        「这家不支持调思考深度，已按默认回复。」
3. 仍然失败才按普通错误处理（见 §4）
```

样稿用 `provider.advanced.demo400` 演示这条流程：发消息时先判定会 400，然后去掉参数重试一次，在气泡下方显示小字提示，聊天不会失败。前端字段：消息对象上的 `fallback`。

### 3.4 历史思考过程

- 提供商高级设置里的「回传历史思考过程」关闭时：不返回、也不显示思考内容。
- 打开时：后端从响应里取 reasoning/thinking 字段，或者流式时把 thinking 增量单独攒起来，存到消息的 `thinking: { sec, text }`；前端默认折叠成「想了 N 秒」。
- Anthropic 的 thinking block、OpenAI Responses 的 reasoning summary、Gemini 的 thoughtsTokenCount / thought 部分都需要在流式解析里单独处理。

---

## 4. 错误分类 `classifyApiError(err, status)`

样稿已实现，正式版前端与后端都应复用同一套 kind + 中文文案。**任何情况下都不把英文原始报错弹给用户。**

| kind | 触发条件 | 中文提示 | 建议行为 |
| --- | --- | --- | --- |
| `auth` | 401 / 403 | Key 不对：这家拒绝了这次请求，检查 API Key 有没有填错。 | 不重试，提示去改 Key |
| `notfound` | 404 | 地址或路径不对：Base URL / API 路径和这家的接口对不上。 | 不重试，检查 baseUrl / apiPath |
| `quota` | 402 | 额度用完了：这家账户没有余额，充值或换一家再试。 | 不重试 |
| `ratelimit` | 429 | 请求太频繁：等一会儿再试，或换一家。 | 可退避重试 1 次 |
| `badrequest` | 400 / 422 | 请求参数不对：这家的接口不认这个模型或这些参数。 | 思考参数问题走 §3.3 |
| `server` | 5xx | 服务器错误：这家暂时不稳定，过一会儿再试。 | 可退避重试 |
| `timeout` | AbortError / 8s 超时 | 超时了：8 秒内没连上，可能是网络慢或地址不对。 | 可重试 1 次 |
| `cors` | 浏览器 fetch TypeError（直连） | 浏览器不能直接连这家，接上服务器后就能用。 | 正式版应消失（走同源后端） |
| `network` | 离线 / 其他网络错误 | 网络不通：这台手机现在连不上网络。 | 提示检查网络 |

前端细节：

- 测试连接固定 8 秒超时（`fetchWithTimeout(url, opts, 8000)`），不无限转圈。
- 结果弹层只显示大字号中文提示；底部小字显示「分类：跨域被拦 · URL」这类调试信息，不显示原始英文异常。
- 余额查询失败时，界面上只出现小灰字「余额暂不可查」，不出现 `Error: Request to /v1/credits failed: 404`。

---

## 5. 余额查询

只对官方有余额接口的类型开启：

| 协议 | 接口 | 解析 |
| --- | --- | --- |
| deepseek | GET `{base}/user/balance` | `balance_infos[0].total_balance` + currency；CNY → ¥、USD → $ |
| openrouter | GET `{base}/api/v1/credits` | `data.total_credits - data.total_usage`，单位 $ |

- 其他协议：`balance.supported = false`，界面写「这家不支持查询余额」或「余额暂不可查」。
- 查询失败：`amount = null`、记 `failed` 和 `failKind`，界面只显示小灰字。
- 模型选择弹层的组头：有余额显示 `¥12.40 / $8.20`，否则灰字「余额暂不可查」。
- 统计页余额卡：支持的显示余额 + 查询时间；不支持的写「这家不支持查询」。
- 正式版建议后端缓存 5–10 分钟，避免每次打开弹层都打余额接口。

---

## 6. usage 记录与统计

### 6.1 每次回复从 API 响应里取什么

| 提供商 | usage 字段 | 缓存字段 | 备注 |
| --- | --- | --- | --- |
| OpenAI 兼容 | `prompt_tokens` / `completion_tokens` / `total_tokens` | `prompt_tokens_details.cached_tokens` | 流式要开 `stream_options.include_usage` |
| DeepSeek | `prompt_tokens` / `completion_tokens` | `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` | 缓存命中价便宜很多 |
| Anthropic | `input_tokens` / `output_tokens` | `cache_read_input_tokens` / `cache_creation_input_tokens` | cache creation 价格另算（本样稿未区分） |
| Gemini | `usageMetadata.promptTokenCount` / `candidatesTokenCount` | `cachedContentTokenCount` | 另有 `thoughtsTokenCount`（思考 token，可选计入输出） |

统一写入一条 usage 记录：

```ts
{
  id: number,
  at: string,             // ISO 时间
  conversation_id: string,
  character_id: string,
  provider_id: string,
  model_id: string,       // 模型注册表 id
  model_key: string,      // 真正发出去的 modelId
  model_name: string,     // 显示名，保证统计页永不出现「未知模型」
  prompt_tokens: number,
  cache_tokens: number,
  output_tokens: number,
  duration_ms: number,
  ok: boolean,
  error_kind: string | null,
  estimated: boolean,     // usage 拿不到时按字数估算
  fallback_reasoning: boolean
}
```

### 6.2 SQLite 表（建议）

```sql
CREATE TABLE usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  conversation_id TEXT,
  character_id TEXT,
  provider_id TEXT,
  model_id TEXT,
  model_key TEXT,
  model_name TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  cache_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1,
  error_kind TEXT,
  estimated INTEGER NOT NULL DEFAULT 0,
  fallback_reasoning INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_usage_at ON usage(at);
CREATE INDEX idx_usage_model ON usage(model_id);
```

统计页所有数字都从这张表按时间范围 `WHERE at >= ?` 汇总；不要在浏览器里累加权威数据。

### 6.3 花费

```text
cost =
  (prompt_tokens - cache_tokens) * price.input  / 1e6 +
  cache_tokens                    * price.cache  / 1e6 +
  output_tokens                   * price.output / 1e6
```

- 单价按「每百万 token」，币种可选 ¥ / $。
- 统计页统一折成 ¥，美元按固定汇率折算（样稿用 7.1，正式版建议放配置）。
- 模型 `price = null`：该条记录不计入花费，统计页在总览下标「N 个模型未设单价，未计入」。
- `estimated = true` 的记录（拿不到 usage 时按字数粗估）建议在界面上加「估算」标记。

### 6.4 流式

- OpenAI 兼容：`stream_options: { include_usage: true }`，最后一个 chunk 带 usage；没带就估算并标 `estimated`。
- Anthropic 流式：`message_start` / `message_delta` 里有 usage。
- Gemini 流式：最后一个 chunk 的 `usageMetadata`。
- 流式回复的耗时用「首个 token 时间 + 总时长」都记下来也可以，统计页目前显示的是平均总用时。

### 6.5 「未知模型」兜底

- 每条记录写入时必须有 `provider_id + model_key + model_name`。
- 旧数据缺字段时归到「未标记」，并在统计页底部说明「旧记录缺信息的都归到未标记，共 N 条」。
- 样稿数据全部带齐，自查断言确认页面没有「未知模型」四个字。

---

## 7. API Key 存放与安全（正式版）

1. **Key 只在 VPS 后端**：放在服务端数据库或环境变量里；按用户加密存储（例如 libsodium / Fernet，密钥放 VPS 上单独的 env）。
2. **浏览器不直接拿 Key 发请求**：前端只调同源后端，例如：
   - `POST /api/providers/{id}/test`
   - `POST /api/providers/{id}/models`（拉取模型列表）
   - `POST /api/providers/{id}/balance`
   - `POST /api/chat/stream`
3. **同时解决 CORS**：浏览器只和 VPS 同源通信；真正的模型请求由服务器发出，中转站不会看到跨域问题。
4. **界面始终掩码**：`GET /api/providers` 只返回 `keyMasked: "sk-••••1234"`、`hasKey: true`，永不返回明文；「显示」按钮在正式版最多只能短暂显示后端回传的掩码，不能回显完整 Key。
5. **日志脱敏**：后端日志、错误详情里不能出现 Authorization / x-api-key 明文；只记最后 4 位。
6. **导出**：默认不带 Key；勾选「包含 API Key」时必须有明确风险提示，并建议只在本地保存。样稿已按这个交互做。
7. **样稿过渡**：当前 `localStorage` 的 `msyq.v2.providers[].apiKey` 只用于走通交互；接后端时要做一次迁移，把 Key 上传后端后从 localStorage 删除，并提示用户「Key 已经交给服务器保管」。

---

## 8. 提示词预设与 `assemblePrompt(context)`

### 8.1 预设结构

```ts
{
  id, name, desc, builtin, source: 'preset' | 'user' | 'tavern' | 'copy',
  fragments: [{
    id, title, content,
    role: 'system' | 'user' | 'assistant',
    position: 'before_char' | 'after_char' | 'depth' | 'after_user',
    depth: number,           // position = depth 时：倒数第 N 条
    enabled: boolean,
    order: number
  }],
  sampling: {
    temperature: number | null,      // null = 不设置，用模型默认
    top_p: number | null,
    max_tokens: number | null,
    context_messages: number | null, // 上下文最多带多少条聊天
    stream: boolean,
    frequency_penalty: number | null,
    presence_penalty: number | null
  },
  extras: object
}
```

绑定顺序：**这场聊天指定 > 角色默认 > 全局默认**。

### 8.2 拼装顺序（样稿已演示）

```text
预设前置（fragment.position = before_char，按 order）
→ 角色设定（description / personality / scenario）
→ 角色设定之后的预设片段（after_char）
→ 世界书（当前生效的各本，去重）
→ 用户设定
→ 聊天记录（最近 context_messages 条）
     · position = depth 的片段插到「倒数第 N 条」之前
     · position = after_user 的片段插到最后一句用户消息之后
→ 预设后置（after_user 片段）
```

`assemblePrompt(context)` 返回 `{ blocks, text, chars, tokens, meta }`；样稿的「查看这次发给模型的内容」面板直接渲染 blocks。正式版可以把它改成后端函数，前端只负责展示后端返回的拼装结果。

### 8.3 酒馆导入映射

- `prompts[]`：`name/comment` → title，`content` → content，`role`（0/1/2 或字符串）→ role，`injection_position/injection_depth` → depth，`enabled` → enabled。
- `prompt_order`：用来恢复顺序与启用状态（支持 `[{order:[{identifier,enabled}]}]` 与字符串数组两种）。
- `temperature / top_p / max_tokens / frequency_penalty / presence_penalty` → sampling。
- 不认识的字段全部原样收进 `extras`，界面不展开；导出本应用 JSON 时一并带回。

---

## 9. 导入 / 导出格式

### 9.1 提供商

```json
{
  "app": "miushi-yuanqi",
  "kind": "providers",
  "version": 1,
  "exportedAt": "2026-11-11T...",
  "includeApiKey": false,
  "providers": [ /* provider（apiKey 默认清空） */ ],
  "models": [ /* 这些提供商下面的 model */ ]
}
```

导入规则：模型先入库（id 冲突则新 id），再导入提供商并把 `provider.models` 里的旧 model id 映射到新 id；**文件里的 apiKey 一律不接收**（样稿即如此，正式版更应在后端忽略）。

### 9.2 提示词预设

```json
{ "app": "miushi-yuanqi", "kind": "prompt_preset", "version": 1, "preset": { /* preset */ } }
```

也支持导入酒馆预设 JSON（按 §8.3 映射）。

---

## 10. 样稿里已经实现、可直接复用的函数

全部在 `src/app.js`，无依赖、纯函数：

| 函数 | 作用 |
| --- | --- |
| `classifyApiError(err, status)` | 把网络/HTTP 错误归类成 kind + 中文短提示（§4） |
| `errorKindLabel(kind)` | kind 的中文标签（给调试小字用） |
| `buildReasoningParams(model, level)` | 档位 → 请求参数（§3） |
| `reasoningParamsPreview(model, level)` | 给界面看的 JSON 预览 |
| `assemblePrompt(context)` | 按顺序拼装提示词，返回 blocks/text/tokens（§8.2） |
| `fetchWithTimeout(url, opts, ms)` | 带 8 秒超时的 fetch |
| `maskKey(key)` | `sk-••••••••1234` 形式的掩码 |
| `normalizeTavernPreset(raw)` | 酒馆预设 JSON → 本应用预设（§8.3） |
| `costOfRecord(record)` / `aggregateUsage(records)` | 从 usage 记录算 token、命中率、花费、排行 |
| `matchIconKey(text)` | 模型 ID → 官方图标 key |

样稿通过 `window.__a2` 暴露了这些函数与本地状态，方便 `scripts/check-a2.mjs` 自查；正式版应该删掉这个调试入口。

---

## 11. 后端对接清单（B 阶段已落地）

- [x] `providers` / `models` / `prompt_presets` / `characters` / `user_personas` / `world_books` / `chats` / `messages` / `memories` / `usage` / `settings` 全部落 SQLite，后端为权威。
- [x] Key 用 Fernet 加密存 SQLite（密钥来自 `APP_SECRET`）；GET 只回 `hasKey` + `keyMasked`；所有 provider 请求走 `/api/providers/{id}/*` 代理。
- [x] 协议适配层：统一内部消息结构 → OpenAI 兼容 / Anthropic Messages / Gemini generateContent / OpenAI Responses 四种请求体（DeepSeek、OpenRouter、中转站复用 OpenAI 兼容）。
- [x] `buildReasoningParams` 在 `server/reasoning.py` 用同一套映射；400/422 自动去掉思考参数重试一次 + `fallback_reasoning`；模型不支持思考时绝不带参数。
- [x] usage 表按 §6.2 建表，每次回复后写入；流式开 `stream_options.include_usage`；Anthropic / Gemini / Responses 从各自事件取 usage；拿不到时按字数估算并标 `estimated`。
- [x] 统计接口：`GET /api/stats?range=today|7d|30d|90d|all&metric=token|cost&rank=model|provider|char`，返回总览、热力图、柱状图、排行、余额；数字全部来自 usage 表。
- [x] 余额接口后端缓存 5 分钟；失败只返回 `{ supported, amount: null, failKind }`，界面只显示「余额暂不可查」。
- [x] 导入导出：角色 JSON / PNG 由后端解析写出（PNG 读 `ccv3` 再读 `chara`，写出 v2 + `chara`）；世界书 / 用户设定 / 预设 / 提供商 JSON 由后端校验与代理。
- [x] 删除样稿的 `advanced.demo400` 和 `window.__a2`；400 兜底改为真实逻辑。
- [x] localStorage 迁移：`POST /api/migrate/local` 按 id 去重、可重复；用户确认后可连同加密上传 Key，迁移成功后前端清空本地明文 Key。

### 11.1 与最初设想的差异（以实现为准）

1. **聊天接口**用 `POST /api/chats/{characterId}/messages` 返回 SSE，而不是一次性的 `/api/chat/stream`；一场聊天固定属于一个角色，符合角色系统方案第 5 节。
2. **前端整体状态**通过 `GET /api/bootstrap` + `PUT /api/state` 同步集合与绑定；聊天消息、记忆、现在卡走各自专用接口，避免整体同步覆盖流式写入。
3. **思考参数兜底**判定为：HTTP 400/422 且错误文本包含 think / reason / budget / effort 之一；其余 400 按普通参数错误处理，不重试。
4. **演示用 400** 改由后端环境变量 `MSYQ_MOCK_400=1`（配合 `MSYQ_MOCK=1`）模拟，仅用于本地演示与测试，正式环境不打开。
5. **Key 的「显示」按钮**在接后端后只提示「已加密保存在服务器，界面只显示掩码」，不允许回显明文。

---

文档结束。若实现时协议或字段有变化，以本文件为准更新，不要在浏览器里另起一套。
