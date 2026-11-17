# PHASE A CHECK · 下一版静态样稿

只做方案第 6 节 A：角色库、用户设定库、世界书库，以及一场聊天 = 一个角色 + 一套用户设定的本地关系。
仍是不连模型的静态样稿，没有 FastAPI、没有部署、没有 SSH。

## 已完成

### 入口拆分
- 聊天顶栏左侧头像/名字只切换「正在和谁说话」：浅色玻璃层里是当前角色、其他角色（继续上次 / 还没有聊天）、管理角色，最下面单独一小段「这场聊天里的我」。不再打开角色 + 模型的混合弹层。
- 顶栏右侧模型胶囊只选模型（DeepSeek / 云雀 / 白露）。模型列表只在「模型」弹层和「我的 → 模型与额度」出现，不进角色库。
- 聊天页在顶栏下加了一条两个小胶囊：「我 · 芴」「书 · 旧城雨事」，一眼能看到这场聊天的用户设定和世界书，点开可换。
- 「我的」入口顺序：情侣卡（显示当前角色 与 当前用户设定）→ 角色库 → 用户设定 → 世界书 → 主题与壁纸 → 模型与额度 → 备份 → 设置。

### 三个库（都能列表 / 新建 / 编辑 / 删除，删除前确认）
- 角色库：玻璃大卡片列表；详情按字段分栏（头像、名字、她是谁、性格、情景，开场白与示例对话默认折叠）、挂了哪本世界书、默认用户设定、额外资料只显示「已收好」不展开；底部是「用她开始聊 / 回到和她的最近一场」。没有摊开系统提示、正则、深度注入。
- 用户设定：头像、称呼、一段说明，可设全局默认；详情里能改文字、换头像（图片头像），能看到「默认用在哪些角色上」；支持复制。
- 世界书：书名 + 条目数；详情是条目列表（标题、常开 / 关键词、是否启用）；点一条才在底部弹层编辑正文、关键词、常开、启用、顺序，手机一次只编辑一条。

### 绑定关系
- 一场聊天固定属于一个角色，换角色 = 离开这场聊天、进入那个角色的聊天；旧聊天归属不改写。
- 用户设定取用顺序：这场指定 > 该角色默认 > 全局默认（预置「芴」）。在聊天里换用户设定会明确问「只改这场 / 同时设为该角色以后的默认」，不做刷新就回去的隐式临时态。
- 世界书：全局一本 + 角色主书一本 + 这场聊天一本，生成时合并去重；界面能看到当前生效的是哪几本。样稿不真正注入提示词。
- 不做：把旧聊天改挂到另一个角色、用户设定再挂世界书、角色挂多本世界书。

### 导入 / 导出（全部在浏览器本地完成，走系统文件选择器）
- 角色导入：JSON 认 chara_card_v2 / v3、旧版扁平 v1、Pygmalion（char_name / char_persona / char_greeting / world_scenario / example_dialogue）；PNG 读 tEXt 的 ccv3（优先）或 chara，Base64 → JSON，成功后用这张图做头像；卡里带 character_book 时自动另存为一本世界书并挂到该角色，提示「已带入一本世界书」。
- 不认识的字段原样收进「额外资料」口袋，界面不展开；导出 JSON（v2）时一并带回。
- 角色导出：JSON（v2），界面上写明 PNG 导出稍后接后端。
- 失败提示：不是角色卡 / PNG 里没有资料 / 缺名字 / 同名替换或另存 / 文件打不开，都用方案第 4 节的短中文提示。
- 用户设定：应用内新建、编辑、复制；整包 JSON 导入导出（也认酒馆备份的 personas / persona_descriptions），不假装支持单卡 PNG。
- 世界书：导入导出酒馆世界书 JSON（entries），角色卡拆出的 character_book 数组也能转；Novel / Agnai / Risu / naidata PNG 提示「目前只能导入酒馆格式的世界书 JSON」；书名冲突问「替换 / 保留两本」。

