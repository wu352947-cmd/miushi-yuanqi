# PHASE D2 · 并行开发契约（Lead 冻结版 · 不许擅自改接口）

本文件是第 D2 轮三块工作的**唯一接口契约**。所有 teammate 动手前先读完本文件 + `PHASE_D2_PROMPT.md`（完整需求）。需求细节以 `PHASE_D2_PROMPT.md` 为准，接口/文件边界以本文件为准。有冲突先发消息给 lead，不要自己改契约。

项目根：`/workspace/miushi-yuanqi`。不部署、不 SSH、任何 key 不进代码/文档/截图/日志/输出，不运行 `scripts/shoot.mjs`（会清空 shots/）。

---

## 0. 构建系统（Lead 已改好，所有人共用）

`node scripts/build.mjs` 现在会内联：

1. `src/styles.css` + `src/liquid.css` + `src/features/*.css`（按文件名排序）；
2. `src/data.js`；
3. `src/modules/*.js`（按文件名排序）注入 `src/app.js` 的 `/*@MODULES@*/` 占位处 —— **模块和 app.js 在同一个 IIFE 作用域**；
4. `src/app.js` → `dist/index.html` 单文件。

`node scripts/build.mjs --inline-covers` 另外会 `import('scripts/inline-covers.mjs')` 的 `buildInlineCovers({root, html, read})`，返回 `{html, stats}`（该文件由 covers 负责人实现）。

### 模块写法（重要）
- 模块文件在**第 5 行**就被注入执行，早于 app.js 里所有 `var state = ...`、`var SHEETS = {}` 等初始化。**模块顶层只能声明函数/常量，绝不能读 state / SHEETS / DOM**；所有运行时逻辑放进函数，在 DOMContentLoaded 之后调用（例如模块内 `document.addEventListener('DOMContentLoaded', function(){ setTimeout(d2Init, 0); })`）。
- 模块内可直接调用 app.js 的函数与变量（运行时）：`state`、`save()`、`serverFetch(path, {method, body})`、`esc()`、`clone()`、`toast()`、`openSheet(name, payload)`、`closeSheet()`、`navTo()`、`go()`、`renderChat()`、`renderMe()`、`renderProviderDetail()`、`currentChar()`、`findChar()`、`findProvider()`、`ensureChat()`、`chatMessages`、`chatOf()`、`updateChatHeader()`、`downloadBlob()`、`SHEETS`、`DATA`、`WALLPAPERS` 等。给 SHEETS 加弹层要在 init（DOMContentLoaded 后）里赋值。
- 代码风格跟 app.js 一致：`var` / `function` / 普通 ES5（可少量 ES6 但别用框架、别引外部依赖）。不要写 `import/export`。
- 新 UI 类名统一前缀 `d2-`，CSS 只写进自己的 `src/features/xxx.css`；**不许改 styles.css / liquid.css / index.html**。颜色/玻璃/字号复用现有 token 和类：`.sheet`、`.sheet-label`、`.sheet-note`、`.menu-row`、`.option`、`.option-list`、`.bind-mini`、`.a2-card`、`.a2-banner`、`.a2-tag`、`.seg-slider`、`.ask-card`、`.toggle-row`、`.switch`、`.btn`、`.text-btn`、`.field`、`.mini-btn`、`.test-state`。两套主题（pink / ice）都要能看。手机宽度 390px，触控目标 ≥ 40px。

### 编辑协议（防并发覆盖）
- 只改自己名下的文件；**app.js 只能用 edit 工具做小范围、字面量明确的修改**，禁止整文件重写、禁止用 sed/python/node 脚本去 patch app.js。
- 遇到 `FS_STALE_VERSION`：重新 read 当前文件 → 把改动 rebase 到新内容 → 再 edit。
- 需要改别人文件：先发消息给 lead，由 lead 决定。
- 完成时：跑 `.venv/bin/python -m pytest -q`（碰后端必跑，必须全绿）+ `node scripts/build.mjs`（无报错），然后在 shared task 上 complete，并给 lead 发一条总结（改了什么/测试结果/没做完的如实写）。

