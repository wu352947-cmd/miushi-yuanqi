# PHASE B CHECK · 接上真实后端（FastAPI + SQLite）

在 A / A2 阶段的前端样稿之上继续做，没有推倒重来：界面、主题、底栏和「此刻」的约束都保留。
本阶段把数据从浏览器 `localStorage` 迁到本机后端，聊天、记忆抽取、用量统计、提供商测试 / 拉模型 / 余额全部由后端转发。
没有部署，没有 SSH，没有改任何远程 VPS，没有在仓库、文档或截图里写真实 API Key。

## 一、完成项

### 1. 后端（server/，FastAPI + SQLite）

- 单进程同时提供 `/api/...` 与 `dist/index.html`，同源、不需要 CORS；默认只监听 `127.0.0.1:8080`（`HOST` / `PORT` 可改）。
- SQLite 表：`users`、`sessions`、`providers`、`models`、`prompt_presets`、`characters`、`user_personas`、`world_books`、`world_book_entries`、`chats`、`messages`、`memories`、`usage`、`settings`；带版本号迁移。
- 启动时若库是空的，写入前端预置的演示数据（角色 3 位、用户设定 2 套、世界书 2 本、提供商模板 7 家、模型 11 个、文风预设 3 个、示例记忆 12 条、现在卡），**不带任何真实 Key**；`MSYQ_SEED=0` 可关闭。
- 后端是权威：前端 `GET /api/bootstrap` 取快照，编辑后 `PUT /api/state` 同步集合与绑定；聊天消息、记忆、现在卡走各自专用接口，避免整体同步覆盖流式写入。
- 绑定关系与 A / A2 一致：用户设定 / 提示词预设都是「这场聊天指定 > 角色默认 > 全局默认」；世界书是「全局 + 角色一本 + 聊天一本」合并去重；一场聊天固定属于一个角色。

### 2. 安全

- `APP_PASSWORD` 设置了就要求登录：HttpOnly + SameSite=Lax 会话 cookie（HTTPS 下自动 Secure），token 只以哈希存库；未设置时是开发模式，页面和启动日志都会明确提示「未设置登录密码（APP_PASSWORD）」。
- API Key 用 Fernet（密钥来自必填的 `APP_SECRET`）加密入库；`GET /api/providers` 只返回 `hasKey` + `keyMasked`，所有接口都不回明文，导出默认不带 Key，勾选才带并在响应里带风险标记。
- 浏览器不再直连任何模型接口：测试连接、拉模型、余额、聊天、记忆抽取全部走 `/api/...`；日志只记方法与路径，不记 query / Cookie / Authorization。
- 删除了样稿的 `window.__a2` 与 `advanced.demo400`（`src/` 与 `dist/` 中均已无引用），400 兜底改为真实逻辑。
- 提供 `POST /api/migrate/local`：上传浏览器 `msyq.v2` 快照，按 id 去重、可重复执行；用户确认后可连同加密上传 Key，成功后前端清空本地明文 Key。

### 3. 聊天（真的流式）

- `POST /api/chats/{characterId}/messages` 返回 SSE：`user / meta / delta / thinking / usage / fallback / error / done`。
- 每次请求：`assemblePrompt`（预设前置 → 角色设定 → 世界书常开 + 关键词命中，扫最近若干条 + 字符预算 → 用户设定 → 现在卡 + 钉住的记忆 → 聊天记录含深度注入 → 预设后置 → 当前用户句）→ `buildReasoningParams` 按当前模型和档位拼进对应协议 → 转发流式响应 → 落库 → 写 usage。
- OpenAI 兼容流式带 `stream_options.include_usage`；Anthropic / Gemini / Responses 各自解析 usage 与思考增量。
- 思考参数被 400/422 拒绝（错误信息与 think / reason / budget / effort 有关）时，自动去掉参数重试一次，回复带 `fallback` 标记，前端显示「这家不支持调思考深度，已按默认回复」；聊天不会因此失败。
- 不支持思考的模型，请求里绝不带思考参数。
- 拿不到 usage 时按字数估算，并在 usage 记录与界面标「估算」；每条记录带提供商 + 模型 ID + 显示名，不会出现「未知模型」。
- 没有配置 Key 时返回中文提示「先到模型与提供商里填写 API Key」，前端不会白屏或显示英文堆栈。

### 4. 记忆库 v1（做实了，不是占位）

