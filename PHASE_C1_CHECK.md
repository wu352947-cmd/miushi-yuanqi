# PHASE C1 CHECK · 通透玻璃 + 网易云真实歌曲封面

在 A / A2 / B 的基础上继续做，没有推倒重来：布局、页面结构、底栏与「此刻」的约束保留；只改玻璃材质与歌单数据，`server/` 的接口约定没有改（只同步了种子记忆里的歌名文案）。
没有部署、没有 SSH、没有改任何远程服务器；仓库、文档、截图、日志里都没有真实 API Key。

## 零、结论

- 玻璃：四档 token（thin / regular / thick / float）全站统一，填充 0.07–0.21 白色、blur 10–14px + saturate 1.5–1.6，壁纸单独一层做轻提饱和 + 主题色薄雾。冰蓝 / 粉色、首页 / 聊天 / 记忆 / 一起听 / 我的 / 统计 / 角色库 / 设置 / 弹层 / 底栏全部改到。
- 对着 `ref/glass-target-our-tide.jpg` 逐项打分，最终一轮冰蓝首页 **5 / 5 / 4 / 5 / 4 / 4**、粉色首页 **4 / 4 / 4 / 5 / 4 / 4**，六项全部 ≥ 4。
- 歌单：10 首歌全部换成网易云上真实存在的歌，逐首核对 `id` 可查到、封面 300y300 与 120y120 都返回 **HTTP 200 + image/jpg**（见第二节）。
- 自检：`pytest` 48 passed；`node scripts/build.mjs` 通过（`dist/index.html` 1.90 MiB 单文件）；无头 Chrome 截图 **0 条 JS 报错**；底栏 / 爱心 / 「此刻」/ 封面兜底回归断言 19 / 19 通过。

## 一、玻璃：逐项要求 → 做法 → 是否通过

| # | 要求 | 做法 | 结果 |
| --- | --- | --- | --- |
| 1 | 卡片底色变薄，0.10–0.22 按类型取值 | 定义 `--glass-thin`（.12→.06）、`--glass-regular`（.16→.08）、`--glass-thick`（.21→.11）、`--glass-float`（.07→.03）四档填充；全站组件只引用 token，不再逐处写死 | ✅ 通过 |
| 2 | 模糊变轻 + 饱和度，透出主题色不是灰白 | `--blur-thin` = `blur(10px) saturate(1.5)`、`--blur-regular` = `blur(12px) saturate(1.55)`、`--blur-thick` = `blur(14px) saturate(1.6)`，均带极轻 `brightness(1.01)`；壁纸单独一层 `.view__wp` 做 `saturate(1.18) contrast(1.02)` + 主题色薄雾 | ✅ 通过 |
| 3 | 轮廓靠光不靠厚度 | 1px `rgba(255,255,255,.52)` 半透明边；`inset 0 1px 0 rgba(255,255,255,.62)` 顶部亮边 + `inset 0 -1px 0 rgba(255,255,255,.10)` 底部淡边；`inset 0 0 18px rgba(255,255,255,.10)` 极淡内阴影；外阴影只用 `0 16px 38px -26px` 的大扩散主题色投影（无灰圈） | ✅ 通过 |
| 4 | 顶部一条很淡的高光反射 | 写在填充 token 的第一个 `radial-gradient(170% 34%–40% at 50% -8%, …)`，只覆盖顶部，不额外加图层 | ✅ 通过 |
| 5 | 字清晰靠字本身 | 正文加深：粉 `#5A4550` / 冰蓝 `#3F5464`（对比度 6.4–8.1:1）；次要字 `#755F68` / `#647C8E`；小字加极淡白色 `text-shadow`（`--text-shadow / --text-shadow-strong`），不靠加厚卡片 | ✅ 通过 |
| 6 | 分档透明度 + 全站统一 token | 大信息卡（在一起 / 正在听 hero / 留言 / 弹层 / toast）用 thick；常规卡（记忆 / 我的 / 统计 / 角色库 / 气泡）用 regular；胶囊 / 时钟 / 小组件 / 输入框 / 按钮 / 底栏用 thin；图片卡 / 唱片外圈用 float；状态强调色（主按钮、选中 chip、禁用提供商）单独补回 | ✅ 通过 |
| 7 | 两套主题、所有页面、底栏 | 粉色蔷薇 / 冰蓝共用同一套 token 结构，只换色值；首页、聊天、记忆、一起听、我的、设置、角色库、统计、提供商、预设、各 sheet 与 toast 全部覆盖；底栏同为 thin，图标用 `--pink-deep` + 小字光晕保证清晰 | ✅ 通过 |
| 8 | 花哨壁纸单独处理 | 用 `.view[data-wp="…"]` 只对 wp01 / 02 / 04 / 05 / 07 / 10 / 14 / 15 这些密集壁纸把本页卡片提高一档（thin→regular、regular→thick），并加强文字光晕；不改全局 | ✅ 通过（见第五节） |
| 9 | 手机性能 | `backdrop-filter` 只在卡片本体；`sheet` 内部控件不再叠第二层模糊；模糊全部 ≤ 14px；动画仍只用 transform / opacity；低端（`deviceMemory ≤ 4` / `hardwareConcurrency ≤ 4` / `perf-lite`）与 `prefers-reduced-transparency: reduce` 下退回 0.80–0.82 半透明实底并去掉 blur | ✅ 通过（见第六节） |
| 10 | 不回退 | 底栏 66px、四图标齐平（误差 0）、记忆爱心 26×26 不跳不凸、「此刻」编辑按钮在正文下方文档流；回归断言 19 / 19 | ✅ 通过（见第七节） |

