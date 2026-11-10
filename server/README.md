# 缪诗鸳杞 · 本机后端

一个轻量的 **FastAPI + SQLite** 后端，给缪诗鸳杞的移动端前端用。

职责只有六件事：**鉴权、存数据、拼提示词、转发流式请求、记用量、抽取记忆**。
模型计算全部调用外部 API；本机不跑模型、不引入向量库，也没有重量级 ORM。
同一个进程既提供 `/api/...`，也托管构建好的 `dist/index.html`，前后端同源，不需要 CORS。

## 快速开始

```bash
# 1. 安装依赖（Python 3.11+，建议虚拟环境）
python3 -m venv .venv
.venv/bin/pip install -r server/requirements.txt

# 2. 生成一个加密密钥，写进 .env
cp server/.env.example .env
python -c "import secrets; print(secrets.token_urlsafe(48))"   # 填到 APP_SECRET

# 3. 构建前端（单文件 dist/index.html）
node scripts/build.mjs

# 4. 启动（默认只监听 127.0.0.1:8080）
.venv/bin/python -m server.app
```

打开 <http://127.0.0.1:8080/> 就能用。
首次启动会建库（默认 `data/miushi.db`），并写入一份演示数据（角色、用户设定、世界书、提供商模板、文风预设、示例记忆）。

也支持：

```bash
.venv/bin/uvicorn server.app:app --host 127.0.0.1 --port 8080
```

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `APP_SECRET` | 是 | 加密 API Key 与会话签名用。生成：`python -c "import secrets; print(secrets.token_urlsafe(48))"`。**不要提交进 git。** |
| `APP_PASSWORD` | 否 | 设置了就要求登录（单账号）。留空即开发模式免登录，页面与启动日志会明确提示「未设置登录密码」。 |
| `HOST` | 否 | 默认 `127.0.0.1`。只有明确需要从局域网 / 手机访问时才改成 `0.0.0.0`，并自行确认网络与防火墙可信。 |
| `PORT` | 否 | 默认 `8080`。 |
| `APP_USER_NAME` | 否 | 显示用的账号名，默认 `owner`。 |
| `MSYQ_DATA_DIR` /`MSYQ_DB_PATH` | 否 | 数据目录 / SQLite 文件路径。 |
| `CURRENCY_USD_CNY` | 否 | 统计页美元折算人民币的汇率，默认 `7.1`。 |
| `SESSION_SECURE` | 否 | 反向代理终止 HTTPS 时，可以设为 `1` 强制 Secure cookie。 |
| `MSYQ_MOCK` | 否 | **仅本地演示 / 测试**：不请求外部模型接口，回复由本机生成，usage 仍会落库。 |
| `MSYQ_MOCK_400` | 否 | 配合 `MSYQ_MOCK`，模拟「思考参数被 400 拒绝 → 去掉参数重试一次」。 |
| `MSYQ_SEED` | 否 | 设为 `0` 可关闭首次启动的演示数据。 |

## 安全

- **API Key 只进不出**：Fernet 加密存 SQLite，派生密钥来自 `APP_SECRET`。`GET /api/providers` 只返回 `hasKey` 和 `keyMasked`，任何接口都不回明文；导出默认不带 Key，显式勾选才带并附风险标记。
- **浏览器不直连模型接口**：测试连接、拉模型、余额、聊天、记忆抽取都由后端发出，Key 不出后端。
- **日志脱敏**：访问日志只记方法与路径，不记 query（Gemini 的 Key 在 query 里）、Cookie、Authorization；上游错误只截断一小段进服务端日志，界面只显示中文短提示。
- **会话**：HttpOnly + SameSite=Lax 的会话 cookie，token 只以哈希形式存库，默认 30 天过期；HTTPS 下自动加 Secure。
- 单用户设计：一个登录账号，数据只存这一台机器。不要把 `.env`、`data/*.db` 提交进仓库。

## 目录

```
server/
  app.py           入口：把 API 与 dist/index.html 放在同一个进程
  auth.py          登录会话、密码校验、API Key 加密 / 掩码
  db.py            SQLite 建表迁移、演示数据、序列化、整体状态同步、浏览器迁移
  schemas.py       请求 / 响应模型
  providers.py     协议适配：OpenAI 兼容 / Responses / Anthropic / Gemini / DeepSeek / OpenRouter
  reasoning.py     buildReasoningParams（与前端同一套映射）
  errors.py        classifyApiError：中文 kind + 短提示
  prompts.py       assemblePrompt、世界书常开 / 关键词激活与预算
  memory.py        现在卡、主题笔记、软遗忘、自动抽取、「记住这个」
  usage.py         从 API usage 写入并汇总统计
  cards.py         角色卡 / 世界书 JSON 与 PNG（tEXt ccv3 / chara）解析写出
  routers/         按资源拆分的路由
  tests/           pytest
  requirements.txt
  .env.example
```

## API 概要

除 `/api/health` 与 `/api/auth/*` 外，设置 `APP_PASSWORD` 后都需要登录。
未设置 `APP_PASSWORD` 时直接放行（开发模式）。

