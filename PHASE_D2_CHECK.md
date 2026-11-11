# PHASE D2 CHECK · 保存自动连通 / 封面加载 / 聊天记录管理

> 第 D2 轮，目标三块**全部实现**。三块按顺序推进，每块完成都跑了全量 pytest 与 `node scripts/build.mjs`；最后统一跑两种构建、两主题截图与封面拦截验收。
> 没有部署、没有 SSH、没有输出任何真实 key；没有运行 `scripts/shoot.mjs`；没有自绘 / 生成 / 改色壁纸。
>
> 执行方式说明：本环境的 teammate 启动接口不可用（`startContinuable is not a function`），因此由 Lead 单人按 `PHASE_D2_CONTRACT.md`（接口契约，保留作说明）完成全部三块，未使用并行 teammate。

## 0. 结论速览

| 项目 | 结果 |
|---|---|
| 全量 pytest | **143 passed**（基线 87 + 第一块 34 + 第三块 21 + 迁移 1；其中 46 条思考档位请求体测试全部保留并通过） |
| 普通构建 `node scripts/build.mjs` | 通过（单文件 2202.0 KB，18 张壁纸） |
| 交付构建 `node scripts/build.mjs --inline-covers` | 通过（**9/9 张封面内联**，127.3 KB data URI，单文件 2329.9 KB / 磁盘 2,428,312 B） |
| 交付文件 | `dist/index.html`（当前为 `--inline-covers` 版本，可直接双击打开 / 发给手机） |
| 封面拦截验收 | `node scripts/phase-d2-covers-check.mjs`：拦截 `*.126.net` 后 7/7 封面仍显示（两主题），✅ |
| 双主题截图 | `shots/phase-d2/` 共 32 张（pink / ice 各 15 张 + 封面拦截 2 张） |

## 1. 上一轮已完成、本轮未回退的部分（逐项确认）

- **46 条思考档位请求体断言**（`server/tests/test_reasoning.py`）原样保留，全量测试通过。
- **预置模型 / 价格 / 用量归一化 / 峰谷计费**：未改动 `seed_data.json` 的价格与模型 id；`server/reasoning.py` 只做了「转发方式」的增量（见第一块），16 种 mode 与既有映射未回退。
- **`mergePresetCatalog()` / `RETIRED_PRESET_MODELS`**：`src/app.js` 里未删除、未改逻辑；本轮没有把提供商重新绑回旧模型 id。
- **粉色主题首页壁纸 wp18**：未改动 `DATA.themes.pink.pages.home = 'wp18'`；壁纸列表仍 18 张，构建校验 18 张通过。
- **玻璃参数 / 粉色正文 `#4E3B45`**：未改 `styles.css` / `liquid.css` 的玻璃 token 与正文色；新界面全部复用现有 glass token，没有加厚白雾。
- **底栏 66px / 爱心不跳不凸 / 「此刻」编辑布局**：未改底栏与「此刻」相关代码，两主题截图里底栏正常。
- **模型目录修复**：`loadState` 末尾仍调用 `mergePresetCatalog(base)`。

## 2. 第一块 · 提供商与中转站「保存」和「测试连接」——已全部完成

### 2.1 需求逐条

