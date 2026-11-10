# 缪诗鸳杞 · 第 D 轮任务（思考档位 / 预置模型 / 中转站连接 / 封面加载 / 聊天记录管理）
项目目录 /workspace/miushi-yuanqi。分四块按顺序做，每块做完跑 pytest 和构建，再做下一块；全部完成后写 PHASE_D_CHECK.md，截图放 shots/phase-d/。

## 通用规则
- 不要部署，不要 SSH，任何 key 不得出现在代码、README、截图、日志或输出里。
- 不要运行 scripts/shoot.mjs（会清空 shots/）。截图用自己的脚本，只写到 shots/phase-d/。
- 玻璃风格、底栏（66px，爱心不跳不凸）、「此刻」编辑布局都不准回退；新界面用现有的 glass token，两个主题都要截图。
- 不准用代码画壁纸。
- SillyTavern 是 AGPL：只学机制，不抄代码和界面。
- 不准编造模型 ID、价格和链接；没核实的写「待确认」。
- 前端改 src/，用 node scripts/build.mjs 生成 dist/index.html；后端在 server/，旧接口保持兼容，数据库变更要写迁移。

---

## 第一块：思考档位、预置模型、价格、用量（依据 2026-11-11 官方文档）

【任务】按 2026-11-11 各家官方文档修正「思考档位」映射、预置模型、价格和用量解析。只改下列文件：
server/reasoning.py、server/providers.py、server/seed_data.json、server/usage.py、server/routers/chats.py（仅 usage 合并）、
src/app.js（buildReasoningParams / REASON_MODES / defaultReasoningFor / PULL_DEMO / 档位文案）、src/data.js、PROVIDERS_DESIGN.md、PHASE_A2_CHECK.md。
前后端 buildReasoningParams 必须保持同一套映射，补测试。不要编造模型 ID、价格；下文给的都是官方页面 2026-11-11 读到的值，链接附在最后。

一、档位体系
1. UI 档位扩成：关闭 off / 自动 auto / 低 low / 中 medium / 高 high / 很高 xhigh / 最高 max。
   每个模型只显示它真正支持的档位；不支持关闭的模型不显示「关闭」，并在灯泡说明里写「这个模型思考一直开着，只能调深浅」。
   「自动」= 请求里不带任何思考深度参数，交给模型默认值（并在说明里写出该模型默认是哪档）。
2. 删掉「DeepSeek 只有开/关」「不假装有低中高」等所有文案（data.js、seed_data.json、app.js 4753-4755、PROVIDERS_DESIGN.md 238/253、PHASE_A2_CHECK.md 27）。

二、buildReasoningParams 新映射（前后端一致）
A. deepseek（官方 api.deepseek.com，OpenAI 格式）
   levels: off / low / high / max，默认 high。（官方 medium、xhigh 会被映射成 high，不要单独做「中」）
   off  → {"thinking":{"type":"disabled"}}
   low/high/max → {"thinking":{"type":"enabled"},"reasoning_effort":"<lv>"}
   思考开启时从请求体删掉 temperature / presence_penalty / frequency_penalty（官方说无效），UI 灰掉这几项。
B. openai_effort（OpenAI 官方 Chat 与 Responses）
   Chat：{"reasoning_effort": eff}；Responses：{"reasoning":{"effort": eff, "summary":"auto"}}；auto → 不发 effort（Responses 仍可发 summary:"auto"）。
   每模型 levels：
     gpt-6-astra: low medium high xhigh max（无 off）
     gpt-6.1-sol: low medium high xhigh max（无 off，默认 medium）
     gpt-6.1-terra / gpt-6-luna: off(=none) low medium high xhigh max（默认 medium）
     gpt-5（若保留）: off 映射到 "minimal"（gpt-5 不支持 none，发 none 会 400），low medium high
   Chat Completions 改用 max_completion_tokens，不再发 max_tokens。
   修 bug：protocol_of() 里 protocol=="openai" 且 advanced.responseApi==true 时返回 "openai_responses"（目前后端完全没读 responseApi）。
