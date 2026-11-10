# PHASE A2 CHECK · 模型与提供商 / 思考档位 / 提示词预设 / 统计页

在 A 阶段（角色库、用户设定、世界书）之上继续做，没有推倒重来。
仍是不连模型的手机端静态样稿：没有 FastAPI、没有部署、没有 SSH、没有改 VPS。
所有截图由独立的 `scripts/check-a2.mjs`（headless Chrome，390 × 844）生成；**没有运行会清空 shots/ 的旧脚本 `scripts/shoot.mjs`**。

## 已完成

### 1. 模型提供商（自定义 API）
- 「我的 → 模型与额度」改成「模型与提供商」，进入提供商列表页；玻璃大卡片、分框摆放，不是一长条后台列表。
- 预置 7 家：DeepSeek、Anthropic、OpenAI（停用示例）、Google Gemini、OpenRouter、硅基流动、白露中转（样稿示例中转站，用来演示 400 兜底和「模型名区分档位」）。
- 列表支持：搜索（名字 / 地址 / 模型）、添加（7 种模板）、导入 JSON、导出 JSON；停用的提供商用浅红底、打「已停用」标签，并且不出现在聊天的模型弹层里。
- 提供商详情三个标签页：
  - **配置**：启用开关、名称、图标（18 个官方图标可选，默认按类型自动匹配）、协议类型、Base URL、API 路径（旁边是「拉取模型」）、API Key（始终掩码 + 显示按钮）、Response API 开关、回传历史思考过程开关、获取账户余额开关。
  - **模型**：每个模型一行（官方图标 / 显示名 / 模型 ID / 视觉·工具·思考能力标签 / 上下文 / 单价 / 收藏心形），底部「添加新模型」。
  - **高级设置**：请求超时、回传历史思考过程、演示 400 兜底、余额卡（查询 / 查询时间 / 不支持时写「这家不支持查询余额」）、复制 / 导出。
  - 底部浮动操作条：测试连接 / 删除（确认）/ 保存。
- 支持复制提供商（Key 不带走）、删除（确认）、启用 / 停用。
- 手动添加 / 编辑模型：显示名、模型 ID、视觉 / 工具调用 / 思考能力、上下文长度、思考方式、支持档位、默认档位、中转站模型名后缀、单价（输入 / 缓存命中 / 输出，¥ 或 $，可留空）、收藏。
- 拉取模型：OpenAI 兼容 GET `{base}/models`、Anthropic `/v1/models`、Gemini `/v1beta/models`；真实请求带 8 秒超时；失败时给中文原因，并放一份示例列表让用户勾选（正式版删掉示例分支，见 PROVIDERS_DESIGN.md）。
- 测试连接：先真的发一次请求（8 秒超时）；失败由 `classifyApiError` 归类成网络不通 / 跨域被拦 / Key 不对 / 地址或路径不对 / 额度用完 / 请求太频繁 / 服务器错误 / 超时，显示短中文提示 + 中文分类小字，不弹英文原始报错、不卡死。
- 余额：只对 DeepSeek（GET /user/balance）与 OpenRouter（GET /api/v1/credits）开启；查询失败只显示小灰字「余额暂不可查」。
- API Key 安全：样稿存 localStorage，界面始终掩码；导出默认不带 Key，勾选才带并提示风险。正式版方案写在 PROVIDERS_DESIGN.md（Key 存 VPS 后端、浏览器不直接拿 Key 发请求、同时解决跨域）。
- 官方图标：从 MIT 许可的 `@lobehub/icons-static-svg` 1.102.0 复制 18 个实际用到的 SVG 到 `src/icons/`，构建时内联，没有把整个包打进 dist；按模型 ID 关键词自动匹配，匹配不到用中性字母圆形。