关键 token 实际计算值（无头 Chrome 读 `getComputedStyle`，见 `shots/phase-c1/_metrics.json`）：

- 大信息卡：radial-gradient(… rgba(252,254,255,.20) …) + linear-gradient(rgba(252,254,255,.21), rgba(250,253,255,.11))、blur(14px) saturate(1.6)、边框 rgba(255,255,255,.52)。
- 胶囊 / 时钟：radial … .16 + linear-gradient(… .12, … .06)、blur(10px) saturate(1.5)。
- 底栏：同一档 thin，66px 高。

## 二、网易云真实歌单与封面查证

查证接口（都从本机直接请求网易云公开接口）：

- 搜索：`https://music.163.com/api/search/get?s=<关键词>&type=1&limit=5`
- 详情：`https://music.163.com/api/song/detail/?id=<id>&ids=[<id>]`（取 songs[0].name / artists / duration / album.picUrl）
- 封面：对每个 picUrl + `?param=300y300`、`?param=120y120` 实际 GET，记录 HTTP 状态与 Content-Type。

| # | 歌名 | 歌手 | 专辑 | 时长 | 网易云 id | 封面 picUrl（p1/p2.music.126.net） | 详情 | 封面 300y300 | 封面 120y120 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 云烟成雨 | 房东的猫 | 云烟成雨 | 04:01 | 513360721 | https://p2.music.126.net/DSTg1dR7yKsyGq4IK3NL8A==/109951163046050093.jpg | 200 | 200 image/jpg | 200 |
| 2 | 秋酿 | 房东的猫 | 房东的猫 | 03:46 | 30635613 | https://p1.music.126.net/XSCmc9ZbWcpeizDya2g6JQ==/18598239185572641.jpg | 200 | 200 image/jpg | 200 |
| 3 | 走马 | 陈粒 | 如也 | 03:56 | 30431367 | https://p1.music.126.net/VuJFMbXzpAProbJPoXLv7g==/7721870161993398.jpg | 200 | 200 image/jpg | 200 |
| 4 | 你飞到城市另一边 | 好妹妹乐队 | 春生 | 05:47 | 26145723 | https://p2.music.126.net/-miwFGJUNbUoT6FOLBfjCg==/18568552371584657.jpg | 200 | 200 image/jpg | 200 |
| 5 | 水星记 | 郭顶 | 飞行器的执行周期 | 05:25 | 441491828 | https://p1.music.126.net/wSMfGvFzOAYRU_yVIfquAA==/2946691248081599.jpg | 200 | 200 image/jpg | 200 |
| 6 | 我想和你虚度时光 | 程璧/莫西子诗 | 我想和你虚度时光 | 08:30 | 30706318 | https://p1.music.126.net/beK0Y-4vgyZoIy21QFXC0A==/7696581394971660.jpg | 200 | 200 image/jpg | 200 |
| 7 | 理想三旬 | 陈鸿宇 | 浓烟下的诗歌电台 | 03:31 | 31445772 | https://p1.music.126.net/ryk8Gu64rOhlYn0pc2Q8Ww==/109951168090271827.jpg | 200 | 200 image/jpg | 200 |
| 8 | 儿时 | 刘昊霖 | 鱼干铺里 | 04:21 | 407761576 | https://p2.music.126.net/2q8ThUAEszBuxGlGJz8XUw==/17731824021476100.jpg | 200 | 200 image/jpg | 200 |
| 9 | 借我 | 谢春花 | 算云烟 | 04:17 | 408814900 | https://p2.music.126.net/Eg4cy0_HIF2nrX2gMCsWkQ==/17967119509636556.jpg | 200 | 200 image/jpg | 200 |
| 10 | 成都 | 赵雷 | 成都 | 05:28 | 436514312 | https://p2.music.126.net/57o5J3oaf1srPog40IU1Aw==/109951174184968965.jpg | 200 | 200 image/jpg | 200 |