C. anthropic_effort（新增，替换 anthropic_budget 用于 4.6 及以后、全部 5.x）
   auto → 不发 output_config；low/medium/high/xhigh/max → {"output_config":{"effort":lv}}
   off：claude-haiku-5-5、claude-opus-5、claude-sonnet-5 → {"thinking":{"type":"disabled"}}（只允许 effort≤high）
        claude-sonnet-5-5 → {"thinking":{"type":"between_tools"}}（只允许 effort≤high；它拒绝 disabled）
        claude-opus-5-5、claude-fable-5-x → 不提供 off
   需要显示思考时：{"thinking":{"type":"adaptive","display":"summarized"}}（与 off 互斥；5.x 默认 display=omitted，不加就没有思考文字）。
   不要再发 {"type":"enabled","budget_tokens":...}：Opus 4.7 及之后所有模型都会 400。anthropic_budget 只留给 4.5 及更早（建议不再预置）。
   对 Opus 4.7+/Sonnet 5+/Haiku 5.5/Fable/Mythos：请求体一律不带 temperature / top_p / top_k（非默认值必 400）。
   xhigh/max 时把 max_tokens 至少提到 64000（不超过 128000）。
D. gemini_level（新增，Gemini 3.x / 4.x）与 gemini_budget（只给 2.5）
   gemini_level：auto → 不发 thinkingConfig.thinkingLevel；low/medium/high → {"generationConfig":{"thinkingConfig":{"thinkingLevel":lv,"includeThoughts":true}}}
     off → 仅 gemini-3.6-flash / gemini-3.5-flash-lite 等支持 minimal 的模型映射为 "minimal"（文案写「几乎不思考」）；gemini-4-*、gemini-3.8-flash 不提供 off（minimal 会报错）。
     绝不同时发 thinkingBudget 和 thinkingLevel（Gemini 4 上一起发 = 400）。
   gemini_budget（仅 2.5）：auto=-1；off=0（2.5 Pro 不能 0，Pro 不提供 off）；low/medium/high = 1024/8192/24576（Pro 范围 128–32768，Flash 0–24576，Flash-Lite 512–24576）。删掉「max → thinkingLevel」分支（2.5 不认 thinkingLevel）。
   Gemini 3+ 请求不带 temperature/topP/topK；history 不能以 model 角色结尾（会 400）。
   complete()（非流式）拼正文时跳过 part.thought==true 的部分。
E. openrouter
   levels 由 GET /api/v1/models 的 reasoning 字段生成：supported_efforts（降序）、default_effort、mandatory、supports_max_tokens。
   off → 仅当 supported_efforts 含 "none" 且 mandatory!=true，发 {"reasoning":{"effort":"none"}}
   auto → 不发 reasoning（注意：{"enabled":true} 官方定义是 medium，不是自动）
   low/medium/high/xhigh/max → {"reasoning":{"effort":lv}}；模型没有 max 时退到 xhigh→high
   reasoning 字段为 null/缺失的模型（含 openrouter/auto、moonshotai/kimi-k2）→ mode none。