### app.js 修改区划（互不越界）
| 负责人 | 只允许改 app.js 的这些地方 |
|---|---|
| providers-block1 | `collectProviderForm` / `saveProvider` / `testConnection` / `SHEETS.connTest` / `renderProviderDetail`(只加提示行) / `providerConfigTabHtml` / `providerAdvancedTabHtml` / `applyProtocolDefaults` / `startPullModels` 里与识别相关处 / `buildReasoningParams`（仅加无后缀/降级逻辑） |
| covers-block2 | `coverUrl` / `setCoverImg` / `coverThumb` / `localFakeReply`（以及模块里的 `/*@INLINE_COVERS@*/` 标记） |
| chat-history-ui | `ensureChat` / `persistChat` / `openChat` / `chatInitMessages` / `renderMe`（只加一行 hook）/ `renderSettings`（只加一行 hook） |
| chat-actions-ui | `renderMessage` / `renderChat` / `appendChat` / `scrollChatBottom`（如需要）/ `sendChat` 及 SSE 事件处理（加 mode / 按钮 / fallback 联动） |
| 其他（SHEETS 注册、事件委托、DOM 注入） | 都写进自己的模块，用 DOMContentLoaded 后初始化 + 自己的 `document.addEventListener('click', ...)` 委托，事件属性用 `data-d2a-...` / `data-d2b-...` / `data-d3-...` 命名空间，别动 app.js 的 `handleA2Action` 分发 |

---

## 1. 第一块 · 提供商保存自动连通 / 测试连接（owner: providers-block1）

### 1.1 后端接口（新增/改造，旧接口保持兼容）

**A. `POST /api/providers/normalize-url`**（纯函数，不发网络请求）
请求：`{baseUrl, apiPath, protocol}`。响应：
```json
{"baseUrl":"https://api.deepseek.com/v1","apiPath":"/chat/completions","protocol":"openai",
 "changes":[{"field":"baseUrl","from":"api.deepseek.com/v1/chat/completions","to":"https://api.deepseek.com/v1","label":"已自动改为 https://api.deepseek.com/v1"}]}
```
规则（每条都要单元测试）：
1. 去首尾空白；没有 `http://`/`https://` 补 `https://`。
2. 完整地址粘进 Base URL 时拆成 Base URL + API 路径：`.../v1/chat/completions`、`.../chat/completions`、`.../v1/messages`、`.../messages`、`.../v1/models`、`.../models`、`...:generateContent`、`...:streamGenerateContent`、`.../v1beta/models/...`。
3. 防止 `/v1/v1`、`//`、路径重复拼接；Anthropic / Gemini 同样处理（Anthropic base 带不带 /v1 都归一成 base + `/v1/messages`；Gemini 归一到 base + `/v1beta/models/{model}:generateContent`）。
4. 用户手动改过的 API 路径不覆盖：请求里传了非空 `apiPath` 且不是默认值就保留。
5. 只填域名没 /v1 的情况由 save-connect 的网络探测决定最终 base（见 B），normalize-url 只出候选，不猜死。