查证原始结果另存：`shots/phase-c1/_netease-verify.json`（含每首的 duration 毫秒、封面字节数、两次封面请求状态）。

### 歌单分配（3 份，共 10 首）

- **雨天与旧信**（给福州入秋的雨）：云烟成雨 / 秋酿 / 走马 / 你飞到城市另一边
- **睡前很轻**（音量小一格）：水星记 / 我想和你虚度时光 / 理想三旬
- **那天的风**（十一月二日，平潭）：儿时 / 借我

### 显示方式

- 每首歌在 `src/data.js` 的 `playlists` 里记 `neteaseId`、`coverUrl`（原始 picUrl）、`album`、`dur`（秒，与网易云时长一致）。
- 显示时 coverUrl + `?param=300y300`（列表小图 `?param=120y120`），由手机直接从 `p1/p2.music.126.net` 加载；不经过本机后端，也没有把任何封面图打包进 `dist`（`build.mjs` 只内联 17 张壁纸）。
- 同源复用：唱片中心（`#recordCover`，86px 圆形专辑图）、正在听小卡（`#trackCover`）、歌单列表行（`.song-row__cover`）、首页「一起听」小卡（`#homeDiscCover`）都取当前曲目的同一张封面。
- 失败兜底：先用同一地址重试一次；仍然失败就把图片隐藏，露出主题同色的素色唱片 / 素色小方块（带中心小孔），不会出现破图标。音乐页、首页小卡、歌单 sheet 三处各有断言 / 截图。
- 文案同步：`src/data.js` 记忆 m4 标题改为「十一月二日，平潭」、m5 正文引用改为「《云烟成雨》」；歌单名「平潭的风（现场）」改为「那天的风」；首页默认歌名 / 歌手改为「云烟成雨 / 房东的猫」；`server/seed_data.json` 里同两条种子记忆同步改文案（后端是权威，否则接后端时会显示旧歌名）。
- `server/` 没有一起听 / 歌曲的数据结构或种子歌单，所以没有给后端加 `neteaseId / coverUrl` 字段、也没有加对应测试（按任务约定：没有就只改前端数据）；本轮不实现网易云播放、登录或版权接口。

## 三、对着参考图的六项打分（逐轮）

评分口径（1–5）：1 背景透视 / 2 玻璃薄度 / 3 边缘与高光 / 4 文字清晰 / 5 层次 / 6 整体美观与 ins 风。低于 4 即不合格。