| 需求 | 状态 | 实现要点 |
|---|---|---|
| 1. 底部按钮「测试连接 / 删除 / 保存」不变；保存下方小字 | ✅ | 按钮标签未改；底部操作条下方一行「保存后自动连接，不扣费」 |
| 2. 保存 = 先存配置再自动免费连通 | ✅ | `POST /api/providers/{id}/save-connect`：归一化网址 → GET 模型列表识别格式 → 拉模型 → 家族识别（图标/能力/价格/档位）→ 查余额（失败静默）→ 返回「已连接，识别到 N 个模型」；识别失败只保存配置并返回「已保存，暂时无法自动识别模型，可手动添加，或点测试连接确认」；**全程零生成请求**（pytest 有断言） |
| 3. 网址 / 路径自动补全 | ✅ | `server/url_normalize.py` + `POST /api/providers/normalize-url`（纯函数）：去空白、补 https://、完整地址拆 Base URL + 路径（chat/completions、responses、v1/messages、v1/models、:generateContent）、/v1/v1 与 // 去重、只填域名时依次试 `{base}/v1/models` 与 `{base}/models` 并改写 Base URL；输入框下小字「已自动改为 …」；用户手改的路径以用户为准 |
| 4. 测试连接 = 一条真实最小生成请求 | ✅ | `POST /api/providers/{id}/test` 改为单条 user "hi"、max_tokens ≤ 16、stream 验证；点前提示「会发一条测试消息，按次计费的接口可能扣一次费」，可勾选「同时检测思考档位（会额外产生几次请求费用）」；结果缓存到 `provider.advanced.testResult` 并显示测试时间 |
| 5. 中转转发方式 `forwardMode` | ✅（见风险 1） | 高级设置新增 `auto / openai_compat_translate / openai_compat_passthrough / native_anthropic / native_gemini / model_suffix`；后端 `protocol_of` / 思考参数构建认这个字段；model_suffix 在请求层把档位换成对应模型 ID（如 `-thinking`） |
| 6. 400 兜底 + 本档位标记「这家不支持」 | ✅ | server 原有「去思考参数 + 采样参数重试」保留；前端收到 `fallbackRemoved` 后把「模型+档位」记进 `provider.advanced.unsupportedReasoning`，以后 `buildReasoningParams()` 对该组合降为 `auto` 并不再发送，回复下方小字说明 |
| 7. 失败只给中文白话 + 下一步 | ✅ | 归一化错误 / 连不上 / Key / 余额 / 不支持 均为中文一句话；测试断言响应里没有 Traceback 或英文原始报错 |
| 8. 「拉取模型」按钮保留在模型页 | ✅ | `拉取模型` 仍在模型页，走原 `/pull-models`，可手动刷新 |
| 9. 测试 | ✅ | `server/tests/test_save_connect.py` **34 条**：URL 规则逐条（12 条参数化）、保存流程零生成请求（记录所有 httpx 请求 + 生成函数被调用即 fail）、模型列表不可用仍保存、测试连接默认只发 1 条生成请求（1 POST）、勾选档位时 = 1+档位数、家族/图标/已知价格/档位预设、model_suffix 换模型 ID |

### 2.2 新增后端接口

- `POST /api/providers/normalize-url`
- `POST /api/providers/{id}/save-connect`
- 改造 `POST /api/providers/{id}/test`（body：`modelId / checkStream / checkReasoning`）

### 2.3 前端

`src/modules/providers-block1.js` + `src/features/providers-block1.css`：Base URL 失焦自动补全与逐条提示、保存后自动连通结果面板（含自动修正、识别模型 chips、探测地址）、保存失败 fallback 提示、测试连接费用提示 + 档位勾选 + 结果/缓存时间、400 兜底标记与降级、高级设置转发方式下拉。新 UI 全部复用现有 glass token。

## 3. 第二块 · 网易云封面加载——已全部完成

| 需求 | 状态 | 实现要点 |
|---|---|---|
| 正式版手机直连网易云 | ✅ | 正常 http(s) 访问时仍由手机直连 `p1–p4.music.126.net`；同时**修了后端 CSP**：`img-src` 放行四个网易云图片域名（之前 http 模式会拦截外部封面，属于本轮顺带修的真实 bug） |
| 失败依次换 p1/p2/p3/p4 重试 | ✅ | `src/modules/covers-block2.js`：`data-cover-base` + 尝试序号，逐次换域名重试 4 次，全部失败才退回主题色素面唱片（`.is-missing`），不出现破图标 |
| `--inline-covers` 构建选项 | ✅ | `scripts/inline-covers.mjs`：从 `src/data.js` 解析全部内置歌曲封面 → 下载 → ffmpeg 压成 300px JPEG（q≈5，缓存于 `assets/covers-300/`）→ data URI 注入 `INLINE_COVER_MAP`；`node scripts/build.mjs --inline-covers` 输出 **9/9 张（127.3 KB）**；网络失败会明确 warning 并统计，一张都没成功则构建失败 |
| headless chromium 拦截验证 | ✅ | `scripts/phase-d2-covers-check.mjs`：`--host-resolver-rules="MAP *.126.net 127.0.0.1"` + 静态服务 inline 版 dist，打开「一起听」，断言 7 张封面 `naturalWidth>0`、全部为 data URI、无 `.is-missing`；输出 `shots/phase-d2/covers-inline-blocked-{pink,ice}.png` 与 JSON 结论 |
| 离线演示回复的演示思维链 | ✅ | `localFakeReply`：当前思考档位非「关闭」时，回复带可折叠「演示 · 想了 N 秒」思维链（正文明确写「这不是真实模型的思维链」），档位关闭时没有；截图见 `{pink,ice}-offline-demo-cot.png` |