**B. `POST /api/providers/{provider_id}/save-connect`** —— 保存配置后自动连通。
请求体可带 `{provider: {...}}` 覆盖已保存配置（前端先 PUT 保存也行，接口要能独立完成）。流程：
1. 归一化网址（规则同上）；若只填域名，依次免费试 `{base}/v1/models`、`{base}/models`，哪个通就改写 baseUrl；
2. 按协议探测免费列表接口：OpenAI 兼容 `GET {base}/models`、Anthropic `GET {base}/v1/models`、Gemini `GET {base}/v1beta/models?key=…`；自动识别协议格式（探测成功后把命中的格式写回 provider）；
3. 解析模型 ID → 识别家族 `deepseek / claude / gemini / gpt与o系列 / grok / kimi / glm / qwen / doubao`，匹配官方图标（`PROVIDER_ICONS` 已有 key）、能力标签（vision/tools/reasoning）、已知价格（复用 seed_data / 现有目录里同 modelId 的价格；未核实写 null 不编造）；
4. 按 `server/reasoning.py` 的档位规则给每个模型预设 `reasoning: {mode, levels, defaultLevel}`（用现有 default_level/家族映射，别另起一套）；
5. 能查余额就查（DeepSeek / OpenRouter），查不到静默、不显示、不报错；
6. 把模型写进 models 表（按 providerId + modelId 去重），provider 保存。**全过程绝不调用任何生成接口**（chat/completions、messages、generateContent、responses 等）。
响应（HTTP 200；连不上也不抛 5xx）：
```json
{"ok":true,"saved":true,"connected":true,"modelCount":5,
 "message":"已连接，识别到 5 个模型",
 "provider":{...},"models":[...],
 "changes":[{"field":"baseUrl","from":"...","to":"...","label":"已自动改为 ..."}],
 "probe":{"kind":"openai","url":"https://…/models","status":200,"ms":123},
 "balance":{"supported":true,"amount":12.4,"currency":"¥","at":"11月11日 07:20"} }
```
失败（/models 不可用/地址不对/Key 不对）：仍保存配置，`{"ok":false,"saved":true,"connected":false,"modelCount":0,"models":[],"message":"已保存，暂时无法自动识别模型，可手动添加，或点测试连接确认","kind":"..."}`，一句话中文原因，不出现英文原始报错。

**C. `POST /api/providers/{provider_id}/test` 改造** —— 用户点「测试连接」时只发**一条真实的最小生成请求**（单条 user "hi"，max_tokens 很小，测当前选中/默认模型；stream=true 时同时验证流式）。
请求：`{modelId?: string, checkStream?: true, checkReasoning?: false}`。
响应：
```json
{"ok":true,"kind":"ok","message":"测试连接成功：模型能正常回复。",
 "modelId":"...","modelName":"...","stream":true,"streamSupported":true,
 "reasoning":{"checked":false,"results":[{"level":"high","ok":true}]},
 "status":200,"ms":820,"at":"11月11日 07:20","responseText":"hi"}
```
- 无 Key → 沿用旧的中文 nokey 响应。
- `checkReasoning=true` 才对每个可用档位各发一条（前端已提示会额外产生费用）。
- 失败：一句话中文原因 + 下一步（地址不对 / Key 不对 / 余额不足 / 这家不支持某功能，已自动关闭），不得出现英文原始报错。
- mock 模式（MSYQ_MOCK=1）下返回成功假回复，不请求外网。
- 测试结果前端缓存在 `provider.advanced.testResult = {at, ok, message, modelId, streamSupported, reasoning}` 并 `save()`，下次打开显示「上次测试：…」。

**D. 400 兜底（已有 server 端逻辑）补齐前端**：聊天回复带 `fallback` / `done.fallbackRemoved` 时，把「模型+档位」记进 `provider.advanced.unsupportedReasoning[modelId + '|' + level] = true` 并 save；以后 `buildReasoningParams()` 对这个组合降为 `auto`（不再发送该档位），并在回复下方小字说明「这家不支持「高」档，已自动关闭，以后不再发送」。
> 与 chat-actions-ui 的接口：chat-actions-ui 负责在 sendChat 的 fallback SSE 分支里调用 `if (typeof d2OnServerFallback === 'function') d2OnServerFallback(removedList, level);`（只加这一行），providers-block1 提供 `d2OnServerFallback`。

