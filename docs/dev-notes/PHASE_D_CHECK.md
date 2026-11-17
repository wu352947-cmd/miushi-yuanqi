# PHASE D CHECK · 第 D 轮（思考档位 / 预置模型 / 价格 / 用量）

> 本轮按「先做第一块、跑通测试与构建，再做下一块」推进。**第一块已实现并通过测试与构建；第二、三、四块本轮未实现**（原因见文末），因此本文件是**阶段性交付**，不是全部四块的完成声明。没有部署、没有 SSH、没有输出任何 key，没有运行 `scripts/shoot.mjs`。

## 一、已完成：第一块 · 思考档位 / 预置模型 / 价格 / 用量

### 1. 档位体系（前后端同一套）
- 档位扩为 `off / auto / low / medium / high / xhigh / max`，每个模型的 `reasoning.levels` 决定实际可用档位；`auto` = 不带任何思考深度参数。
- `server/reasoning.py` 重写为 16 种 mode：`deepseek / openai_effort / anthropic_effort / anthropic_budget / gemini_level / gemini_budget / openrouter / xai / qwen_thinking / kimi / zhipu / ark / siliconflow_thinking / relay_suffix / none`。
- 关键映射（均有单元测试）：
  - DeepSeek：`thinking.type` + `reasoning_effort`；开启思考时不发 `temperature / presence_penalty / frequency_penalty`；官方 `medium / xhigh` 收敛为 `high`。
  - OpenAI：Chat 用 `reasoning_effort` + `max_completion_tokens`；Responses 用 `{"reasoning":{"effort":…,"summary":"auto"}}`；`gpt-5` 的 off 映射 `minimal`；`gpt-6-astra` 不提供 off，也绝不发 `none`。
  - Anthropic 5.x：`output_config.effort` + `thinking.adaptive display=summarized`；关闭按模型分 `disabled / between_tools / 不提供 off`；一律不发 `temperature / top_p / top_k`；`xhigh / max` 时 `max_tokens` 提到 ≥64000。`anthropic_budget` 只保留给 4.5 及更早。
  - Gemini：3+/4 用 `thinkingLevel`（绝不与 `thinkingBudget` 同发、不发温度类字段）；2.5 用 `thinkingBudget`，2.5 Pro 不提供 off。
  - OpenRouter：按 `supportedEfforts / mandatory` 生成档位，`off` 只在支持 `none` 且非 mandatory 时发，`auto` 不发 `reasoning`。
  - xAI / 通义 / Kimi / 智谱 / 豆包 / 硅基流动：按需求逐条实现（grok 不发 penalty/stop；Kimi 不发温度类；豆包 max→high；硅基 DeepSeek-V4 / GLM-5.2 走 effort，其余走 `thinking_budget` 等）。
- `server/providers.py`：修复 `protocol_of()` —— `advanced.responseApi=true` 时真正返回 `openai_responses`（之前完全没读这个开关）；`build_request` 会按 mode 删掉不该发的采样字段，并处理 Anthropic `max_tokens` 下限、OpenAI `max_completion_tokens`、Gemini 不能同时发 budget+level、history 不能以 model 结尾。
- `server/errors.py`：400 兜底识别「思考参数 / 温度 / penalty / 不支持参数」；第二次重试同时去掉思考参数与 `temperature / top_p / top_k / presence_penalty / frequency_penalty`，`fallback` 里写明去掉了哪个参数（`fallbackRemoved` 一并回给前端）。
- 前端 `src/app.js` 的 `REASON_TEXT / REASON_MODES / buildReasoningParams / defaultReasoningFor / PULL_DEMO / LEVEL_PRESETS` 全部同步为同一套映射（`buildReasoningParams` 是 server 逻辑的 1:1 移植）。

### 2. 用量解析（server/providers.py、usage.py、routers/chats.py）
- 统一 usage 结构新增 `reasoning_tokens / cache_write_tokens`；DB 迁移到 **schema v2**（`ALTER TABLE usage` 加两列；同时为第四块的多对话去掉了 chats 的角色唯一索引）。
- OpenAI Chat / DeepSeek / Qwen / Kimi / GLM / 硅基：`prompt_tokens`、`prompt_tokens_details.cached_tokens`（或 `prompt_cache_hit_tokens`）、`completion_tokens`、`completion_tokens_details.reasoning_tokens`。
- OpenAI Responses：新增 `_norm_responses_usage`（`input_tokens / input_tokens_details.cached_tokens / output_tokens / output_tokens_details.reasoning_tokens`），stream 与 complete 都改用它（修了「读 prompt_tokens 全是 0」的 bug）。
- Anthropic：`prompt = input + cache_read + cache_creation`、`cache_write_tokens` 单列；流式 `message_start` 与 `message_delta` 的 usage **逐字段取最大**（chats.py 不再后覆盖前）。
- Gemini：`output = candidates + thoughts`，另存 `reasoning_tokens`；非流式拼正文时跳过 `thought` 部分。
- `usage.py`：新增峰谷计费（DeepSeek 周一至周五 9–12、14–18 为 peak；`price.peak / price.offpeak`），缓存写入按 `cacheWrite` 或 1.25×输入价计；统计 `overview` 输出 `reasoning / cacheWrite`。节假日表本轮未做（代码注释注明）。
- 思考内容显示：Responses `summary:"auto"`、Anthropic `display:"summarized"`、Gemini `includeThoughts:true`、OpenRouter `reasoning_details`、DeepSeek/Qwen/Kimi/GLM/硅基读 `reasoning_content`（流式解析已补）。