F. 新增国产 / 其他提供商模板与 mode（都是 OpenAI 兼容 /chat/completions）
   xai（https://api.x.ai/v1）：grok-4.7 / grok-4.6 levels = auto low medium high xhigh（默认 high，不能关）；grok-4.5 无 xhigh。
     发 {"reasoning_effort":lv}；grok 推理模型上禁止发 presence_penalty / frequency_penalty / stop（会报错）。
   qwen_thinking（百炼 https://dashscope.aliyuncs.com/compatible-mode/v1）：off → {"enable_thinking":false}；auto → 不发；
     qwen3.8-max：low/medium/xhigh → {"enable_thinking":true,"reasoning_effort":lv}（不要同时发 thinking_budget，会报错）；
     其他混合思考模型：low/medium/high → {"enable_thinking":true,"thinking_budget":2048/8192/32768}。
   kimi（https://api.moonshot.cn/v1）：kimi-k3 / kimi-k3.1-pro levels = auto low high max（默认 max，不能关），发 {"reasoning_effort":lv}，不发 thinking；
     temperature/top_p/presence/frequency 一律不发（固定值，传了报错）；多轮必须把上一轮 assistant 的 reasoning_content 原样回传。
     kimi-k2.6：off → {"thinking":{"type":"disabled"}}，on → enabled（K2 系 12 月底下线，不要预置）。
   zhipu（https://open.bigmodel.cn/api/paas/v4）：glm-5.3 / -flash / -flashx levels = low high max（默认 max，不能关），发 {"thinking":{"type":"enabled"},"reasoning_effort":lv}；
     glm-5.2：off → {"thinking":{"type":"disabled"}}，high/max → reasoning_effort。
   ark 豆包（https://ark.cn-beijing.volces.com/api/v3）：off → {"thinking":{"type":"disabled"}}；auto → 不发；low/medium/high → {"reasoning_effort":lv}；max 等同 high（Seed 2.1 上 xhigh/max 映射为 high）。
     Seed 2.1/evolving 只回思考摘要 + encrypted_content，需原样回传。
   siliconflow：off → {"enable_thinking":false}；auto → 不发；low/medium/high → {"enable_thinking":true,"thinking_budget":2048/8192/32768}（范围 128–32768）；
     DeepSeek-V4 / DeepSeek-V4-Flash / GLM-5.2 用 {"reasoning_effort":"high"|"max"}。注意硅基的 max_tokens 不含思维链。
G. defaultReasoningFor（app.js 4745-4760）：按上面规则识别 deepseek-flash / deepseek-v4 / gpt-6 / claude-*-5 / gemini-3|4 / grok / kimi-k3 / glm-5 / qwen3 / doubao-seed；
   识别不了的未知模型默认 mode=none 或只给 auto（不发参数），不要默认发 reasoning_effort=none。
H. 400 兜底（errors.py）：第二次重试时同时去掉 temperature/top_p/top_k/presence_penalty/frequency_penalty，并在 note 里写明去掉了哪个参数。

三、预置模型与价格（seed_data.json、data.js、providers.py MOCK_PULL、app.js PULL_DEMO 同步改）
- DeepSeek：删 deepseek-chat（2026-07-24 已停用）。新增
  deepseek-flash：name "DeepSeek V4.1 Flash"，context 1048576，vision true，
    price 改为峰谷结构：{currency:"¥", peak:{input:2, cache:0.04, output:8}, offpeak:{input:1, cache:0.02, output:4}}
  deepseek-v4-pro：name "DeepSeek V4 Pro"，context 1048576，vision false，
    price {currency:"¥", peak:{input:9, cache:0.30, output:27}, offpeak:{input:4.5, cache:0.15, output:13.5}}
  高峰时段 = 北京时间周一至周五 9:00-12:00、14:00-18:00（法定节假日全天空闲）；usage.py 计费按请求时间选 peak/offpeak（节假日表可先不做，UI 注明）。
- Anthropic：claude-sonnet-4-5（11-30 退役）换成 claude-sonnet-5-5（context 1000000，$2 / cache read $0.10 / output $10，默认 effort high），
  可加 claude-haiku-5-5（≤100K 提示 $0.10/$0.01/$0.50；>100K $0.50/$0.05/$2.50，默认 medium）。PULL_DEMO 删 claude-opus-4-1（已退役）。
- OpenAI：gpt-5（12-11 下线）换成 gpt-6.1-sol（1050000，$2/$0.10/$10）与 gpt-6-luna（1050000，$0.10/$0.01/$0.50）；PULL_DEMO 删 o4-mini（已下线）、gpt-5-mini。
  价格注明 >272K 输入：输入/缓存 ×2、输出 ×1.5。