### 第 1 轮（只改 token，未改壁纸层）

分数：**3 / 4 / 3 / 4 / 3 / 3**（冰蓝首页）。

发现的问题：

- 卡片顶部同时叠了 0.28 的径向高光 + 0.22 的线性填充，实际顶部白色接近 0.44，仍然像乳白塑料板。
- 壁纸雾化顶部 0.70 / 中部 0.08，把壁纸的主题色洗成灰白；17px 的模糊又把壁纸形状抹平了，玻璃后面没有东西可透。
- 小标签 / 歌词式小字在花纹壁纸上仍偏淡。
- 聊天气泡在密集壁纸上边界不清。

改法：

- 拆四档 token，把顶部径向高光降到 0.16–0.20 且只覆盖顶部 34–40%，线性填充改为 0.12 / 0.16 / 0.21。
- 模糊改为 10 / 12 / 14px，saturate 提到 1.5–1.6；壁纸雾化中部降到 0.03–0.04。
- 正文 / 次要文字颜色各加深一档，小字加极淡 text-shadow。
- 气泡单独补一档填充（regular + 自己的 --bubble-ai / --bubble-me）。

### 第 2 轮（加壁纸层与增色，仍用默认壁纸）

分数：**4 / 4 / 4 / 5 / 4 / 3**（冰蓝首页）。

发现的问题：

- 冰蓝首页默认壁纸 wp17 几乎是白色蕾丝，玻璃再薄也没有主题色可以透出来；画面像「更薄的灰白板」。
- 粉色首页 wp01 同理偏白。
- 文字已经清楚，但整体缺少参考图那种「透出背景主题色」的通透感。

改法：

- 壁纸单独抽成 `.view__wp` 一层：只对这一层做轻提饱和和主题色薄雾（multiply），玻璃卡采样它，不影响文字与布局。
- 冰蓝首页默认壁纸换成 wp09（水面波光，冰蓝可透出），粉色首页换成 wp03（粉白卧室，粉色可透出）；其余页壁纸分配不变。改动写进本文件与 README。
- 色值再校一次：正文粉 #5A4550 / 冰蓝 #3F5464，小字光晕加强。

### 第 3 轮（最终）

分数（冰蓝首页）：**5 / 5 / 4 / 5 / 4 / 4**；分数（粉色首页）：**4 / 4 / 4 / 5 / 4 / 4**。

发现的问题与改法（本轮内又修了 5 个细节）：

- 壁纸提饱和过高、冰蓝偏青，缺参考图的「淡」→ saturate 1.35 → 1.18，中部雾化补到 0.06–0.07。
- 分档规则把主按钮 / 选中 chip 的强调底覆盖了（角色库「新建角色」白字看不清）→ 在文件末尾单独补回 `.btn--primary / .lib-action--primary / .btn--soft / .btn--danger / .composer__send / .avatar--me / .stats-range button.is-on` 等状态色。
- 统计 / 角色库 / 设置这类浅色壁纸页背景仍偏灰白 → 在壁纸层给这些页加一档主题色 multiply 薄雾（0.26 → 0.10 → 0.26）。
- 唱片中心被 `data-nm="char"` 的换名逻辑覆盖，封面不显示 → 把换名标记移到兜底文字上，并把唱片中心放大到 86px 圆形封面。
- 歌单 sheet 里后几首封面因为 `loading="lazy"` 没有在截图前加载 → 列表小图改为直接加载，失败重试一次再兜底。

对比图路径（最终一轮）：

- 冰蓝首页 vs 参考图：`shots/phase-c1/compare-target-vs-ice-home.png`
- 粉色首页 vs 参考图：`shots/phase-c1/compare-target-vs-pink-home.png`
- 改前 vs 改后（冰蓝 / 粉色，用 `dist/index.before-phase-c1.html` 截的改前）：`shots/phase-c1/compare-before-after-ice-home.png`、`shots/phase-c1/compare-before-after-pink-home.png`

