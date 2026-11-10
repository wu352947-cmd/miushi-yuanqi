# 缪诗鸳杞 · 角色、用户设定与世界书方案

本文只是实现方案，不改现在的第 4 轮样稿，也不部署。
对照的酒馆源码是本机已有的 SillyTavern **1.19.0**（提交 `06bde93`，原时间 2026-09-14 21:01 +0200，折合台北时间 **2026-09-15 03:01**）。只学机制，不搬它的后台界面，也不拷它的代码（酒馆是 AGPL-3.0）。

界面仍走缪诗鸳杞自己的苹果式玻璃风：少字、大卡片、手机上好点。

---

## 1. 要解决什么

第 4 轮样稿里，角色和模型挤在同一张「角色与模型」弹层里，只有两个假角色（缪诗、阿杞）。人设是「我的」里一段可改的文字，用户卡也是单张，没有库、没有新建、没有导入、没有和某次聊天绑在一起。世界书还没有。

芴指出的问题，正好是后面角色变多时会卡住的地方：

- 角色以后可能有十几个，不能和模型选择放在一起。
- 人设（角色）和用户设定要能各自管理、各自切换。
- 要能新建角色、新建用户设定。
- 要支持酒馆常见的 JSON / PNG 角色卡导入，以及角色和聊天的绑定。
- 世界书要有单独的管理页，并能挂到合适的地方。

其余功能（记忆深化、一起听增强等）可以以后再补。模型选择可以继续留在聊天页上，做成一个小控件。

---

## 2. 酒馆里这些功能实际上怎么做

下面只讲机制，不抄它密密麻麻的管理后台。

### 2.1 角色卡

酒馆把一张角色卡既当「这个人是谁」，也当头像文件。常见两种文件：

- **PNG 角色卡**：把角色资料写进图片的 `tEXt` 文字块里。先看 `ccv3`（角色卡 v3），没有再用 `chara`（角色卡 v2）。内容是 Base64 编码的 JSON。图片本身就是头像。
- **JSON 角色卡**：直接是一份 JSON。酒馆能认几种：带 `spec` 的 v2 / v3、旧版扁平 v1（有 `name`）、以及更老的 Pygmalion 记事本格式（`char_name` / `char_persona`）。另外还支持 YAML、CharX 压缩包、BYAF，那些先不学。

一份标准 v2 卡的核心字段大致是：名字、描述、性格、情景、开场白、示例对话，再加上作者备注、系统提示、历史后指令、备选开场白、标签，以及可选的**随卡附带的世界书**（`character_book`）。酒馆自己还会在卡里记「上次打开的是哪一场聊天」，但导出给别人时会把这个私人字段抹掉。

新建角色就是填这些字段，存成一张 PNG。导入时，如果卡里带着世界书，酒馆**不会自动当成正在使用的书**，而是提示你「要不要把卡里的世界书另存成一本独立的书，并挂到这个角色上」。

### 2.2 用户设定（Persona）

用户设定和角色卡不是同一套格式。酒馆里它主要是：

- 一张用户头像；
- 一个显示名；
- 一段「你是谁、希望对方怎么对待你」的说明；
- 可选：标题、这段说明插在提示词的什么位置、以及一本挂在这个用户设定上的世界书。

它**没有**像角色卡那样通行的「一张 PNG / 一份社区标准 JSON」单卡格式。酒馆提供的是整包备份：一份 JSON 里装着所有用户设定的名字、说明和默认项，头像文件另外存放。导入时按「已有的跳过、缺头像就补一张默认图」来合并。

绑定规则（打开一场聊天时，按这个顺序决定用哪一个用户设定）：

1. **这场聊天自己锁死的**（记在这场聊天的元数据里），优先级最高；
2. 否则看有没有用户设定**连接到当前角色**（一个用户设定可以连一个或多个角色；也可以规定一个角色同时只连一个用户设定）；
3. 再不行，用**全局默认用户设定**。

如果当前选的用户设定，既不是这场聊天锁死的、也不是默认的，酒馆会把它当成「临时用一下」，刷新后可能改回去。另外有一个「选了就自动锁到这场聊天」的开关。这些层次对手机上的日常使用偏绕，后面会收成更简单的默认。

### 2.3 角色和聊天怎么绑