### 2. 思考档位
- 档位：关闭 / 自动 / 低 / 中 / 高，部分模型额外支持「最高」；DeepSeek 官方只给「关闭 / 开启」；不支持思考的模型灯泡置灰、写「这个模型不能调思考深度」并说明请求里不带任何思考参数。
- 独立函数 `buildReasoningParams(model, level)` 覆盖：`none / openai_effort / anthropic_budget / gemini_budget / deepseek / openrouter / relay_suffix`；Anthropic 自动保证 max_tokens 大于 budget；Gemini 支持 thinkingBudget 与新模型的 thinkingLevel；中转站按模型名切档。
- 聊天页输入框上方工具胶囊同排加了灯泡按钮，显示当前档位小字（关 / 自动 / 低 / 中 / 高 / 最高），点开是底部玻璃弹层「调整思考深度」：当前档位大字、一句说明、分段滑杆、右侧灯泡、这次请求会带的参数预览。
- 聊天里改档位只影响这场聊天；改完会问「只改这场 / 同时设为该模型默认」（和用户设定同样的交互）。
- 400 兜底：样稿用 `provider.advanced.demo400` 演示——发送时自动去掉思考参数重试一次，回复下方小字「这家不支持调思考深度，已按默认回复。」，聊天不失败。
- 回复里的思考过程折叠显示，默认收起，一行「想了 N 秒」；提供商高级设置里的「回传历史思考过程」控制是否回传。

### 3. 提示词预设
- 「我的」新增「提示词预设」独立库（不和角色库混在一起）。
- 预设包含：名称、说明、若干提示词片段（标题 / 内容 / 角色 system·user·assistant / 位置：角色设定之前、之后、聊天记录倒数第 N 条深度注入、用户这句话之后 / 启用 / 顺序），以及采样参数：温度、Top P、最大输出 Token、上下文消息条数、流式输出、频率 / 存在惩罚；留空 = 不设置，用模型默认。
- 预置 3 个：「默认」「细腻散文」「日常短句」，内容自己写，简短、通用、成年人语境。
- 绑定顺序：这场指定 > 角色默认 > 全局默认；聊天顶栏「我 · 芴」「书 · 旧城雨事」旁新增「文风 · 细腻散文」胶囊；换文风会问「只改这场 / 同时设为角色默认」。
- 导入酒馆（SillyTavern）预设 JSON：认 prompts / prompt_order 结构以及 temperature / top_p / max_tokens 等字段，不认识的字段收进「额外资料」；导出为本应用 JSON。
- 独立函数 `assemblePrompt(context)` 演示拼装顺序（预设前置 → 角色设定 → 世界书 → 用户设定 → 聊天记录含深度注入 → 预设后置），聊天页「…」里有「查看这次发给模型的内容」预览面板。

### 4. 统计页
- 「我的」顶部本月用量卡保留为摘要，点进去是独立「统计」页。
- 内容：时间范围（今天 / 7 天 / 30 天 / 90 天 / 全部）；总览（输入、输出、缓存命中、命中率、估算花费、请求次数、平均每次回复用时）；近一年聊天热力图；每日 / 每月用量柱状图（输入 / 缓存 / 输出叠色，可切 Token / 花费）；按模型 / 提供商 / 角色排行（条形 + 次数 + 百分比）；余额卡；总对话数、总消息数、在一起天数。
- 图表全部纯 SVG / CSS 手写，没有引入图表库；动画只用 transform / opacity。
- 「未知模型」不出现：样稿约 60 天、5 个模型、3 个角色的假 usage 记录都带 provider + model id + 显示名；旧数据缺信息会归到「未标记」并在一处说明（样稿当前为 0 条）。
- 花费按模型单价算，没填单价的模型标「未设单价」并不计入；美元按 ¥7.1/$ 折算。
- 统计原理、usage 字段、SQLite 建表与流式 usage 说明写在 PROVIDERS_DESIGN.md。

### 5. 聊天页模型选择弹层重做
- 顶部搜索 → 「收藏」分组 → 按提供商分组（组头：官方图标、名字、模型数、余额或「余额暂不可查」小灰字，可折叠）→ 组内模型行（官方图标、显示名、模型 ID、视觉 / 工具 / 思考标签、收藏心形）→ 底部提供商快捷胶囊（点了滚到那一组）。
- 只显示启用的提供商；弹层最多 80% 屏高，内部滚动。
- 右上角模型胶囊显示当前模型官方小图标 + 短名。