- Gemini：gemini-2.5-pro / gemini-2.5-flash（12-01 起被强制改路由）换成
  gemini-3.8-flash（1048576，$0.75/$0.075/$3.75，2027-01-01 起 $1.50/$0.15/$7.50）、
  gemini-4-argon（1048576，$2/$0.10/$10，2026-12-01 起 $4/$0.20/$20，无免费档）、
  gemini-3.5-flash-lite（1048576，$0.30/$0.03/$2.50）。模型价格结构支持「生效日期」字段。
- OpenRouter：openrouter/auto 设 mode none、price null；moonshotai/kimi-k2 换成 moonshotai/kimi-k3（价格从 /models 实时取，不写死）。
- 硅基流动：Qwen/Qwen3-235B-A22B 改为 mode siliconflow_thinking（它默认开思考），returnThinking 改 true；
  Qwen/Qwen2.5-7B-Instruct 先用 /models 确认还在，不在就删。价格未核实的一律 price:null 并显示「价格待确认」，不要编。

四、用量解析（providers.py 269-308、443-445、633；usage.py 65-75；chats.py 280-283）
- 统一结构加 reasoning_tokens、cache_write_tokens 字段（DB 加列）。
- OpenAI Chat / DeepSeek / Qwen / Kimi / GLM / 硅基：prompt=prompt_tokens，cache=prompt_tokens_details.cached_tokens 或 prompt_cache_hit_tokens，
  output=completion_tokens，reasoning=completion_tokens_details.reasoning_tokens。
- OpenAI Responses（bug：现在读 prompt_tokens 全是 0）：prompt=input_tokens，cache=input_tokens_details.cached_tokens，
  output=output_tokens，reasoning=output_tokens_details.reasoning_tokens。新写 _norm_responses_usage，stream 和 complete 都用它。
- Anthropic：input_tokens 不含缓存 → prompt = input_tokens + cache_read_input_tokens + cache_creation_input_tokens，
  cache = cache_read_input_tokens，cache_write = cache_creation_input_tokens（按 5m 写入价计）。
  流式 message_start 与 message_delta 的 usage 要合并（逐字段取最大），不要后一个覆盖前一个（chats.py 现在是覆盖）。
- Gemini：output = candidatesTokenCount + thoughtsTokenCount（保持），另存 reasoning=thoughtsTokenCount。
- 统计页显示「其中思考 N tokens」。

五、思考内容显示
- OpenAI Responses 加 reasoning.summary:"auto"；Anthropic 5.x 加 display:"summarized"；Gemini 加 includeThoughts:true；
  OpenRouter 读 reasoning / reasoning_details；豆包读摘要；DeepSeek/Qwen/Kimi/GLM/硅基读 reasoning_content。
- Kimi K3 与带 tools 的 DeepSeek 必须回传历史 reasoning_content；其他家（无 tools）不回传。

六、验收
- 每个 mode × 每个档位一条单元测试，断言请求体（含「不该出现的字段」：budget_tokens、thinkingBudget+thinkingLevel 同时出现、
  对 gpt-6-astra 发 none、对 grok 发 penalty、对 Claude 5 发 temperature）。
- mock 400 用例：Anthropic temperature 400、Gemini 2.5 Pro budget=0 400。
- 文档 PROVIDERS_DESIGN.md 第 238-259 行的映射表整体重写，并在表头注明「依据 2026-11-11 官方文档」及下列链接。