在酒馆里，**一场聊天属于一个角色**，不是先有一场独立聊天再随便换角色。

聊天文件放在「这个角色」自己的文件夹里。角色记录上会记住「上次打开的是哪一场」。打开角色，就打开那场最近的聊天；没有聊天时，用角色卡的开场白开一场新的。聊天文件第一行是元数据（这份聊天用了哪个用户设定、挂了哪本世界书等），后面才是一句句对话。

所以「角色绑定」在酒馆里几乎是物理归属：这场聊天就在这个角色名下。要把一场旧聊天换到另一个角色，并不是一等功能。缪诗鸳杞也按这个理解来：一场聊天对应一个角色；要换角色，通常是去那个角色下面开或继续另一场聊天。

### 2.4 世界书（酒馆叫 World Info / Lorebook）

世界书是独立的 JSON 文件，可以单独建、单独导入导出，不必写死在某张角色卡里。一本世界书里有很多条目。每条至少有：正文、触发关键词、是否常开、是否启用、插入顺序。酒馆还叠了很多高级选项（递归激活、概率、冷却、分组计分、向量化条目等），v1 不必照搬。

一本世界书可以被挂在好几个地方，生成时会把这些来源合在一起（同一本不重复算）：

| 挂在哪里 | 酒馆怎么记 | 一本还是多本 |
| --- | --- | --- |
| 全局（所有聊天都生效） | 一份「当前选中的全局书」列表 | 可多本 |
| 角色的主书 | 角色卡扩展字段里的一个书名 | 一本 |
| 角色的附加书 | 另存的一份「某角色还有哪些额外的书」 | 可多本 |
| 这一场聊天 | 聊天元数据里的一个书名 | 一本 |
| 当前用户设定 | 用户设定上的一个书名 | 一本 |

角色卡里自带的 `character_book` 要先「导入成独立书并挂上」，才会真正参与生成。生成时，酒馆会扫最近几句对话（默认深度 2），常开条目一律带上，关键词命中的条目再带上，并按预算限制总长度。插入位置可在角色描述前/后，或插进对话某一深度。聊天挂的书、用户设定挂的书，会排在角色书和全局书前面。

对缪诗鸳杞来说，这一套完整功能偏重。v1 建议只留下「独立管理 + 三种挂法 + 常开/关键词」这一层，见第 5 节。

---

## 3. 缪诗鸳杞里怎么放

原则：模型是聊天时的小选择；角色、用户设定、世界书都是可以长期管理的库。界面继续用玻璃卡片和底部弹层，不要做成酒馆那样一屏幕参数。

### 3.1 从哪里进

| 功能 | 从哪进 | 说明 |
| --- | --- | --- |
| 角色库 | 「我的」里把现在的「人设」改成「角色库」 | 这是管理入口：列表、新建、导入、编辑某张卡 |
| 当前角色 | 聊天顶栏左侧头像和名字 | 只用来切换「这场聊天在和谁说话」，以及「管理角色」跳进角色库。不再打开模型和角色的混合弹层 |
| 用户设定库 | 「我的」里把现在的「用户卡」改成「用户设定」 | 列表、新建、编辑、设为默认 |
| 这场聊天的用户设定 | 聊天页一个轻入口（例如顶栏自己的小头像，或角色切换层里的第二段） | 为这场聊天换一个「我是谁」，不要和角色库混在一页里 |
| 世界书库 | 「我的」新增一行「世界书」 | 独立列表：新建、导入、导出、编辑条目 |
| 把书挂到角色 / 聊天 | 角色详情里「挂一本世界书」；聊天的角色切换层或聊天菜单里「这场聊天的世界书」 | 先选已有的书，不要在挂接时跳进密密的条目编辑 |
| 模型 | 聊天顶栏右侧现有的模型胶囊 | 只选模型。额度仍走「我的 → 模型与额度」 |

现在的入口，方便对照以后改样稿时动手的位置（先改方案，这一轮不改文件）：

- 聊天顶栏角色按钮、模型胶囊：`src/index.html` 的 `data-open="model"`，逻辑在 `src/app.js` 的 `SHEETS.model` / `selectCharacter`。
- 「我的」人设、用户卡：`src/index.html` 里 `data-open="persona"`、`data-open="userCard"`。
- 假数据角色列表：`src/data.js` 的 `characters`。