- 一张「现在卡」（可编辑，进入提示词）+ 主题笔记（标题 / 正文 / 重要度 / 标签 / 分类 / 来源 / 可钉住 / 可搜索）。
- 默认软遗忘：只改状态为「已遗忘」，可恢复，不真删。
- 每聊 N 轮（默认 4，可在设置里改）用当前模型异步抽新记忆，写入前去重，失败不影响聊天；`usage` 里记一条 `kind=memory`。
- 用户说「记住这个」或「记住：……」当场写成一条笔记；聊天菜单里也加了「记住这句话」。
- 不做向量库、图谱、自动梦境整理；搜索用 SQL 关键词 / 全文。

### 5. 其它 API 与前端改造

- `/api/auth/login|logout|me`、提供商 CRUD / 启用 / 测试连接 / 拉模型 / 查余额（5 分钟缓存，失败只回「余额暂不可查」）、模型 CRUD / 收藏、角色 / 用户设定 / 世界书 CRUD、提示词预设 CRUD、聊天列表 / 消息 / 绑定、`GET /api/stats?range=today|7d|30d|90d|all`、记忆 CRUD / 遗忘 / 恢复 / 搜索 / 记住。
- 角色卡 JSON / PNG 导入导出改由后端解析：PNG 读 `ccv3` 再读 `chara`（tEXt + Base64），导出写 v2 JSON + `chara` 块；卡内嵌的 `character_book` 自动另存为一本世界书并挂到角色上。
- 世界书 / 用户设定 / 提示词预设 / 提供商 JSON 的导入导出也走后端校验与代理。
- 前端：通过 http(s) 打开时以后端为准；`file://` 打开时保留离线本地降级（只读 / 演示回复）。新增登录层（仅设置了 `APP_PASSWORD` 时出现）、开发模式提示、采集「这次发给模型的内容」从后端拿、统计页与首页用量卡改为读后端数据、提供商 Key 只显示掩码、日志和界面不出现英文原始报错。
- `shots/phase-b/` 由新的 `scripts/phase-b-check.mjs` 生成（无头 Chrome，390 × 844，粉 / 冰蓝），没有运行会清空 `shots/` 的旧脚本 `scripts/shoot.mjs`。

## 二、自检结果

### pytest

```bash
source .venv/bin/activate
python -m pytest
# 48 passed
```

覆盖 48 条：提示词拼装顺序与深度注入、世界书常开 / 关键词 / 预算 / 去重、绑定优先级、思考档位 7 种映射、400 去参数重试 + `fallback_reasoning`、错误分类、usage 汇总（含估算标记 / 未设单价 / 缓存命中）、软遗忘与恢复、迁移幂等（含 Key 默认不上传）、GET 提供商不回明文 Key、账号登录 / 登出、整体状态同步、角色 JSON / PNG 导入导出、酒馆世界书 / 预设 / 用户设定导入。

### 构建

```bash
node scripts/build.mjs
# dist/index.html 单文件约 1.84 MiB（1,885.8 KB）
```

### 浏览器自查（scripts/phase-b-check.mjs）

| 场景 | 服务 | 断言 | JS 报错 |
| --- | --- | --- | --- |
| 主流程（未设密码 + `MSYQ_MOCK=1`） | 127.0.0.1:8080 | 20 / 20 | 0 |
| 登录（设置 `APP_PASSWORD`） | 127.0.0.1:8081 | 3 / 3 | 0 |
| 没有 Key 的中文提示（不 mock） | 127.0.0.1:8082 | 3 / 3 | 0 |
| 思考参数 400 自动兜底（`MSYQ_MOCK_400=1`） | 127.0.0.1:8083 | 2 / 2 | 0 |

断言包括：同源页面正常启动、开发模式 / 登录模式提示正确、底栏仍 66px 且四图标齐平、page-scroll 88 / composer-zone 80 / toast 80 不变、「此刻」编辑按钮仍在正文下方文档流、Key 只显示掩码且 `GET /api/providers` 不回明文、拉模型走代理、余额查询有缓存结果、角色 JSON 经后端导入后出现在角色库、聊天走后端 SSE 且回复带 usage 与折叠思考、统计接口与页面数字来自 usage 表、记忆新增 / 软遗忘 / 恢复 / 「记住这句话」、思考档位弹层、无 Key 中文提示、400 兜底提示。
结果明细在 `shots/phase-b/_check-*.json`。