最终六项逐项说明：

1. **背景透视 5**：卡片后面的水面、云、光斑、壁纸花纹都能看见，蓝 / 粉主题色透得出来；参考图里海水、鱼、蝴蝶可见，我们的是水面与云，观感同级。
2. **玻璃薄度 5**：填充 0.12–0.21，一眼是薄玻璃，没有乳白塑料板感。
3. **边缘与高光 4**：1px 亮边 + 顶部高光 + 底部淡边都在，精致但比参考图的柔边略规整一档，所以 4 分。
4. **文字清晰 5**：主文字对比度 6.4–8.1:1，10–11px 小字也清楚；没有靠加厚卡片。
5. **层次 4**：大信息卡 / 常规卡 / 胶囊 / 图片卡有四档区分，但首页组件比参考图多，轻盈感略逊半档。
6. **整体美观与 ins 风 4**：素雅、低饱和、玻璃质感统一；比参考图更像「功能很多的手机桌面」，所以 4 分，不虚报 5。

## 四、每页六项自查（同一口径）

| 页面 | 主题 | 1 透视 | 2 薄度 | 3 边缘 | 4 文字 | 5 层次 | 6 整体 | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 首页 | 冰蓝 | 5 | 5 | 4 | 5 | 4 | 4 | 参考图主对比页 |
| 首页 | 粉色 | 4 | 4 | 4 | 5 | 4 | 4 | 粉白卧室壁纸，主题色可见但比冰蓝淡 |
| 聊天 | 冰蓝 | 4 | 4 | 4 | 5 | 4 | 4 | 气泡比卡片略实一档，长段文字清楚；壁纸星星可见 |
| 聊天 | 粉色 | 4 | 4 | 4 | 5 | 4 | 4 | 气泡边界与批注分隔线清楚 |
| 记忆 | 冰蓝 | 4 | 4 | 4 | 5 | 4 | 4 | 大玻璃列表卡 + 「此刻」thick 卡，壁纸结晶透出 |
| 记忆 | 粉色 | 4 | 4 | 4 | 5 | 4 | 4 | 密集壁纸 wp14 下文字仍清楚 |
| 一起听 | 冰蓝 | 5 | 5 | 4 | 5 | 4 | 4 | 唱片中心 / 正在听小卡 / 歌单行同一张网易云封面 |
| 一起听 | 粉色 | 4 | 4 | 4 | 5 | 4 | 4 | 同上 |
| 我的 | 冰蓝 | 4 | 4 | 4 | 5 | 4 | 4 | 情侣卡 / token 卡 / 入口大卡，壁纸星点透出 |
| 我的 | 粉色 | 4 | 4 | 4 | 5 | 4 | 4 | 两套主题同一套 token |
| 统计 | 冰蓝 | 4 | 4 | 4 | 5 | 4 | 4 | 信息密集页；壁纸层加一档主题色薄雾，表格数字清楚 |
| 统计 | 粉色 | 4 | 4 | 4 | 5 | 4 | 4 | 同上 |
| 角色库 | 冰蓝 | 4 | 4 | 4 | 5 | 4 | 4 | 卡片玻璃 + 主按钮强调色正常 |
| 角色库 | 粉色 | 4 | 4 | 4 | 5 | 4 | 4 | 同上 |
| 设置 | 冰蓝 | 4 | 4 | 4 | 5 | 4 | 4 | 设置行在大玻璃卡内，不逐行 blur |
| 设置 | 粉色 | 4 | 4 | 4 | 5 | 4 | 4 | 同上 |
| 弹层（歌单 sheet） | 冰蓝 | 4 | 4 | 4 | 5 | 4 | 4 | sheet 本体 thick，内部控件不叠模糊；10 张封面全部加载 |
| 弹层（歌单 sheet） | 粉色 | 4 | 4 | 4 | 5 | 4 | 4 | 同上 |
| 底栏 | 冰蓝 / 粉色 | 4 | 4 | 4 | 5 | 4 | 4 | 同为 thin 玻璃，图标用深主题色 + 小字光晕，清晰 |