「我的」页列表建议变成：角色库、用户设定、世界书、主题与壁纸、模型与额度、备份、设置。情侣卡仍可显示「当前角色 与 当前用户设定」。

### 3.2 几个主要界面（都用自己的玻璃风）

**角色库**：大卡片列表，头像、名字、一行简介、最近聊过的提示。顶部是「导入」和「新建」。点进某张卡，是一张详情页：头像、名字、她是谁（描述）、性格、情景、开场白、示例对话（后两项可先折起来）、挂了哪本世界书、默认用哪套用户设定。底部是「用她开始聊」或「回到和她的最近一场」。不要把系统提示、正则、深度注入这些专业项在 v1 摊开。

**用户设定库**：同样是卡片列表。每套设定有头像、称呼、一段说明。可以设一枚「默认」。点进后能改文字、换头像，并看到「默认用在哪些角色上」。

**世界书库**：书的列表，每本显示名字和条目数。点进是条目列表：标题、是常开还是关键词、是否启用。点一条再编辑正文和关键词。手机上一次只编辑一条，不要表格丛林。

**聊天里切换**：点顶栏角色名，弹出浅色玻璃层：当前角色、可换到的其他角色（每项带一句「继续上次」或「还没有聊天」）、最下面「管理角色」。用户设定用单独一小段或二次入口切换，避免和角色抢同一屏。换角色＝离开这场聊天、进入那个角色的聊天；换用户设定＝这场聊天还在，只是「我」换成另一套。

### 3.3 和聊天的绑定（给缪诗鸳杞的简单默认）

一场聊天固定是：**一个角色 + 一套用户设定**。模型另外选，不参与这份绑定。

用户设定怎么决定：

1. 这场聊天如果指定了用户设定，就用它；
2. 否则用这个角色的「默认用户设定」；
3. 再否则用全局默认用户设定（例如先做一套「芴」）。

在角色详情里可以把某套用户设定设成这个角色的默认。在聊天里换用户设定时，明确问一句：只改这场，还是同时设成这个角色以后的默认。不要做酒馆那种「临时设定、刷新就回去」的隐式状态，手机上不容易看懂。

换角色不会改写旧聊天的归属。旧聊天仍属于原来的角色，可以在角色详情里看到历史聊天列表（v1 先做「每个角色至少一场最近聊天」，完整列表可以跟在后面）。

世界书怎么挂，见第 5 节：角色一本、聊天一本、可选的全局一本。生成时合并，不重复。

---

## 4. 导入导出

### 4.1 角色

**v1 要支持导入：**

- `.json`：角色卡 v2（`spec: "chara_card_v2"`）、v3（`spec: "chara_card_v3"`）、旧版 v1（有 `name` 和描述等扁平字段）。若遇到 Pygmalion 的 `char_name`，也可以转成同一套内部字段。
- `.png`：从图片文字块里读 `ccv3` 或 `chara`，再按上面的 JSON 规则解析。成功后用这张图做头像。

**v1 要支持导出：**

- JSON（按 v2 写出，兼容面最广）；
- PNG（把 v2 JSON 写进 `chara` 块；若实现成本不高，可同时写一份 `ccv3`，与酒馆现行写出方式一致）。

导入时只取我们认识的字段。不认识的扩展（别人软件加的正则、画图提示、外部编号等）先原样收在一个「额外资料」口袋里，不要丢，也不要在界面上展开。若卡里带了 `character_book`，自动另存为一本世界书并挂到这个角色上，用一句轻提示告诉用户「已带入一本世界书」，而不是弹出复杂对话框。

**失败时怎么说（短、能看懂）：**

- 不是 JSON，或 JSON 坏了：「这不是一份能读的角色卡文件。」
- PNG 里没有角色资料：「这张图里没有角色卡信息，也许只是一张普通图片。」
- 没有名字：「读到了文件，但缺少角色名字。」
- 已有同名角色：「已经有一位叫××的角色。要替换，还是另外保存？」
- 文件太大或图片损坏：「文件打不开，换一份再试试。」

手机上用系统文件选择器选文件即可。样稿阶段也可以先做这个，不必等服务器。

### 4.2 用户设定

不以「社区角色卡」的方式传播，所以 v1 做两件事就够：