## 三、截图清单（shots/phase-b/，共 26 张 PNG + 4 份结果 JSON）

粉色：
- 登录与设置：`pink-login`、`pink-home-after-login`、`pink-settings`、`pink-settings-login-mode`、`pink-me`
- 聊天与思考：`pink-chat-stream`、`pink-chat-no-key`、`pink-chat-400-fallback`、`pink-reasoning`
- 提供商：`pink-provider-masked-key`、`pink-pull-models`、`pink-provider-balance`、`pink-provider-test-nokey`
- 角色导入：`pink-character-imported`
- 记忆：`pink-memory-new`、`pink-memory-forgotten`、`pink-memory-restored`
- 统计：`pink-stats-top`、`pink-stats-mid`、`pink-stats-rank-provider`

冰蓝：
- `ice-chat-stream`、`ice-reasoning`、`ice-memory`、`ice-stats-top`、`ice-provider-masked-key`、`ice-me`

> 演示模式说明：截图环境没有真实 API Key，聊天截图使用 `MSYQ_MOCK=1`（本机生成回复，usage 仍真实写入 usage 表）；「没有 Key 的中文提示」用不 mock 的独立实例截图；400 兜底用 `MSYQ_MOCK_400=1` 的独立实例截图。没有把任何真实 Key 写进截图或仓库。

## 四、本阶段没做

- 不部署、不上 VPS、不做公网 HTTPS / 反向代理；只在本机开发机验收。
- 不做 Postgres、向量库、本地大模型、图谱、3D、语音、主动找你、来电、商城、一起听的真实网易云对接。
- 世界书 v1 只做常开 / 关键词 + 简单预算，不做递归激活、概率 / 冷却、正则引擎。
- 不做群聊，也不做一场聊天中途换所属角色（换角色 = 去那位角色的聊天）。
- 不做记忆的向量检索、自动梦境整理。
- 不做用户体系 / 多租户 / 权限分级；仍是单账号单用户。
- 没有把 `MSYQ_MOCK` 当作正式功能：它只用于本地演示与测试，文档里已标注。

## 五、如何启动

```bash
# 1. 依赖
python3 -m venv .venv
source .venv/bin/activate
pip install -r server/requirements.txt

# 2. 配置：至少填一个 APP_SECRET
cp server/.env.example .env
python -c "import secrets; print(secrets.token_urlsafe(48))"   # 填到 APP_SECRET
#    想启用登录就设 APP_PASSWORD；不设则页面和日志都会提示「未设置登录密码」

# 3. 构建前端
node scripts/build.mjs

# 4. 启动（默认 127.0.0.1:8080）
python -m server.app
```

打开 <http://127.0.0.1:8080/>。首次启动会自动建库、写入演示数据；数据在 `data/miushi.db`（已 gitignore）。
只想本地看演示、没有 Key 时，可以 `MSYQ_MOCK=1 python -m server.app` 让回复由本机生成（usage 仍会落库），或用真实 Key 走真实接口。

## 六、改动文件

- 新增 `server/`：入口、鉴权、SQLite / 迁移 / 演示数据、响应模型、协议适配、思考参数、错误分类、提示词拼装、记忆、usage、角色卡 PNG/JSON、按资源拆分的 routers、pytest、README、requirements、`.env.example`。
- 新增 `scripts/phase-b-check.mjs`（功能断言 + 双主题截图）。
- 修改 `src/app.js`：同源后端层（bootstrap / 状态同步 / 登录 / 迁移）、真流式聊天、记忆与现在卡、提供商 Key / 测试 / 拉模型 / 余额 / 导入导出走后端、统计页与用量卡读后端、后端提示词预览、删除 `window.__a2` 与 `demo400`。
- 修改 `src/index.html`：登录层、设置页服务器状态提示、记忆页「新增一条记忆」入口、文案与版本号。
- 修改 `src/liquid.css`：只追加登录层 / 状态提示样式，未动底栏与「此刻」布局。
- 修改 `src/data.js`：删除 `advanced.demo400`。
- 新增/更新 `PROVIDERS_DESIGN.md` 第 11 节（对接清单与实现差异）、`server/README.md`、`.gitignore`、`pytest.ini`、`dist/index.before-phase-b.html`（开工前备份）、`dist/index.html`（重新构建）。
- 截图与自查结果：`shots/phase-b/`。