**E. 中转站转发方式**：`provider.advanced.forwardMode` ∈ `auto | openai_compat_translate | openai_compat_passthrough | native_anthropic | native_gemini | model_suffix`，默认 `auto`。高级设置里加下拉选择。后端 `protocol_of` / 思考参数构建 / 请求地址要认这个字段：
- `auto`：现状（协议 + 模型家族推断）；
- `openai_compat_translate`：中转只吃 OpenAI 参数 → 思考参数用 OpenAI effort 形式翻译；
- `openai_compat_passthrough`：中转原样转发 → 用模型家族原生思考参数（不翻译）；
- `native_anthropic` / `native_gemini`：强制走对应原生协议；
- `model_suffix`：切档位 = 换模型 ID（如 `-thinking` 后缀）；前端切档时把 modelId 换成对应后缀，后端不额外发思考参数。
档位由「后端真实模型家族 + 转发方式」决定，不看中转站名字。

### 1.2 前端（src/modules/providers-block1.js + src/features/providers-block1.css + 上述 app.js 区）
- 底部按钮保持「测试连接 / 删除 / 保存」不变；「保存」下方一行小字「保存后自动连接，不扣费」。
- Base URL 失焦/粘贴后调用 normalize-url（在线走后端；离线用模块内同样规则的 JS 镜像），把 Base URL、API 路径、协议自动填好，并在输入框下小字「已自动改为 …」（可多条）。
- 「保存」= 先保存配置（PUT provider + Key 接口）→ 调 save-connect → 用返回的 provider/models 覆盖本地 state → 结果面板显示「已连接，识别到 N 个模型」+ 修改提示；失败显示「已保存，暂时无法自动识别模型，可手动添加，或点测试连接确认」。本地无后端时只保存 + 提示本地演示模式无法自动识别。
- 「测试连接」弹层：先显示「会发一条测试消息，按次计费的接口可能扣一次费」+ 勾选「同时检测思考档位（会额外产生几次请求费用）」→ 开始 → 只发一次生成请求（勾选档位除外）→ 显示成功/失败、模型名、是否支持流式、耗时、测试时间、思考档位逐项结果；缓存显示「上次测试：…」。
- 「拉取模型」按钮仍在模型页，手动刷新（保留现状即可，可复用 save-connect 的模型入库函数）。
- 所有失败 toast 一句话中文 + 下一步。

### 1.3 必写测试（`server/tests/test_save_connect.py`）
1. URL 归一化逐条参数化测试（≥10 条规则用例）。
2. **保存流程零生成请求**：monkeypatch httpx 记录所有请求 → 调 save-connect → 断言全部 GET、URL 只含 models/balance，不含任何生成路径；同时 monkeypatch `providers.chat_stream/complete` 为「被调用就 fail」。
3. /models 不可用时仍保存配置 + 返回 fallback 中文 message。
4. 测试连接**只发一次生成请求**（默认）；checkReasoning=true 时请求数 >1；断言请求体是单条 "hi" 且 max_tokens 很小。
5. 余额失败不影响保存、响应不含英文报错。
6. 家族识别 / 图标 / 价格 / 思考档位预设断言（至少 deepseek+claude+gpt 三家）。

## 2. 第二块 · 网易云封面（owner: covers-block2）

- 正常 http(s) 访问：手机直连网易云；加载失败依次换 `p1 / p2 / p3 / p4.music.126.net` 重试（保持原路径 + `?param=WxH`），4 个都失败才退回主题色素面唱片（`.is-missing`）。
- 改 `coverUrl / setCoverImg / coverThumb`：维护尝试序号；`coverThumb` 内联 onerror 调模块暴露的 `window.d2CoverError(img)`（模块 init 时挂到 window）。不要出现破图标。
- `scripts/inline-covers.mjs`：导出 `async buildInlineCovers({root, html, read})`：从 `src/data.js` 解析所有内置歌曲 `coverUrl`，下载（https，超时/重试），压成 300px JPEG（质量 ~0.72）data URI，把 built html 里的 `/*@INLINE_COVERS@*/` 标记替换成 `var INLINE_COVER_MAP = {"<原coverUrl>":"data:image/jpeg;base64,..."};`。构建时网络失败要**明确报错或明确 warning 并统计成功数**，不许静默打空；交付构建 `node scripts/build.mjs --inline-covers` 必须产出一个所有内置封面都内联的 dist/index.html。`coverUrl()` 命中 INLINE_COVER_MAP 时直接返回 data URI。
  （可用 `ffmpeg` 或 `python3 -c "from PIL import ...` 处理图片，系统 python3 有 PIL 13；node 用 fetch 下载；不要新装依赖。）