- 应用内新建 / 编辑 / 复制；
- 可选：导入、导出一份「全部用户设定」的 JSON（结构对标酒馆备份：名字、说明、默认项）。头像能带上就带，带不上就提示「文字已导入，头像请再选一张」。

不假装支持「酒馆用户设定 PNG 单卡」，因为酒馆本身也没有这种通行单卡。

### 4.3 世界书

**v1 要支持：** 酒馆自己的世界书 JSON（有 `entries`）。导出也用这个结构，方便和酒馆来回带。

若文件是角色卡里拆出来的 `character_book`（条目是数组，字段名是 `keys` / `insertion_order` 等），导入时转成我们的内部条目。Novel、Agnai、Risu 的世界书，以及带 `naidata` 的 PNG，v1 可以先不支持；碰到时提示「目前只能导入酒馆格式的世界书 JSON」。

失败提示同样要短：不是世界书、没有条目、书名冲突时问「替换还是保留两本」。

---

## 5. 建议的数据关系

```text
角色 1 —— n 聊天
角色 1 —— 0..1 默认用户设定
角色 1 —— 0..1 主世界书

用户设定 n —— 被选为若干角色的默认
用户设定 1 —— 0..1 也可在某一场聊天里被指定

聊天 1 —— 1 角色（必有，不可空）
聊天 1 —— 0..1 用户设定（有则覆盖角色默认）
聊天 1 —— 0..1 世界书（只对这场生效）
聊天 1 —— 1 当前模型（只是生成时用，不是绑定的一部分）

世界书 1 —— 可被：全局 / 某角色 / 某聊天 引用
             （同一本可以被多处引用，生成时去重）
```

打开一场聊天时：

- 角色：就是这场聊天所属的那位；
- 用户设定：聊天指定 > 角色默认 > 全局默认；
- 世界书：全局（若启用）+ 角色主书 + 这场聊天的书，合并后按规则注入。

角色卡字段在内部建议拆成可编辑的几项，不要只存一整段「人设」文本：`name`、`description`、`personality`、`scenario`、`first_mes`、`mes_example`，以及可选的 `system_prompt`、`creator_notes`、`alternate_greetings`、`avatar`、`default_user_persona_id`、`world_book_id`。和现在「我的 → 人设」那一整段文字相比，这才是以后能导入酒馆卡的结构。

用户设定内部：`name`、`description`、`avatar`、`is_default`。v1 不必做「插入深度 / 角色」这类位置选项，统一放进提示词里的「用户资料」段即可。

世界书条目 v1 只保留：`title`（或备注）、`content`、`keys`（关键词列表）、`constant`（常开）、`enabled`、`order`。其余酒馆字段导入时可以收下，界面先不展示。

和先前总报告里的表草案的关系：那份草案把 AI 人设和用户资料都放在一张 `persona` 表里（用 `kind` 区分）。现在建议拆开：`characters`、`user_personas`、`world_books`、`world_book_entries`，并在 `conversations` 上增加 `character_id`、`user_persona_id`、`world_book_id`。这不是推翻记忆和现在卡的方案，只是把「人设」从单行文本升级成可管理的库。

生成提示词时（等后端再真正做），静态前缀仍是：角色描述 / 性格 / 情景、用户设定、钉住的记忆；世界书按常开 + 关键词激活、再加 token 预算，插在角色描述附近。不在 v1 做向量检索世界书。

---

## 6. 分阶段

### A. 下一版静态样稿（仍不接模型、不部署）

可以先让人在手机上把流程走通，数据放在浏览器 `localStorage`（或样稿自己的本地状态）里：

- 把「角色与模型」拆开：模型胶囊只选模型；顶栏头像/名字改走角色切换。
- 「我的」增加角色库、用户设定库、世界书库三个入口；能新建、编辑、删除（删除前确认）。
- 角色详情按字段分栏，不再是一段无法导入的整文。
- 能从手机导入 JSON / PNG 角色卡，以及世界书 JSON；失败时用上面那些短提示。
- 一场样稿聊天能看到：当前角色、当前用户设定、挂了哪本世界书；能切换。
- 换角色时进入该角色的样稿对话（可用假开场白）；换用户设定只改「我」这边。
- 预置仍用现有的成人占位：缪诗、阿杞，以及一套用户设定「芴」。若要展示「导入后的样子」，只用一句中性简介的虚构成人角色，不使用任何真实酒馆卡或截图里的正文。