结论：没有明显比首页差的页面；统计 / 角色库 / 设置这类浅色壁纸页通过「壁纸层主题色薄雾」拉齐到同一水准。

## 五、花哨壁纸（wp02 / wp14 等密集线稿）

- 用 `.view[data-wp="…"]` 精确命中 wp01 / 02 / 04 / 05 / 07 / 10 / 14 / 15：只在这些壁纸下把本页的小组件 / 胶囊提高一档 token（thin→regular），大卡 / 留言卡再提高一档（regular→更实的 thick），并把 label / poem / note-text 的光晕加强；全局仍然是薄的。
- 截图：`shots/phase-c1/pink-home-wp02.png`、`shots/phase-c1/pink-home-wp14.png`、`shots/phase-c1/ice-home-wp02.png`；拼图：`shots/phase-c1/_grid-dense-wallpapers.jpg`。
- 检查结果：wp02（蕾丝相框）与 wp14（粉白格纹小羊）下，正文、小标签、数字都清楚，同时壁纸花纹仍从卡片里透出来；没有为了这两张壁纸把其他页面加厚。

## 六、性能与低端降级

- `backdrop-filter` 只放在卡片本体：卡片 10–14px、气泡 10px、底栏 10px，全部 ≤ 14px；`sheet` 内部控件（field / option / btn / wp-page / attach-item 等）不再叠第二层模糊；列表统一包在一张大玻璃卡里。
- 壁纸只给当前页挂 `background-image`（仍按需加载），其余页只记 `data-wp`；壁纸层用 `transform: translateZ(0)` 独立合成，不触发整页重绘。
- 动画仍只用 `transform / opacity`；唱片 CSS 旋转、`prefers-reduced-motion` 下停止；时钟仍 rAF。
- 低端 / 减透明：`html.perf-lite` 或 `prefers-reduced-transparency: reduce` 下，`backdrop-filter: none` + 背景改为 `rgba(252,250,251,.80)` / ice `rgba(249,252,254,.82)`（仍是半透明，不是白板）。已用 `Emulation.setEmulatedMedia` 实测：卡片算得 `rgba(252, 250, 251, 0.8)`、blur `none`。
- 封面是 120 / 300px 小图，由网易云 CDN 直出，本机后端与 dist 都不增加体积；失败重试一次后兜底，不会卡住界面。

## 七、不回退检查（回归断言 19 / 19）

脚本：`node scripts/c1-regression-check.mjs`，结果存 `shots/phase-c1/_regression.json`。

| 检查 | 粉色 | 冰蓝 |
| --- | --- | --- |
| 底栏高度 66px | 66 ✅ | 66 ✅ |
| 四图标顶部齐平（误差 0） | 0 ✅ | 0 ✅ |
| 记忆爱心 26×26、不放大 | ✅ | ✅ |
| 底栏为低透明玻璃 token、blur 10px | ✅ | ✅ |
| 「此刻」编辑在正文下方文档流（position: relative） | ✅ | ✅ |
| 「此刻」编辑按钮在卡内、尺寸 46×26 | ✅ | ✅ |
| 卡片填充是两层渐变（含顶部高光） | ✅ | ✅ |
| 卡片模糊 10–18px 且带 saturate | ✅ | ✅ |
| 减透明时改半透明实底并去 blur | ✅ | ✅ |
| 封面加载失败时退素色唱片 / 素色小方块、不出现破图标（屏蔽网易云图片域名实测） | — | ✅ |

另：`shots/phase-c1/_metrics.json` 记录首页实测 —— 底栏 66px、四图标 spread 0、大卡 computed 填充 .21→.11 + blur(14px) saturate(1.6)、胶囊/时钟 .12→.06 + blur(10px) saturate(1.5)、封面 naturalWidth 120 / 300 均加载成功。

## 八、构建、测试、截图、改动