- 验证脚本 `scripts/phase-d2-covers-check.mjs`：静态服务 dist/index.html + headless chrome（`/usr/bin/google-chrome`）加 `--host-resolver-rules="MAP *.126.net 127.0.0.1"`，打开「一起听」页，等封面加载，断言歌单/首页唱片封面 `naturalWidth>0`，截图到 `shots/phase-d2/covers-inline-blocked-{pink,ice}.png`，输出 JSON 结论（成功几张/失败几张）。用 CDP（参考 `scripts/phase-c2-shots.mjs` 的写法）。
- 离线演示回复 `localFakeReply`：当前思考档位不是「关闭」时，回复带一条可折叠演示思维链（明确标「演示」），档位关闭时没有。只能标演示，不能冒充真实模型思维链。

## 3. 第三块 · 聊天记录管理与绑定

### 3.1 后端接口契约（owner: chats-block3，所有接口前缀 /api/chats，旧 `/ensure`、`GET /{character_id}`、`PATCH /{character_id}`、`DELETE /{character_id}` 保持兼容）

注意路由顺序：`/id/{chat_id}`、`/search`、`/bulk-delete`、`/bulk-export`、`/import` 必须注册在 `/{character_id}` 泛匹配之前。

- `GET /api/chats?characterId=&q=` → `{"chats":[summary]}`；summary：`{id,characterId,title,preview,messageCount,lastAt,createdAt,updatedAt,pinned,personaId,worldBookId,presetId,modelId,reasoningLevel,settings}`。q 匹配标题或消息内容。排序 pinned DESC, lastAt DESC。
- `POST /api/chats` body `{characterId,title?,personaId?,worldBookId?,presetId?,modelId?,reasoningLevel?,settings?}` → `{"chat": full}`（含 messages；角色有 first_mes 时写入一条 ai 开场白）。title 缺省 `角色名 + ' - ' + YYYY-MM-DD HH:mm`。
- `GET /api/chats/id/{chat_id}` → `{"chat": full}`。
- `PATCH /api/chats/id/{chat_id}` body 任意绑定字段/title/pinned/settings（settings 做浅合并）→ `{"chat": 不含 messages}`。
- `DELETE /api/chats/id/{chat_id}` → `{"ok":true}`（级联删 messages）。
- `POST /api/chats/id/{chat_id}/branch` body `{messageId:int}` → `{"chat": full}`：新对话复制到该消息（含）为止，title = 原标题 + ' · 分支'，绑定全复制。
- `GET /api/chats/search?q=&characterId=` → `{"results":[{chatId,characterId,chatTitle,messageId,role,text,time,createdAt}]}`（title 命中时 messageId=null；limit 50；消息内容大小写不敏感）。
- `POST /api/chats/bulk-delete` `{chatIds:[...]}` → `{"ok":true,"deleted":N}`；`POST /api/chats/bulk-export` `{chatIds:[...]}` → `{"app":"miushi-yuanqi","kind":"chats","version":1,"exportedAt":...,"chats":[full...]}`。
- `GET /api/chats/id/{chat_id}/export` → `{"app":"miushi-yuanqi","kind":"chat","version":1,"exportedAt":...,"character":{"id","name"},"bindings":{"personaId","worldBookId","presetId","modelId","reasoningLevel"},"chat":{...full}}`。
- `POST /api/chats/import` body `{format:"auto"|"json"|"jsonl", content:string?, payload:object?, characterId?:string}` → `{"ok":true,"chat":full,"matchedBy":"characterId"|"name"|"user","characterId":...,"messageCount":N}`。支持本项目 JSON（单个/批量）与 SillyTavern jsonl（首行 metadata `{user_name,character_name,create_date}`，其后 `{name,is_user,is_system,mes,send_date}`；is_system 跳过，is_user→me 否则→ai）。ST 按 `character_name` 自动匹配角色（大小写不敏感），匹配不到用传入 characterId，都没有 → 400 中文「先选一个角色再导入。」
- `PATCH /api/chats/id/{chat_id}/messages/{message_id}` body `{text}` → `{"message":...}`（标 edited）；`DELETE` 同路径 → `{"ok":true,"deletedId":N}`。
- `POST /api/chats/id/{chat_id}/auto-title` → `{"ok":true,"title":...}`：用 `providers.complete` 让模型起名（mock 模式可用）；失败保持原标题 + 中文提示。用户改过的标题 AI 不再覆盖（用 `chat.settings.titleLocked=true` 标记，前端改名时置位）。
- `POST /api/chats/{character_id}/impersonate` body `{modelId?,reasoningLevel?}` → `{"ok":true,"text":"..."}`：生成一条「用户口吻」的候选回复，**不落库**，前端确认后再正常发送。
- 扩展 `POST /api/chats/{character_id}/messages`：`ChatSendIn` 增加 `chatId: str|None`、`mode: "normal"|"continue"|"regenerate"`。regenerate 先删该对话最后一条 ai 消息（若有）再生成、不写新 user 消息；continue 不写 user 消息、接在最后一条 ai 后面继续写；normal 不变。SSE 事件形状不变（无 user 事件时前端自己处理）。
- 作者注释：`chat.settings.authorNote = {text, depth}`（depth 0=最后一条之前，数字越大越靠前），`prompts.assemble` 要把它作为额外 system 指令按 depth 插进聊天记录，只对这段对话生效。
- 绑定：后端已支持 chat > character > global 的人设解析（`prompts.resolve_persona`）与世界书三层（global + char + chat），本轮要保证新接口能写/读这些字段；`db.get_state` 每个角色的 active chat 改成 `pinned DESC, last_at DESC` 取一条且包含 `id`；`db.sync_state` 的 chats 部分要认 `chat.id`（有 id 就按 id 更新，没有才按角色旧逻辑），避免多对话时整体同步写错对话。
- 迁移：`SCHEMA_VERSION = 3`，新增 messages `edited INTEGER NOT NULL DEFAULT 0`（幂等，写好 `_migrate`），旧库能升上来；`test_migrate` 同步加断言。