来源（2026-11-11 读取）：
DeepSeek  https://api-docs.deepseek.com/zh-cn/guides/thinking_mode  https://api-docs.deepseek.com/api/create-chat-completion  https://api-docs.deepseek.com/zh-cn/quick_start/pricing  https://api-docs.deepseek.com/updates
OpenAI    https://platform.openai.com/docs/guides/reasoning  https://platform.openai.com/docs/models.md  https://platform.openai.com/docs/pricing.md  https://platform.openai.com/docs/deprecations.md  https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create.md
Anthropic https://platform.claude.com/docs/en/build-with-claude/thinking.md  https://platform.claude.com/docs/en/build-with-claude/effort.md  https://platform.claude.com/docs/en/models/overview.md  https://platform.claude.com/docs/en/about-claude/pricing.md  https://platform.claude.com/docs/en/about-claude/model-deprecations.md
Gemini    https://aistudio.google.com/docs/thinking.md?generate-content=true  https://aistudio.google.com/docs/latest-model.md?generate-content=true  https://aistudio.google.com/docs/pricing.md?generate-content=true  https://aistudio.google.com/docs/deprecations.md?generate-content=true  https://aistudio.google.com/docs/whats-new-gemini-3.6.md?generate-content=true
OpenRouter https://openrouter.ai/docs/guides/best-practices/reasoning-tokens.md  https://openrouter.ai/api/v1/models
xAI       https://docs.x.ai/developers/model-capabilities/text/reasoning.md  https://docs.x.ai/developers/models.md
Qwen      https://help.aliyun.com/zh/model-studio/deep-thinking  https://platform.qianwenai.com/docs/developer-guides/text-generation/thinking  https://help.aliyun.com/zh/model-studio/model-pricing
Kimi      https://platform.kimi.com/docs/api/models-overview  https://platform.kimi.com/docs/guide/use-thinking-models  https://platform.kimi.com/docs/guide/use-reasoning-effort  https://platform.kimi.com/docs/pricing/chat
GLM       https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3  http://docs.bigmodel.cn/cn/guide/capabilities/thinking  https://docs.bigmodel.cn/cn/guide/start/concept-param
豆包      https://ark.volcengine.com/region:cn-beijing/docs/responses-api-deep-thinking  https://ark.volcengine.com/region:cn-beijing/docs/chat-api  https://ark.volcengine.com/region:cn-beijing/docs/model-parameter-support  https://ark.volcengine.com/region:cn-beijing/docs/model-list
硅基流动  https://docs.siliconflow.cn/docs/api/chat-completions-post  https://docs.siliconflow.com/en/api-reference/chat-completions/chat-completions

## 4. 本次没核实到 / 需人工补的

- 价格未取到：Kimi 官方（表格前端渲染）、智谱 GLM、豆包/方舟、硅基流动、qwen3.7-plus、百炼缓存命中具体价。
- 硅基流动是否仍上架 `Qwen/Qwen2.5-7B-Instruct`：未能确认。
- OpenAI 推理模型在 Chat Completions 下是否拒绝 temperature：本次文档没写明，未下结论（建议仍按兜底处理）。
- Anthropic 流式 `message_delta` 是否携带 input_tokens：未单独核实，所以修法写成「合并取最大」，两种情况都对。
- 豆包 Chat API 下思考摘要的具体返回字段名：未核实（文档写 Chat API 回传 `encrypted_content`）。

---

## 第二块：提供商与中转站的「保存」和「测试连接」（芴已确认，以本节为准）

1. 详情页底部按钮保持「测试连接 / 删除 / 保存」，标签不改名。「保存」下方可加一行小字「保存后自动连接，不扣费」。
2. 点「保存」：先存配置，再自动执行只用免费接口的步骤，绝不调用 chat/completions、messages、generateContent 等生成接口：
   a. 补全并修正网址（见第 3 条）；
   b. 用 GET /models（OpenAI 兼容）、/v1/models（Anthropic）、/v1beta/models（Gemini）识别接口格式；
   c. 拉取模型列表，按模型 ID 识别家族（deepseek / claude / gemini / gpt 与 o 系列 / grok / kimi / glm / qwen / doubao），匹配官方图标、能力标签和已知价格；
   d. 按第一块的规则预设每个模型的可用思考档位；
   e. 能查余额就查，查不到就不显示，不报错；
   f. 完成后提示「已连接，识别到 N 个模型」。配置一直保存、可直接用。如果 /models 不可用，只保存配置，并提示「已保存，暂时无法自动识别模型，可手动添加，或点测试连接确认」。