### 3. 预置模型与价格（seed_data.json、src/data.js）
- DeepSeek：`deepseek-flash`（V4.1 Flash，1,048,576，峰值 ¥2/0.04/8、空闲 ¥1/0.02/4）与 `deepseek-v4-pro`（峰值 ¥9/0.30/27、空闲 ¥4.5/0.15/13.5）；删除 `deepseek-chat`。
- Anthropic：`claude-sonnet-5-5`（1,000,000，$2/0.10/10，默认 high）与 `claude-haiku-5-5`（$0.10/0.01/0.50，默认 medium）；删除 `claude-sonnet-4-5` 与 PULL_DEMO 里的 `claude-opus-4-1`。
- OpenAI：`gpt-6.1-sol`（$2/0.10/10）、`gpt-6-luna`（$0.10/0.01/0.50）、`gpt-6-astra`、`gpt-6.1-terra`；删除 gpt-5 / o4-mini / gpt-5-mini。
- Gemini：`gemini-3.8-flash`（$0.75/0.075/3.75，价格结构带 `next.effectiveFrom=2027-01-01`）、`gemini-4-argon`（$2/0.10/10，`next.effectiveFrom=2026-12-01`）、`gemini-3.5-flash-lite`（$0.30/0.03/2.50）。
- OpenRouter：`openrouter/auto` → mode none、price null；`moonshotai/kimi-k3` 的价格不写死（`price:null`，运行时取 /models）。
- 硅基流动：`Qwen/Qwen3-235B-A22B` 改 `siliconflow_thinking`（默认开思考、returnThinking=true）；`Qwen/Qwen2.5-7B-Instruct` 本轮未核实是否仍上架，**已从预置里删除**（文档记录原因）。
- 所有未核实价格一律 `price:null`；前端显示「价格待确认」。

### 4. 测试（本轮重点）
- `server/tests/test_reasoning.py` 重写为 **46 条**参数化断言：每个 mode × 每个档位一条，逐条断言请求体，并断言「不该出现的字段」——`budget_tokens` 不再出现在 Anthropic 5.x、Gemini 不同时出现 `thinkingBudget + thinkingLevel`、gpt-6-astra 不发 `none`、grok 不发 penalty、Claude 5.x 不发 `temperature`、gpt-5 的 off 发 `minimal` 等。
- 另断言 4 家 usage 归一化（OpenAI / Responses / Anthropic 缓存拆分 / Gemini thoughts）。
- 全量 `pytest`：**87 passed**（含新增 46 条；旧 usage 测试同步到新模型 id 后通过）。
- `node scripts/build.mjs`：通过，`dist/index.html` 约 2.04 MiB（18 张壁纸，含本轮 wp18）。

## 二、已完成：粉色主题换壁纸（wp18）
- `assets/wallpapers-720/wp18.jpg` 已登记进 `src/data.js` 壁纸列表（名称「浅粉拼贴 · 凯蒂猫」），粉色主题首页默认改为 `wp18`（替换 C2 的 wp05）。
- 没有自绘 / 生成 / 改色；`scripts/build.mjs` 的壁纸数量校验改为 18，构建已通过。
- 粉色正文从 `#5A4550` 再压深到 `#4E3B45`，保留柔光，不靠加厚白雾；玻璃参数保持 C2 不变。
- **未完成**：pink-home 与参考图的并排截图、透过卡片的物件逐条记录（本轮没有产出 `shots/phase-d/` 截图，原因见文末）。

## 三、本轮未完成的部分（如实说明）
1. **第二块 · 保存 / 测试连接流程**：URL 自动补全、保存时「零生成请求」的自动识别、测试连接发一条最小生成请求、转发方式切换等**均未实现**。后端 `test_connection` 仍是旧的「GET /models」逻辑；前端保存按钮仍是旧流程。对应 pytest（零生成请求断言）也没有写。
2. **第三块 · 网易云封面加载**：`p1→p4` 域名轮换重试、`build.mjs --inline-covers` 都**未实现**；封面仍是 C1/C2 的单域名 + 一次重试。
3. **第四块 · 聊天记录管理与绑定 / 聊天页菜单**：对话列表、总入口、搜索、改名、置顶、分支、消息编辑删除、导入导出、菜单与三层人设绑定未实现。数据库只做了「为后续多对话解除 chats 角色唯一索引 + 加 pinned/settings_json 列」的 v2 迁移，没有对应的 CRUD 接口与界面。
4. **截图与 `shots/phase-d/`**：本轮没有产出任何截图（上述依赖的功能未完成，且时间预算不足）。

原因：本轮把预算集中在第一块——它包含 16 种思考 mode、4 家 usage 归一化、峰谷计费与 46 条请求体断言，是四块里测试量最大、最容易出隐性错误的一块；完成第一块后已没有足够时间对第二～四块做「实现 + 测试 + 双主题截图」的完整闭环。没有用占位实现伪装完成。

## 四、风险与下一步建议
- 第一块的映射虽然与需求逐条对齐并有请求体断言，但没有对每家真实接口做联调；上线前建议按 mode 各挑一家做真实 400 / 200 验证。
- `price.next.effectiveFrom` 字段已写入数据，但 `usage.py` 目前只按峰谷选价，**尚未按生效日期自动切价**（下一步补）。
- 下一步优先做第二块（保存流程 + 零生成请求断言），因为它决定「保存后能不能直接用」；第三块改动小、可穿插；第四块工作量最大，建议单独一轮。