必写测试 `server/tests/test_chat_history.py`（≥18 条）：列表/过滤/排序置顶、新建默认标题格式、改名、置顶、删除级联、branch 复制前缀与绑定、搜索消息命中与跳转 id、消息编辑/删除、export/import 本项目 JSON 往返、ST jsonl 导入（按名字匹配/指定角色两种）、auto-title mock 成功且 titleLocked 不覆盖、impersonate 不落库、authorNote 进入 prompt-preview、人设三层优先级（chat>char>default）、旧 /ensure 兼容。

### 3.2 前端聊天记录数据层（owner: chat-history-ui，`src/modules/chat-history.js`）

暴露同作用域对象 `D2ChatStore`（冻结接口，chat-actions-ui 会调用）：

```js
var D2ChatStore = {
  list: async function(characterId) {},        // [summary]；characterId 为空 = 全部角色
  get: async function(chatId) {},              // full chat（含 messages）
  active: function(characterId) {},            // 当前 active chat 对象（= state.chats，确保存在）
  create: async function(characterId, opts) {},// 新建并切换为 active，返回 full chat
  switchTo: async function(chatId) {},         // 切 active：state.chats[charId]=chat、chatMessages、save、renderChat、updateChatHeader、renderChatContext、renderMe、go('chat')
  rename: async function(chatId, title) {},    // 用户改名 → titleLocked=true
  setPinned: async function(chatId, pinned) {},
  remove: async function(chatIds) {},          // 批量删除；若删的是 active 则切到最新一条或新建
  search: async function(q, characterId) {},   // [{chatId,characterId,chatTitle,messageId,role,text,time,createdAt}]
  branch: async function(chatId, messageId) {},// 从某条消息另开分支（复制到该条），切换过去
  exportChat: async function(chatId) {},       // 下载 JSON（内部用 downloadBlob）
  importContent: async function(content, characterId) {}, // 自动识别本项目 JSON / ST jsonl
  updateChat: async function(chatId, patch) {},// PATCH 绑定/title/pinned/settings
  autoTitle: async function(chatId) {},        // 调接口；返回 title
  formatTime: function(iso) {},                // 今天→"06:03"，昨天→"昨天 22:41"，更早→"11-09"
  summarize: function(chat) {},                // {id,title,preview,messageCount,lastAt,...}
  onChange: function(fn) {},                   // 注册列表变化回调（内部调用 fn()）
  refresh: async function(characterId) {}      // 重新拉列表并通知 onChange
};
```