### 6. 不变的东西（已回归验证）
- 底栏 66px、四个图标齐平、爱心选中只变色不跳不凸不放大。
- page-scroll 88px / composer-zone 80px / toast 80px 预留不变。
- 「此刻」卡片的「编辑」仍在正文下方普通文档流。
- A 阶段角色库、用户设定、世界书和绑定逻辑仍可用。
- 两套主题配色与壁纸分配不变；新页面（提供商 / 预设 / 统计）只新增自己的壁纸分配，仍按需加载、backdrop-filter 克制、动画只用 transform / opacity。

## 自查结果

- 构建：`node scripts/build.mjs` 通过；dist/index.html 仍是单文件，**1,908,583 字节（约 1.82 MiB）**，低于 2.2MB 目标；图标只内联实际用到的 18 个 SVG。
- Headless Chrome 自查（`node scripts/check-a2.mjs`，390 × 844，粉 + 冰蓝两套）：
  - **功能断言 76 / 76 通过**。
  - 控制台 **0 条 JS 报错 / 异常**（真实「测试连接 / 拉取模型」请求产生的 3 条网络资源 401/跨域日志不计为 JS 报错，已在脚本里单独统计；界面上都显示为中文分类提示）。
  - 390 宽无横向溢出；刷新后提供商 / 模型 / 预设 / 当前模型 / 文风绑定都还在。
- 关键流程自查（都有断言）：
  - 新建 OpenAI 兼容中转站 → 填 Base URL / 路径 / Key → 保存 → Key 掩码 → 显示按钮 → 手动加模型（默认支持思考档位）→ 拉取模型失败给中文原因并出示例勾选 → 勾选加入 → 测试连接显示中文分类 → 高级设置开 400 演示 → 停用后模型弹层不出现 → 重新启用。
  - 模型弹层：8 个分组、收藏、组头余额、折叠 / 展开、搜索、收藏心形、底部胶囊跳转、弹层高度 675px ≤ 80%。
  - 思考档位：7 种思考方式参数映射断言；5 档滑杆；当前档位大字；改档询问默认；不支持模型灯泡置灰与文案；回复思考过程默认折叠；400 兜底 retried + 小字提示 + 聊天不失败。
  - 预设：酒馆 JSON 导入成功（2 个片段、采样参数、额外字段）、采样参数保存、换文风询问、顶栏文风胶囊、assemblePrompt 顺序断言（preset → char → book → user → chat，含深度注入）、预览面板可打开。
  - 统计：5 个范围逐一与 `aggregateUsage(rangeRecords(range))` 对比一致（今天 3 次 / 7 天 17 次 / 30 天 75 次 / 90 天 160 次 / 全部 160 次）；热力图 371 格；排行切换；按花费切换；余额查询失败只显示「余额暂不可查」；页面没有「未知模型」。
  - 导入导出：导出默认不带 Key、勾选带 Key 有风险提示；导入提供商 JSON 成功且不接收文件里的 Key。
  - 硬约束：底栏 66px、图标顶部齐平、爱心尺寸不变且只有颜色变化、page-scroll 88 / composer-zone 80 / toast 80、「此刻」编辑在正文下方。
- 未运行 `scripts/shoot.mjs`；截图见下。

## 截图清单（shots/phase-a2/，共 44 张）

粉色：
- 我的与入口：`pink-me-entry`
- 提供商：`pink-providers-list`、`pink-provider-config`、`pink-provider-models`、`pink-provider-advanced`、`pink-provider-new-models`、`pink-provider-export`
- 拉取模型 / 测试连接：`pink-pull-models`、`pink-test-connection`
- 模型选择弹层：`pink-model-picker-open`、`pink-model-picker-collapsed`、`pink-model-picker-search`
- 思考：`pink-chat-bulb`、`pink-reasoning`、`pink-reasoning-ask`、`pink-reasoning-unsupported`、`pink-chat-thinking-fold`、`pink-400-fallback`
- 预设：`pink-presets-list`、`pink-preset-detail`、`pink-frag-edit`、`pink-chat-preset-chip`、`pink-prompt-preview`
- 统计：`pink-stats-top`、`pink-stats-mid`、`pink-stats-cost`、`pink-stats-bottom`、`pink-balance-fail`
- 底栏：`pink-nav-closeup`