这一阶段还不必真的把世界书注入模型——样稿本来就不连模型。只要界面和本地数据关系是对的。

### B. 等 VPS 上的 FastAPI + SQLite

- 上述实体落到 SQLite，以后端为权威。
- 导入导出改为经后端解析，尤其是 PNG 写出、大文件、和以后的备份。
- 真正聊天时：按角色字段 + 用户设定 + 世界书（常开 / 关键词，扫最近若干轮，做简单预算）拼提示词。
- 每个角色记住最近一场聊天；角色详情可列出该角色下的聊天。
- 导出角色卡 PNG / JSON、导出世界书 JSON，方便和酒馆互带。

样稿里走通的信息架构，后端按同一套关系实现即可，不必再发明第三套入口。

---

## 7. 明确不做的

- 不把酒馆的密集后台（大表格、几十个条目开关、Power User 抽屉）搬进缪诗鸳杞。
- v1 不做世界书的向量检索、递归激活、概率/冷却/延迟、分组计分、正则引擎。
- v1 不做 Postgres、向量库、知识图谱、本地大模型、3D。
- v1 不导入 CharX、BYAF、YAML 角色卡，也不做 Novel / Risu / Agnai 世界书转码（以后需要再加）。
- v1 不做群聊、不做一场聊天中途更换所属角色（避免把两个人的记忆搅在一起）。
- v1 不在用户设定上再挂世界书，也不做「角色附加多本世界书」；先保持三种挂法：全局、角色一本、聊天一本。
- 不把模型列表放进角色库。
- 不在 v1 做 jailbreak 块、深度注入编辑器、角色正则脚本。
- 不复制酒馆或用户截图里的真实角色/用户正文。

---

## 8. 技术附录

供以后实现时对照。路径均相对于本机副本 `/workspace/oss-study/SillyTavern`。版本：package.json `1.19.0`，HEAD `06bde93`。

### 8.1 关键源码路径

| 主题 | 路径 | 作用 |
| --- | --- | --- |
| PNG 读写 | `src/character-card-parser.js` | `read()` 优先 `ccv3`，否则 `chara`；均为 tEXt + Base64。`write()` 先去掉旧块，写入 `chara`，并尝试再写一块把 `spec` 改成 `chara_card_v3` 的 `ccv3`（见下方注意） |
| PNG 组包 | `src/png/encode.js` | 把 chunk 重新封成 PNG |
| v2 类型 | `src/types/spec-v2.d.ts` | `TavernCardV2`、`CharacterBook`、`CharacterBookEntry` |
| 前端字段注释 | `public/scripts/char-data.js` | v1 / v2 运行时字段，含酒馆私有的 `chat`、`avatar`、`json_data` |
| 角色 API | `src/endpoints/characters.js` | `/create` `/edit` `/import` `/export` `/chats` `/delete` `/duplicate` 等。`importFromJson` / `importFromPng` / `charaFormatData` / `convertWorldInfoToCharacterBook` / `unsetPrivateFields` |
| 角色导入格式分流 | 同上，`/import` | 扩展名：`yaml`/`yml`、`json`、`png`、`charx`、`byaf` |
| 用户设定 | `public/scripts/personas.js` | 锁定、连接、默认项、打开聊天时的选择顺序、整包备份与恢复 |
| 用户头像 API | `src/endpoints/avatars.js` | `/get` `/upload` `/delete`，不是「用户设定卡」解析器 |
| 聊天 API | `src/endpoints/chats.js` | 文件位于 `directories.chats/<角色PNG去扩展名>/<聊天名>.jsonl` |
| 聊天读写 | `public/script.js` 中 `saveChat` / `getChat` | 首行是 `ChatHeader`（`chat_metadata`），其后才是消息；角色上的 `.chat` 是最近一场的文件名 |
| 世界书 API | `src/endpoints/worldinfo.js` | `/list` `/get` `/import` `/edit` `/delete`；导入要求对象含 `entries` |
| 世界书前端 | `public/scripts/world-info.js` | 挂接、扫描、预算、条目定义、角色卡内嵌书的导入、外部格式转换 |
| CharX（v1 不做） | `src/charx.js` | v3 风格的 zip + `data.assets` |
| BYAF（v1 不做） | `src/byaf.js` | 另一种打包导入 |