## 4. 第三块 · 聊天记录管理与绑定——已全部完成

### 4.1 后端（新增 /api/chats 接口，旧接口兼容）

`server/routers/chats.py`、`server/db.py`（schema v3）、`server/prompts.py`、`server/schemas.py`：

- 列表 `GET /api/chats?characterId=&q=`（标题 + 最后一句预览 + 时间 + 条数 + 置顶 + 绑定，pinned/last_at 排序）
- 新建 `POST /api/chats`（默认标题 `角色名 - YYYY-MM-DD HH:mm`，写入开场白）、按 id `GET/PATCH/DELETE /api/chats/id/{chat_id}`
- 分支 `POST /api/chats/id/{chat_id}/branch`（复制到指定消息为止 + 绑定全复制 + 标题加「· 分支」）
- 搜索 `GET /api/chats/search?q=&characterId=`（消息内容命中带 messageId 可跳转；标题命中 messageId=null）
- 批量删除 / 批量导出 `POST /api/chats/bulk-delete`、`POST /api/chats/bulk-export`；单聊导出 `GET /api/chats/id/{chat_id}/export`（含 character 与 bindings）
- 导入 `POST /api/chats/import`：本项目 JSON（单个/批量）+ SillyTavern 聊天 jsonl（按 `character_name` 自动匹配角色，匹配不到用指定角色，自动识别单行 JSON / 多行 JSONL）
- 消息编辑/删除 `PATCH/DELETE /api/chats/id/{chat_id}/messages/{message_id}`（标记 edited）
- AI 起名 `POST /api/chats/id/{chat_id}/auto-title`（默认关闭；用户改过标题 `titleLocked` 后 AI 不再覆盖）
- AI 帮答 `POST /api/chats/{character_id}/impersonate`（生成用户口吻候选，**不落库**，确认后才发）
- 发送扩展：`ChatSendIn.chatId` + `mode = normal|continue|regenerate`（regenerate 先删最后一条 AI 再写，continue 不写 user 消息；SSE 形状不变，done 带 chatId）
- 作者注释：`chat.settings.authorNote = {text, depth}` 按深度作为 system 块插进聊天记录（只对这段对话生效）
- 绑定：`prompts.resolve_persona` 三层（聊天 > 角色 > 全局）与世界书三层（全局 + 角色 + 聊天）均可用新接口读写；`db.get_state` 每个角色返回 active chat（pinned/last_at）且含 id；`db.sync_state` 认 `chat.id` 按 id 更新（修了多对话时整体同步写错对话的隐患）
- 迁移：`SCHEMA_VERSION = 3`，messages 新增 `edited`（幂等迁移），旧库可直接升级；`test_migrate.py` 新增 v2→v3 升级 + 幂等 + 数据不丢的测试
- 旧接口保持兼容：`/ensure`、`GET/PATCH/DELETE /api/chats/{character_id}`、`GET /api/characters/{id}/chats`（升级为返回全部对话摘要）均保留

**测试**：`server/tests/test_chat_history.py` **21 条**——列表过滤/排序置顶、新建默认标题、改名（上锁）、置顶、删除级联、分支复制前缀与绑定、搜索消息命中/标题命中、消息编辑（edited）与删除、export/import JSON 往返、ST jsonl 导入（显式/自动识别/按名字匹配）、auto-title mock 且锁定后不覆盖、impersonate 不落库、续写不写 user 消息、重新生成替换最后一条 AI、authorNote 进 prompt-preview、人设三层优先级（chat > char > default）、sync_state 按 chat.id、旧 /ensure 兼容、schema v3 列断言。

### 4.2 前端

两个模块 + 两个 feature CSS（构建时注入 app.js 同作用域，避免改乱 7000 行主脚本）：