### 数据与本地保存
- 全部存在 localStorage（`msyq.v2`）：characters / userPersonas / worldBooks / chats / currentCharacterId / 主题与壁纸等；刷新后仍在。旧 `msyq.v1` 的主题、记忆、设置会接过来。
- 内部字段按方案第 5 节：角色 name / description / personality / scenario / first_mes / mes_example / avatar / worldBookId / defaultPersonaId / extras；用户设定 name / description / avatar / is_default；世界书条目 title / content / keys / constant / enabled / order。
- 预置仍用缪诗、阿杞，外加用户设定「芴」；另放一位一句中性简介的虚构成年角色「林雾」展示导入后的样子。没有真实酒馆卡或截图正文。

### 质感与性能
- 新界面只用现有粉 / 冰蓝两套 token、玻璃卡片、大圆角；壁纸按页分配，仍按需加载，动画只用 transform / opacity。
- 底栏高度仍是 66px，page-scroll / composer-zone / toast 预留仍是 88px / 80px / 80px；爱心选中只换颜色和线宽，不凸起、不放大、不跳。
- 「此刻」卡片的「编辑」仍单独在正文下方，没有绝对定位、不挡字。

## 自查结果
- 构建：`node scripts/build.mjs` 通过，dist/index.html 单文件（壁纸、CSS、数据、脚本内联；没有把 ref/theme-assets 打进去，没有作者水印）。
- Headless Chrome 自查（390 × 844，粉 / 冰蓝各一套）：19 项截图态检查通过（角色切换层无模型、模型层无角色、换角色进入她的聊天、换设定只改「我」、坏文件提示、PNG 角色卡与卡内世界书、底栏齐平、爱心尺寸不变且不高于底栏顶、「此刻」编辑不挡字、刷新持久化、控制台无报错）。
- 功能自查 46 项通过：用户设定取用顺序、角色默认与聊天指定、世界书三处合并去重、各类导入失败提示、同名角色替换 / 另存、同名世界书替换 / 保留两本、v1 与 Pygmalion 字段映射、用户设定导入 / 复制 / 头像、新建 / 编辑 / 删除角色、新建 / 编辑 / 删除世界书与条目、「用她开始聊 / 回到最近一场」、导出 v2 JSON 结构与世界书 entries、导出文件名。
- 未运行 scripts/shoot.mjs（会清空 shots/ 且含过时断言）；截图见下。

## 截图（shots/phase-a/）
- 我的：pink-me-couple、pink-me-libraries、ice-me-couple、ice-me-libraries
- 角色库：characters-list、character-detail、character-detail-bind（粉 / 冰蓝）
- 用户设定：personas-list、persona-detail（粉）/ personas-list（冰蓝）
- 世界书：books-list、book-detail、entry-edit（粉 / 冰蓝）
- 聊天：chat-context、chat-char-switch、chat-model-only、chat-persona-switch、chat-persona-ask、chat-book、chat-qi（粉 / 冰蓝）
- 导入失败：pink-import-error
- 底栏与「此刻」：nav-chat、nav-memory、memory-now（粉 / 冰蓝）

## 改动文件
- src/data.js：三个库的预置数据与角色字段
- src/index.html：顶栏拆分、聊天「我 / 书」胶囊、我的页七个入口、三个库视图、文件选择器
- src/liquid.css：只追加 A 阶段玻璃风样式（既有行未动）
- src/app.js：本地库与绑定状态、三个库的列表 / 详情、聊天切换层、导入导出、确认删除
- dist/index.html：重新构建；开工前已备份为 dist/index.before-phase-a.html
- PHASE_A_CHECK.md：本文件

## 本阶段没做（按方案）
- 不接真实模型 / 不写 FastAPI / 不部署；世界书不真正注入提示词。
- PNG 角色卡导出（界面已写明稍后接后端）；向量检索、递归激活、概率 / 冷却、正则、深度注入、群聊、CharX / BYAF / YAML、Novel / Risu / Agnai 世界书转码。