- **在线模式（SERVER_MODE && serverOnline）**：全部走 3.1 的 API（serverFetch），失败给中文一句话。
- **离线模式（file:// 或后端断线）**：用本地结构 `state.d2LocalChats = {chatId: fullChat}` 自增删改（id 用 `newId('chat')`），active 镜像到 `state.chats[characterId]` 并 `save()`；至少支持列表/新建/切换/改名/置顶/删除/分支/搜索/导出（离线时导入可以只支持本项目 JSON）。**离线分支不能崩**，因为交付样稿可能被 file:// 打开。
- 每次数据变化 `save()` 并在在线模式 `save()` 会触发整体同步；多对话时整体同步依赖后端 `chat.id` 逻辑（3.1 已约定），不要绕过。

### 3.3 前端界面：对话列表 / 总入口 / 搜索 / 改名 / 人设三层（owner: chat-history-ui）

1. **本角色对话列表**（玻璃 sheet `d2ChatList`）：从聊天页收纳菜单和角色卡进入都行（至少做到「聊天页收纳菜单 → 管理聊天文件」可用，角色卡入口可放）。行显示标题、最后一句预览、时间（今天几点/更早日期）、条数；置顶用小珍珠/小爱心标记；行点击切换；右上「新对话」；行尾「⋯」菜单（改名 / 置顶 / 导出 / 删除二次确认）。改名 sheet 带「AI 帮我起个名」按钮（默认关闭：设置里开关 `aiChatTitle`；单条也可点，点了先提示「会调用一次模型，按次计费的可能扣一次费」）。
2. **「我的」页总入口「最近的聊天」**：renderMe 里加一行（hook），点开玻璃 sheet：全部角色按时间混排、按角色筛选 chip、搜索框（搜消息内容调 search，命中显示上下文片段，点击跳到该角色该对话该消息位置）、多选模式批量删除 / 批量导出。
3. **人设三层绑定 UI**：设置页加两个开关「切换人设时提示」「自动把选中的人设绑定到当前聊天」；聊天页绑定 sheet 显示三层（默认 / 角色默认 / 这段聊天）+ 来源标签，切换时按开关行为提示或自动绑定；角色默认在角色卡页可改（已有 `charPersona` sheet 复用/增强）。世界书三层（全局启用 + 角色 / 聊天绑定）UI 复用现有 `chatBook` / `charBook`。
4. `renderSettings` 两开关渲染 + 保存到 `state.settings.chatPersonaPrompt` / `state.settings.autoBindPersonaChat`（默认：提示开、自动绑定关）。