3. 网址和路径自动补全。协议类型和 API 路径两个输入框留在原位，不挪到高级设置，默认按自动识别填好，用户手动改过的以用户为准：
   - 去掉首尾空格；没写 http(s):// 的自动补上 https://；
   - 用户把完整地址（…/v1/chat/completions、…/v1/messages、…/v1/models、…:generateContent）粘进 Base URL 时，自动拆成 Base URL + 路径；
   - 只填域名、没带 /v1 时，依次免费试 {base}/v1/models 和 {base}/models，用能通的那个，并改写 Base URL；
   - 防止 /v1/v1、//、路径重复拼接，Anthropic 和 Gemini 同样处理；
   - 自动修正过的地方，在输入框下用小字提示「已自动改为 …」。
4. 「测试连接」：只在用户点击时发一条真实的最小请求（单条 "hi"，max tokens 很小），测当前选中或默认模型能否回复、是否支持流式。点之前提示「会发一条测试消息，按次计费的接口可能扣一次费」。结果缓存，并显示测试时间。可以勾选「同时检测思考档位」，并提示会额外产生几次请求费用。后端原来只调 GET /models 的 test_connection 逻辑改为放进保存流程。
5. 中转站的档位按「后端真实模型家族 + 转发方式」决定，不按中转站的名字。转发方式有 openai_compat_translate / openai_compat_passthrough / native_anthropic / native_gemini / model_suffix 几种，默认自动判断，可以在高级设置里改；model_suffix 模式下，切换档位等于换成对应的模型 ID（例如 -thinking）。
6. 真实聊天中如果返回 400：先去掉思考参数，以及 temperature / top_p / top_k / presence_penalty / frequency_penalty 再重试一次；在回复下方用小字说明去掉了哪个参数；把这个档位标记为「这家不支持」，以后不再发送。
7. 所有失败只给一句中文白话原因和下一步（地址不对 / Key 不对 / 余额不足 / 这家不支持某功能，已自动关闭），不得出现英文原始报错。
8. 「拉取模型」按钮保留在模型页，用于手动刷新。
9. 测试：mock 断言点保存时没有任何生成请求；测试连接只发一次生成请求；补全规则逐条写单元测试。

---

## 第三块：网易云封面加载

- 现状：芴的安卓 Chrome 打开下载的样稿时，地址是 content://，外部图片被拦，封面全部退回素面唱片。直接打开封面链接是能显示的。
- 正式版（以后通过 http(s) 网址访问）继续让手机直接从网易云加载。加载失败时依次换 p1 / p2 / p3 / p4.music.126.net 重试，全部失败才退回主题色的素面唱片。
- 新增构建选项 node scripts/build.mjs --inline-covers：把内置歌曲的封面下载下来，压成 300px 的 JPEG data URI 打进单文件，用于交付样稿。用 headless chromium 加 --host-resolver-rules="MAP *.126.net 127.0.0.1" 验证封面仍能显示。

---

## 第四块：聊天记录管理与绑定

# 聊天记录管理与绑定需求（芴 2026-11-11 确认方向）
参考：SillyTavern 的机制（截图在 st-ref/，只学机制，不抄代码和界面，SillyTavern 是 AGPL）。界面保持缪诗鸳杞自己的玻璃风。

现状：chats 表支持一个角色多段对话，但接口按 character_id 写成单会话（/chats/{character_id}/ensure），没有对话列表、新建、切换、改名、搜索、导出，也不能编辑或删除单条消息。