### 鉴权与状态

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查、是否开发模式 / 演示模型 |
| GET | `/api/auth/me` | 是否需要登录、当前是否已登录 |
| POST | `/api/auth/login` `/api/auth/logout` | 登录 / 登出 |
| GET | `/api/bootstrap` | 启动快照：服务器信息 + 全部实体 + 今日 / 本月用量摘要 |
| PUT | `/api/state` | 整体状态同步（集合、主题、绑定；不含聊天消息与记忆） |
| GET/PUT | `/api/settings` | 主题 / 壁纸 / 起始日 / 当前模型与角色 |
| GET | `/api/usage/summary` | 首页用量卡 |
| POST | `/api/migrate/local` | 从浏览器 `localStorage` 快照迁移（按 id 去重，可重复） |

### 提供商与模型

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/providers` | 列表 / 新建（只回掩码） |
| GET/PUT/DELETE | `/api/providers/{id}` | 详情 / 更新 / 删除（级联模型） |
| POST | `/api/providers/{id}/key` | 写入或清除 Key（请求体 `{apiKey}`，响应只回掩码） |
| POST | `/api/providers/{id}/test` | 测试连接（8 秒，后端发出） |
| POST | `/api/providers/{id}/pull-models` | 拉取模型列表 |
| POST | `/api/providers/{id}/balance` | 官方余额接口（5 分钟缓存；失败只给 `failKind`） |
| GET | `/api/providers/export?includeApiKey=0\|1` | 导出 JSON（默认无 Key） |
| POST | `/api/providers/import` | 导入 JSON（文件里的 Key 一律不接收） |
| — | `/api/models...` | 模型 CRUD、收藏 |

### 角色 / 用户设定 / 世界书 / 预设

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| — | `/api/characters...` | CRUD；`POST /import` 支持 JSON / PNG 角色卡；`GET /{id}/export?format=json\|png` |
| — | `/api/personas...` | CRUD、整包 JSON 导入 / 导出 |
| — | `/api/worldbooks...` | CRUD、条目编辑、酒馆世界书 JSON 导入 / 导出 |
| — | `/api/presets...` | CRUD、酒馆预设 JSON 导入、导出、绑定 |

### 聊天与记忆

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/chats` `/api/chats/{characterId}` | 聊天列表 / 详情 |
| POST | `/api/chats/{characterId}/ensure` | 确保聊天存在（必要时写入开场白） |
| PATCH | `/api/chats/{characterId}` | 这场聊天的用户设定 / 世界书 / 模型 / 档位绑定 |
| GET | `/api/chats/{characterId}/prompt-preview` | 后端真正拼好的提示词预览 |
| POST | `/api/chats/{characterId}/messages` | **SSE 流式回复**（见下） |
| — | `/api/memories...` | 笔记 CRUD、`/now` 现在卡、`pin` / `forget` / `restore`、`search`、`remember`、`extract` |
| GET | `/api/stats?range=today\|7d\|30d\|90d\|all&metric=token\|cost&rank=model\|provider\|char` | 统计页全部数字 |

### 流式聊天事件

`POST /api/chats/{characterId}/messages` 返回 `text/event-stream`：

| event | 内容 |
| --- | --- |
| `user` | 已入库的用户消息 |
| `meta` | 本次模型、思考档位与参数预览 |
| `delta` | 正文增量 |
| `thinking` | 思考过程增量（提供商关闭回传时不发） |
| `usage` | 本次 usage（拿不到时为估算并标记 `estimated`） |
| `fallback` | 思考参数被拒后的兜底说明 |
| `error` | 中文 `kind` + 短提示 |
| `done` | 落库后的完整消息、fallback、remembered |

流程要点：

1. `assemblePrompt`：预设前置 → 角色设定 → 世界书（常开 + 关键词命中，扫最近若干条，做字符预算）→ 用户设定 → 现在卡与钉住的记忆 → 聊天记录（含深度注入）→ 预设后置 → 当前用户句。
2. `buildReasoningParams` 按当前模型与档位把参数拼进对应协议；不支持思考的模型绝不带参数。
3. 上游返回 400/422 且错误与 thinking / reasoning / budget / effort 有关时，去掉思考参数重试一次，回复带 `fallback` 标记，聊天不失败。
4. OpenAI 兼容流式请求带 `stream_options.include_usage`；Anthropic / Gemini / Responses 的 usage 分别从各自事件里取。
5. 结束后写一条 usage（提供商 + 模型 ID + 显示名，绝无「未知模型」）；拿不到 usage 时按字数估算并标 `estimated`。
6. 每聊 N 轮（默认 4，可在设置里改）用当前模型异步抽新记忆，写入前去重，失败不影响聊天。用户说「记住这个」会当场写成一条笔记。

## 测试

```bash
source .venv/bin/activate
python -m pytest
```

用 `httpx` 的 ASGI transport / TestClient 对应用做接口测试；模型调用走 `MSYQ_MOCK` 或 monkeypatch，不会访问外网。
覆盖：提示词拼装顺序、思考参数映射、400 去掉参数重试、错误分类、usage 汇总（含估算标记）、软遗忘、迁移幂等、Key 不会出现在 GET 响应里。

## 已知边界

- 单用户、单进程；没有 Postgres、向量库、任务队列。
- 世界书只做常开 / 关键词 + 简单预算，不做递归激活、概率 / 冷却、正则引擎。
- 不做群聊，也不在一场聊天中途换所属角色。
- 记忆搜索是 SQL `LIKE` 关键词 / 全文，不做语义检索。
- `MSYQ_MOCK` 只用于本地演示与测试，不要在有真实用户的环境里打开。