### 3.4 前端：聊天页收纳菜单 / 单条消息操作 / 分支（owner: chat-actions-ui）

`src/modules/chat-actions.js` + `src/features/chat-actions.css`，app.js 区见 0 节表。

1. **聊天页玻璃收纳菜单**（聊天页右上角加一个圆形「⋯」按钮，DOM 注入 `.chatbar__actions`，菜单用列表面板或 sheet，玻璃风，参考酒馆左下角菜单但界面自己做）。项：
   - 开始新聊天 → `D2ChatStore.create(charId)`
   - 管理聊天文件 → 打开 `d2ChatList`（chat-history-ui 提供 `window d2OpenChatList` 或 SHEETS.d2ChatList；若对方还没完成，用 `openSheet('d2ChatList')`）
   - 保存检查点 → 在当前位置存一个分支点：`D2ChatStore.updateChat(chat.id, {settings:{checkpoints:[...,{messageId, at, title}]}})`，之后可从检查点列表回到这里另开（再调 branch）
   - 删除消息 → 进入多选模式（消息上出现复选框 + 底部「删除选中」条）
   - 重新生成 → 删最后一条 ai 后按 mode:'regenerate' 重发生成
   - 续写 → mode:'continue'
   - AI 帮答 → 调 impersonate，弹确认卡（采纳/换一条/取消），确认后作为用户消息发送
   - 作者注释 → sheet 编辑 text + depth（0–N），存 `chat.settings.authorNote`，提示「只对这段聊天生效」
   - 本聊天绑定的世界书 → 打开现有 `chatBook` sheet
   - 记录导出 → `D2ChatStore.exportChat(chat.id)`
2. **单条消息操作**：点消息（气泡）弹出玻璃操作条：编辑 / 删除 / 复制 / 重新生成（仅 ai 最后一条可用或从该条重新生成）/ 从这里分支。编辑用 sheet 或行内 textarea，保存调 message PATCH（`D2ChatStore` 提供 `editMessage/deleteMessage`，或 chat-actions 直接 serverFetch + 本地更新，二选一但要在契约内自洽；推荐 chat-history-ui 在 D2ChatStore 上再暴露 `editMessage(chatId,messageId,text)`、`deleteMessage(chatId,messageId)`、`refreshActive(characterId)`，若已实现就直接用）。
3. 分支后 toast「已从这条另开一段对话」并切换到新对话。
4. 所有操作都必须真实生效（在线 + 离线都要能用；离线用 D2ChatStore 的本地实现），不许只弹 toast。

---

## 4. 截图与验收（Lead / 后续 shots 负责人）
- 截图统一放 `shots/phase-d2/`，两主题（pink / ice）都要：提供商详情页（自动补全提示、保存后「已连接，识别到 N 个模型」、测试连接费用提示）、对话列表、最近的聊天总入口、搜索、改名、人设三层绑定、聊天页菜单、单条消息操作、分支对话、`--inline-covers` 在拦截 126.net 后仍显示封面。
- 截图脚本自己写（可参考 `scripts/phase-c2-shots.mjs` 的 CDP 写法），只写 `shots/phase-d2/`，**不要**运行 `scripts/shoot.mjs`。需要后端能力的界面（保存连通、聊天记录）截图时用 `MSYQ_MOCK=1 .venv/bin/python -m server.app` 起本机后端 + headless chrome 访问 127.0.0.1。
- 最终 `PHASE_D2_CHECK.md` 由 Lead 汇总：pytest 结果、构建（普通 + `--inline-covers`）、逐条需求完成情况、未完成项如实写原因、截图清单。

## 5. 汇报格式（发给 lead 的消息）
```
[task-id] 完成/阻塞
改了什么：<文件列表 + 一句话>
测试：pytest X passed；build 通过（大小）
截图/证据：<路径>
未完成/风险：<如实写，没有就写无>
```