1. 每个角色的对话列表：从角色卡或聊天页顶部进入。每条显示标题、最后一句预览、时间（今天显示几点，更早显示日期）、条数。支持新对话、切换、改名、置顶（小珍珠或小爱心标记）、删除（二次确认）。
2. 总入口「最近的聊天」放在「我的」页：全部角色按时间混排，可按角色筛选，可搜索消息内容并跳到对应位置，可批量删除或导出。
3. 标题：默认「角色名 - YYYY-MM-DD HH:mm」（芴选定，像酒馆那样），不调用模型；列表第二行显示首句或最后一句预览。可选的 AI 起名默认关闭，在设置里打开，或对单条点「帮我起个名」；按次计费的接口要提示可能扣一次费。用户改过的标题 AI 不再覆盖。
4. 绑定：每段对话记住角色、用户人设、世界书、预设和模型/思考档位，切回来自动恢复。用户人设分三层：默认 / 绑定到角色 / 绑定到这段聊天，优先级是聊天 > 角色 > 默认。加两个开关：「切换人设时提示」「自动把选中的人设绑定到当前聊天」。世界书分全局启用与绑定到角色/聊天。
5. 单条消息：编辑、删除、复制、重新生成；从某一条另开分支对话（新对话复制到这一条为止）。
6. 导入导出：导出为本项目 JSON（含绑定信息）；导入 SillyTavern 聊天 jsonl，并让用户选择或自动匹配绑定的角色。
7. 后端：新增 chat 级 CRUD 接口（列表、新建、改名、置顶、删除、搜索、分支、导入导出），以及消息编辑和删除接口；旧的 /ensure 保持兼容；加迁移和 pytest。
8. 验收：两个主题下的截图，包括列表、总入口、搜索、改名、人设三层绑定、分支；pytest 全过；底栏和「此刻」不回退。

## 补充：聊天页操作菜单（参考酒馆左下角菜单，截图 st-ref/ca430e…png）
在聊天页放一个收纳菜单（玻璃风），包含这些操作：开始新聊天、管理聊天文件（即本角色的对话列表）、保存检查点（在当前位置存一个分支点，之后可回到这里另开）、删除消息（进入多选模式批量删除）、重新生成、续写（让她接着上一条继续写）、AI 帮答（替用户写一条，用户确认后再发）、作者注释（只对这段聊天生效的额外指令，可设插入深度）、本聊天绑定的世界书、记录导出。CFG 缩放、Token 概率、转换为群聊这次不做。

---

## 验收（PHASE_D_CHECK.md）
- pytest 全部通过；每个思考模式 × 每个档位都有一条请求体断言测试；保存流程有「零生成请求」断言。
- 截图（冰蓝和粉色两个主题）：提供商详情页（自动补全提示、保存后显示「已连接，识别到 N 个模型」、测试连接的费用提示）、档位选择（不同模型显示不同档位）、对话列表、最近的聊天总入口、搜索、改名、人设三层绑定、聊天页菜单、单条消息操作、分支对话、样稿里显示的网易云封面。
- 列出每项需求的完成情况，未完成的写原因。

## 补充：粉色主题换壁纸（芴亲自选的，2026-11-11）
- 新壁纸已放在 `assets/wallpapers-720/wp18.jpg`（720×1543，浅粉拼贴：中间凯蒂猫 + 小熊、蝴蝶结、樱桃、格纹、蕾丝）。在 `src/data.js` 的壁纸列表里登记 wp18（名字「浅粉拼贴 · 凯蒂猫」），粉色主题首页默认用它，替换 C2 选的 wp05。
- 禁止自己画壁纸，禁止改这张图的颜色或饱和度；可以调 background-position，让中间的凯蒂猫那一块尽量露在卡片之间的空隙里或透过卡片能认出来。
- 玻璃参数保持 C2 现状不变（blur 3–6px、saturate ≤1.1、白色填充 0.07–0.18、无雾层、壁纸不模糊）。
- 这张图案较满，粉色主题的卡片文字可以略加深（#5A4550 往更深调）并保留柔光，保证对比度 ≥4.5；不要靠加厚白雾来解决。
- 验收：pink-home 与参考图并排截图，并在 CHECK 里写出透过卡片能认出的具体物件（如凯蒂猫、蝴蝶结、樱桃）；冰蓝主题不动。