- `src/modules/chat-history.js`：**D2ChatStore 数据层**（在线走 /api/chats，离线 file:// 用 `state.d2LocalChats` 本地实现，均可用）+ 本角色对话列表（标题/预览/今天几点或更早日期/条数/置顶小珍珠/新对话/切换/改名（含 AI 起名按钮+费用提示）/置顶/导出/删除二次确认）+「我的」页「最近的聊天」总入口（全角色混排、角色筛选、消息内容搜索并跳转高亮、多选批量删除/导出）+ 人设三层绑定 sheet（默认/角色/这段聊天 + 来源、两个开关）+ 设置页三个开关（切换人设时提示 / 自动绑定人设到当前聊天 / AI 帮起标题）+ 对话列表角色卡入口。
- `src/modules/chat-actions.js`：聊天页玻璃**收纳菜单**（开始新聊天 / 管理聊天文件 / 保存检查点 / 删除消息多选 / 重新生成 / 续写 / AI 帮答确认后发送 / 作者注释 text+depth / 本聊天世界书 / 记录导出，另保留提示词预览等旧入口）+ **单条消息操作**（编辑 / 删除 / 复制 / 重新生成 / 从这里分支）+ 检查点列表（回到这里另开 / 删除）+ 多选底栏批量删除。
- 切换对话会自动恢复这段对话记住的**用户人设 / 世界书 / 预设 / 模型 / 思考档位**（模型恢复本轮补上，发送时优先用本段 chat 的模型）。

### 4.3 截图覆盖

两主题下的：对话列表、最近的聊天总入口、搜索、改名、人设三层绑定、聊天页菜单、单条消息操作、分支对话、设置开关、离线演示思维链。

## 5. 构建与交付

```
$ .venv/bin/python -m pytest -q
143 passed

$ node scripts/build.mjs
dist/index.html 已生成
  壁纸：18 张，1448.0 KB base64
  CSS：190.4 KB · 数据：30.8 KB · 脚本：431.4 KB
  模块：chat-actions.js, chat-history.js, covers-block2.js, providers-block1.js
  单文件合计：2202.0 KB

$ node scripts/build.mjs --inline-covers
dist/index.html 已生成（--inline-covers）
  内联封面：9/9 张（127.3 KB data URI）
  单文件合计：2329.9 KB

$ node scripts/phase-d2-covers-check.mjs
✅ 拦截 126.net 后封面仍全部显示
```

**交付文件**：`dist/index.html`（当前为 `--inline-covers` 版本，单文件 2,428,312 B）。交付样稿里 9 张内置歌曲封面是 data URI，被手机拦截外链时也能显示；普通构建（不带参数）则保留手机直连网易云 + p1–p4 重试逻辑。

## 6. 截图清单（`shots/phase-d2/`，pink / ice 各一套，共 32 张）

| 文件名（两主题各一张） | 内容 |
|---|---|
| `{theme}-provider-autofill.png` | 提供商详情页：Base URL 粘贴完整地址后自动拆成 Base URL，输入框下「已自动改为 …」 |
| `{theme}-provider-connected.png` | 点保存后自动连通：弹层「已连接，识别到 N 个模型」+ 自动修正 + 识别模型 + 探测地址（N=2） |
| `{theme}-provider-test-cost.png` | 测试连接弹层：按次计费费用提示 + 「同时检测思考档位」费用提示 |
| `{theme}-provider-test-result.png` | 一条最小真实请求的测试结果（模型 / 支持流式 / 耗时 / 测试时间） |
| `{theme}-chat-list.png` | 本角色的对话列表（标题、最后一句预览、时间、条数、置顶小珍珠） |
| `{theme}-chat-rename.png` | 改名弹层（含「帮我起个名」+ 计费提示） |
| `{theme}-message-actions.png` | 单条消息操作（编辑 / 复制 / 重新生成 / 从这里分支 / 删除） |
| `{theme}-persona-layers.png` | 人设三层绑定（默认 / 角色 / 这段聊天 + 优先级 + 两个开关） |
| `{theme}-chat-menu.png` | 聊天页玻璃收纳菜单（10 项 + 更多） |
| `{theme}-branch.png` | 分支结果：从一条消息另开的新对话出现在列表里（「· 分支」高亮为当前） |
| `{theme}-recent-entry.png` | 「我的」页「最近的聊天」总入口（段数 / 今日段数） |
| `{theme}-recent-chats.png` | 最近的聊天：全角色混排 + 角色筛选 chip + 置顶 + 分支 |
| `{theme}-chat-search.png` | 搜索消息内容，结果带上下文片段（点结果跳到对应位置） |
| `{theme}-settings-chat.png` | 设置页聊天记录三个开关 |
| `{theme}-offline-demo-cot.png` | 离线演示回复的「演示 · 想了 N 秒」可折叠思维链 + 离线说明 |
| `covers-inline-blocked-{pink,ice}.png` | `--inline-covers` 样稿在 headless Chrome 拦截 `*.126.net` 后，一起听页封面仍显示 |

## 7. 未完成 / 风险 / 说明（如实）