### 8.2 角色卡字段

v2 JSON 外形：

```text
{
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: {
    name, description, personality, scenario, first_mes, mes_example,
    creator_notes, system_prompt, post_history_instructions,
    alternate_greetings: string[],
    character_book?: CharacterBook,
    tags: string[], creator, character_version,
    extensions: { talkativeness, fav, world, depth_prompt, regex_scripts, ... }
  }
}
```

v1 扁平字段（导入时要认）：`name`、`description`、`personality`、`scenario`、`first_mes`、`mes_example`、`creatorcomment` / `creator_notes`、`tags`。Pygmalion：`char_name`、`char_persona`（→ description）、`char_greeting`（→ first_mes）、`example_dialogue`（→ mes_example）、`world_scenario`（→ scenario）。

酒馆写入新卡时，会同时写一份顶层 v1 字段和 `data.*` 的 v2 字段（`charaFormatData`）。导出 JSON 走 v2，并调用 `unsetPrivateFields`：去掉 `chat`，把 `fav` 置为 false。

`data.extensions.world` 是角色主世界书的**书名**。卡内嵌的书在 `data.character_book`。

### 8.3 PNG 解析要点

1. 用 PNG chunk 提取所有 `tEXt`。
2. 关键字大小写不敏感，先找 `ccv3`，再找 `chara`。
3. 文本是 Base64，解码得到 UTF-8 JSON 字符串，再 `JSON.parse`。
4. 若 `spec` 存在，按 v2/v3 `data` 读取（酒馆的 `readFromV2` 会把 `data.*` 同步回顶层字段）。
5. 若无 `spec` 但有 `name`，按 v1 再升级为 v2。
6. 写出时至少写 `chara`。酒馆现行 `write()` 还会尝试附加 `ccv3`：把同一份 JSON 里的 `spec` 改成 `chara_card_v3`、`spec_version` 改成 `3.0`。**这并不是完整的 v3 规范转换**（没有单独的 v3 类型定义文件）。实现我们自己的导出时：读要兼容两种块；写以 v2 + `chara` 为必做，`ccv3` 为可选兼容。

注意：`character-card-parser.js` 文件头注释曾写 “Writes only 'chara', 'ccv3' is not supported”，但紧接着的实现还是会尝试写 `ccv3`。以代码为准。

### 8.4 用户设定：结构与绑定

标识符是头像文件名（如 `foo.png`），不是独立 UUID。

存在设置里，而不是独立角色卡目录：

```text
power_user.personas[avatarId] = 显示名
power_user.default_persona = avatarId | null
power_user.persona_descriptions[avatarId] = {
  description,          // 说明正文
  position,             // 0 IN_PROMPT（常用）；1 AFTER_CHAR 已废弃，会被改成 0；还有 TOP_AN / BOTTOM_AN / AT_DEPTH / NONE
  depth, role,          // 仅 AT_DEPTH 时有意义
  lorebook,             // 挂在这套设定上的世界书名
  connections: [{ type: "character"|"group", id: 角色avatar或群id }],
  title
}
chat_metadata.persona = avatarId   // 这场聊天锁死的用户设定
```

打开聊天时的选择顺序见 `loadPersonaForCurrentChat()`（约 1543–1666 行）：聊天锁 → 角色连接（多个且允许一对多时会弹窗选）→ 默认设定。备份文件由 `onBackupPersonas()` 写出：

```text
{ personas, persona_descriptions, default_persona }
```

恢复时已存在的键跳过，缺头像则上传默认图。

建议缪诗鸳杞不要用文件名当主键，改用自己的 id；导入酒馆备份时再把旧键记在一个外部对照里。

### 8.5 聊天文件与角色归属

- 目录：`chats/<avatar 去掉 .png>/<file_name>.jsonl`。
- 角色对象上的 `chat` 是最近打开的 `file_name`（无扩展名），属于酒馆私有字段，导出卡时会删掉。
- 保存时消息数组前面会再加一行头：`{ chat_metadata, user_name: "unused", character_name: "unused" }`。`chat_metadata` 里与本方案有关的键：`persona`、`world_info`（世界书名，常量 `METADATA_KEY`）、`integrity`、`timedWorldInfo`。
- `GET /api/chats/get` 用 `avatar_url` + `file_name` 定位，不靠聊天自己再记一遍角色 id——归属就是目录。