### 构建

    node scripts/build.mjs
    # dist/index.html 已生成
    #   壁纸：17 张，1279.5 KB base64
    #   CSS：179.6 KB · 数据：27.2 KB · 脚本：321.5 KB
    #   单文件合计：1908.5 KB（build 按字符计）· 实际文件 1,988,752 字节（约 1.90 MiB）

改前备份：`dist/index.before-phase-c1.html`（1,963,482 字节，开工前复制）。

### 后端测试

    source .venv/bin/activate && python -m pytest
    # 48 passed

没有改 `server/` 的接口与表结构；只同步了 `server/seed_data.json` 里两条种子记忆的旧歌名文案，pytest 未被改坏。

### 截图清单（`shots/phase-c1/`，共 27 张 PNG（含 4 张对比图）+ 3 张辅助拼图 + 3 份 JSON）

- 粉色：`pink-home`、`pink-chat`、`pink-memory`、`pink-listen`、`pink-me`、`pink-stats`、`pink-characters`、`pink-settings`、`pink-sheet-playlist`
- 冰蓝：`ice-home`、`ice-chat`、`ice-memory`、`ice-listen`、`ice-me`、`ice-stats`、`ice-characters`、`ice-settings`、`ice-sheet-playlist`
- 密集壁纸：`pink-home-wp02`、`pink-home-wp14`、`ice-home-wp02`
- 改前（`index.before-phase-c1.html`）：`before-pink-home`、`before-ice-home`
- 对比图：`compare-target-vs-ice-home.png`、`compare-target-vs-pink-home.png`、`compare-before-after-ice-home.png`、`compare-before-after-pink-home.png`；辅助拼图 `_grid-pink.jpg`、`_grid-ice.jpg`、`_grid-dense-wallpapers.jpg`
- 数据：`_metrics.json`、`_regression.json`、`_netease-verify.json`

截图说明：本机没有真实 API Key，截图在离线演示数据下拍摄；只隐藏了「连不上后端」这类只在无后端时出现的提示条与 toast，界面样式与接后端时一致。没有运行会清空 `shots/` 的旧脚本 `scripts/shoot.mjs`。

### 改动文件

- `src/liquid.css`：主题 token（文字色、四档玻璃、模糊 / 阴影 / 光晕 / 状态色）、壁纸雾化减淡、壁纸单独一层与主题色薄雾、全站分档覆盖、密集壁纸按 `data-wp` 提档、封面 / 唱片 / 歌单小图样式、减透明与 perf-lite 降级值。
- `src/index.html`：首页小卡与一起听页加封面元素（`#homeDiscCover`、`#recordCover`、`#trackCover`），默认歌名 / 歌手改为真实歌曲。
- `src/data.js`：3 份歌单换成 10 首网易云真实歌曲（`neteaseId / coverUrl / album / dur / note`），记忆 m4 / m5 文案同步。
- `src/app.js`：壁纸单独一层 + 主题色薄雾、封面 URL 规则（`?param=300y300 / 120y120`）、失败重试与素色唱片兜底、歌单行小封面渲染。
- `scripts/phase-c1-shots.mjs`：本阶段截图脚本（两套主题各页、密集壁纸、改前 / 改后）。
- `scripts/c1-regression-check.mjs`：底栏 / 爱心 / 「此刻」/ 减透明回归断言。
- `server/seed_data.json`：两条种子记忆的旧歌名文案同步（接口与表结构未动）。
- `README.md`：玻璃规范换成分档 token 版、默认壁纸表更新、新增「真实歌单与网易云封面」一节。
- `dist/index.before-phase-c1.html`、`dist/index.html`：备份与重新构建。
- 新增 `PHASE_C1_CHECK.md`（本文件）。

### 本轮没做

- 不实现网易云播放 / 登录 / 版权接口；不把音频或封面打包进 dist；不请求本机后端转封面。
- 不改 `server/` 的接口、表结构与前端契约；没有部署到任何服务器。
- 没有把任何真实 API Key 写进代码、文档、截图或日志。