1. **没有对真实提供商联调**：环境没有可用 API Key / 不允许真实计费请求。save-connect 的网址探测、模型列表识别、家族/价格/档位、零生成请求、测试连接只发一条生成请求，都是用 mock 的 httpx 断言验证的；`MSYQ_MOCK=1` 截图里的模型列表是演示数据，不算真实拉取。
2. **model_suffix 的「切档位 = 换模型 ID」在请求层生效**（后端把 model 换成 `-thinking` 变体），模型选择器界面不会把 ID 文本改写成后缀；高级设置里有说明。
3. **单条消息「重新生成」只支持最后一条 AI 回复**；更早的消息给出「从这里分支」作为替代（没有做任意历史消息的原地重生成接口）。
4. **AI 起名默认关闭**：设置开关只保存偏好；新建对话不会自动调用模型起名，只在「改名」弹层手动点「帮我起个名」（按次计费提示已给）。这是按需求「默认关闭」的实现方式。
5. **导入导出**：JSON / SillyTavern jsonl 导入已用 headless 真实文件输入做过 e2e；导出走后端接口与浏览器下载，后端往返测试通过，但「下载文件落盘」没有在 headless 里逐张验证；「最近的聊天」批量删除/批量导出的 UI 路径已实现且后端有测试，未逐项截图。
6. **离线模式的完整多对话**：`file://` 用本地 `state.d2LocalChats` 兜底（列表/新建/切换/改名/置顶/删除/分支/搜索/导出可用，导入仅支持本项目 JSON）；离线下的 AI 起名、AI 帮答会提示需要正式版后端。交付样稿主要面向 `--inline-covers` 单文件演示，正式使用走 http(s) + 后端。
7. **余额显示**：真实模式能查才显示（查不到不报错）；mock 模式主动不查余额，避免把演示数字当真实余额。
8. **截图后端为 `MSYQ_MOCK=1`**：截图的聊天回复、模型列表、余额都来自本机演示模式，用于展示界面状态，不是真实上游数据。
9. **CSP 调整**：为了正式版手机直连网易云封面，后端 CSP 的 `img-src` 放行了 `p1–p4.music.126.net`（第 D2 轮修复；之前 http 模式下封面会被 CSP 拦截）。
10. **`assets/covers-300/`**：`--inline-covers` 的 300px JPEG 缓存（9 张，116 KB），让交付构建断网也能复现；要强制重新下载可加 `--refresh-covers`。
11. **team 未参与**：本环境 teammate 启动接口报错（`startContinuable is not a function`），三块由 Lead 单人完成；`PHASE_D2_CONTRACT.md` 保留为接口说明文档。

## 8. 本轮新增 / 修改文件

**新增**
- `server/url_normalize.py`（网址补全纯函数）
- `server/model_family.py`（模型家族 / 图标 / 能力 / 档位预设）
- `server/tests/test_save_connect.py`（34 条）
- `server/tests/test_chat_history.py`（21 条）
- `src/modules/providers-block1.js`、`src/features/providers-block1.css`
- `src/modules/covers-block2.js`
- `src/modules/chat-history.js`、`src/modules/chat-actions.js`、`src/features/chat-history.css`
- `scripts/inline-covers.mjs`、`scripts/phase-d2-covers-check.mjs`、`scripts/phase-d2-shots.mjs`、`scripts/d2-cdp.mjs`
- `assets/covers-300/`（9 张 300px JPEG 缓存）
- `PHASE_D2_CONTRACT.md`、`PHASE_D2_CHECK.md`（本文件）

**修改**
- `server/providers.py`（转发方式、模型探测、最小生成测试）
- `server/routers/providers.py`（normalize-url / save-connect / test 改造）
- `server/db.py`（schema v3、对话摘要/搜索/分支/消息编辑删除、sync_state 按 chat.id、get_state 多对话）
- `server/routers/chats.py`（全部新接口、mode/chatId、impersonate、auto-title）
- `server/routers/characters.py`（角色对话列表返回全部摘要）
- `server/schemas.py`、`server/prompts.py`（新入参与作者注释）
- `server/app.py`（CSP 放行网易云图片域名）
- `server/tests/test_migrate.py`（schema v3 相关，原有断言保留）
- `src/app.js`（模块注入点、封面重试、演示思维链、提供商保存/测试入口、聊天菜单/消息操作/多对话接线、chatId+mode、sync chats 带 id、删除消息编辑标记、设置/我的 hook）
- `scripts/build.mjs`（`src/features/*.css`、`src/modules/*.js` 注入、`--inline-covers`）