冰蓝：
- 聊天与思考：`ice-chat`、`ice-chat-thinking-fold`、`ice-reasoning`
- 模型选择：`ice-model-picker`
- 提供商：`ice-providers-list`、`ice-provider-config`、`ice-provider-advanced`
- 预设：`ice-presets-list`、`ice-preset-detail`、`ice-prompt-preview`
- 统计：`ice-stats-top`、`ice-stats-bottom`
- 我的与底栏：`ice-me-entry`、`ice-nav-closeup`、`ice-nav-closeup2`

另外 `shots/phase-a2/_check-result.json` 保存了 76 项断言与报错统计，方便复查。

## 改动文件

- `src/data.js`：新增协议 / 模板 / 7 家提供商 / 11 个模型 / 3 个提示词预设 / 60 天 usage 假数据 / 新页面壁纸分配；角色加默认文风；示例回复加思考过程。
- `src/index.html`：新增提供商、提示词预设、统计三个视图；聊天页灯泡胶囊、文风胶囊、模型图标、「…」菜单；我的页新入口；文件选择器与图标占位。
- `src/liquid.css`：只追加 A2 样式（提供商卡片、分栏、标签页、底部操作条、模型弹层、思考滑杆、思考折叠、预设编辑、统计卡片 / 热力图 / 柱状图 / 排行 / 余额），既有行未动。
- `src/app.js`：提供商增删改查 / 导入导出 / 拉取模型 / 测试连接 / 余额、`classifyApiError`、思考档位 `buildReasoningParams` + 400 兜底、模型选择弹层重做、提示词预设库 / 编辑 / 酒馆导入 / 绑定 / `assemblePrompt` 预览、统计页聚合与渲染、`window.__a2` 自查入口；以及小的状态与路由改动。
- `src/icons/`：18 个官方 SVG（MIT）。
- `scripts/build.mjs`：内联 `src/icons/` 里实际用到的 SVG，并检查占位符与图标引用。
- `scripts/check-a2.mjs`：本阶段自查 + 双主题截图脚本（新增，独立于 `shoot.mjs`）。
- `dist/index.html`：重新构建；开工前已备份为 `dist/index.before-phase-a2.html`。
- `THIRD_PARTY_NOTICES.md`、`PROVIDERS_DESIGN.md`、`PHASE_A2_CHECK.md`：新增/更新文档。

## 本阶段没做（留给后端阶段）

- 不接真实模型、不写 FastAPI、不部署、不改 VPS；聊天回复仍是本地假数据。
- 测试连接 / 拉取模型 / 余额是样稿里的一次真实浏览器请求（会受跨域限制），没有后端代理。
- 拉取模型失败后的示例模型列表只用于样稿演示；正式版必须删掉。
- 思考档位的 400 兜底用 `advanced.demo400` 演示；真正由服务器返回 400 再重试的逻辑在后端实现（设计见 PROVIDERS_DESIGN.md）。
- 没有做：模型批量导入 CSV、每个模型单独限流 / 重试、代理请求的服务端日志脱敏、统计导出 CSV、向量检索、群聊、语音。
- 没有把 `@lobehub/icons-static-svg` 整个包装进 dist；没有引入任何图表 / UI 框架。

## 已知说明

- 样稿里所有 Key 都是空或明显假的占位符（`sk-••••` / 测试时用的 `sk-test-0000`），没有真实 API Key。
- 真实「测试连接」会让浏览器网络面板出现 1 条 401 或跨域失败资源记录，这是预期；界面只显示中文分类，脚本把这类网络资源日志与 JS 报错分开统计。
- 统计页数字来自 60 天本地假数据；不同日期打开时热力图 / 范围数字会随「今天」滚动，但同一场景下与 usage 汇总始终一致（断言已逐范围核对）。