### 8.6 世界书字段与挂接

酒馆磁盘上的书：`{ name?, entries: { [uid]: entry }, extensions? }`。条目模板见 `newWorldInfoEntryDefinition`（`world-info.js` 约 4082 行）。v1 实现至少要能读：

```text
uid, key[], keysecondary[], comment, content,
constant, selective, order, position, disable
```

角色卡内嵌书（`CharacterBookEntry`）字段名不同：`keys`、`secondary_keys`、`insertion_order`、`enabled`、`position: "before_char"|"after_char"`。转换函数是 `convertCharacterBook()`。

挂接实现位置：

- 全局：`selected_world_info[]`，并写入设置里的 `world_info.globalSelect`。
- 角色主书：`characters[i].data.extensions.world`。
- 角色附加书：`world_info.charLore[] = { name: 角色文件名, extraBooks: string[] }`。
- 聊天：`chat_metadata.world_info`。
- 用户设定：`persona_descriptions[id].lorebook`。

合并顺序在 `getSortedEntries()`：先聊天书、再用户设定书，然后按策略排列角色书与全局书（默认角色优先）。重复的书名会被跳过。扫描默认深度 `world_info_depth = 2`，预算 `world_info_budget = 25`（与上下文上限配合，大于 100 会被重置为 25，按百分比使用），另有 `world_info_budget_cap`。常开（`constant`）与关键词触发是最基本的两种激活方式。

世界书导入前端还会认：`lorebookVersion`（Novel）、`kind === "memory"`（Agnai）、`type === "risu"`，以及 PNG 的 `naidata`。后端 `/import` 只要求解析后的对象有 `entries`。

插入位置枚举 `world_info_position`：`before=0`、`after=1`、`ANTop=2`、`ANBottom=3`、`atDepth=4`、`EMTop=5`、`EMBottom=6`、`outlet=7`。v1 只需支持「角色描述前 / 后」，默认「后」或随卡带来的值。

### 8.7 以后后端可以怎么拆（仅备忘，现在不实现）

轻量 FastAPI + SQLite，不必引入新的数据库种类。建议表：`characters`、`user_personas`、`world_books`、`world_book_entries`，并扩展已有的 `conversations`（`character_id` 必填，`user_persona_id` / `world_book_id` 可空）。头像以文件或独立附件表存放。导入导出做成 `/characters/import`、`/characters/export`、`/world-books/import` 这类端点，PNG 解析逻辑自己写，不要拷酒馆源码。

静态样稿阶段：在 `src/data.js` / `app.js` 增加本地集合与 `localStorage` 键，把现在的 `state.persona` 整段文字和 `state.model.character` 字符串，升级成 id 引用。入口改动见 3.1。

### 8.8 对照时需留意的含糊点

1. **v3 支持是「能读、写出较简化」**：读优先 `ccv3`；写只是把同一份对象改名成 `chara_card_v3`，仓库里没有完整 v3 类型定义。CharX 才是更完整的 v3 资源包，v1 不做。
2. **用户设定没有社区单卡标准**，只有整包设置备份。文档或社区若笼统说「导入用户设定卡」，需要和角色卡 PNG 区分开。
3. **卡内嵌世界书不会自动激活**，除非导入并写入 `extensions.world`。缪诗鸳杞建议导入角色卡时直接帮用户做完这一步，并给一句提示。
4. **`world_info_budget = 25` 的单位容易误解**：代码把它限制在 100 以内，按上下文百分比用；另有封顶 `world_info_budget_cap`。我们自己实现时用「最多 N 字或 N token」这种更直白的上限即可。
5. **聊天换角色不是一等能力**；归属在目录层。若以后要「把这场对话交给另一个角色」，应做成显式复制，而不是改挂同一份记录。
6. **本结论针对 1.19.0 / `06bde93`**。酒馆若以后改 v3 写出或绑定顺序，需要重新对照这两处文件：`src/character-card-parser.js`、`public/scripts/personas.js` 里的 `loadPersonaForCurrentChat`。

---

文档结束。实现前若样稿信息架构有改动，以这一份关系模型为准，再更新入口文案即可。
