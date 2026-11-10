# 第三方声明（THIRD_PARTY_NOTICES）

缪诗鸳杞样稿的界面、文案、角色与壁纸均为项目自己的内容。下面只列出本阶段实际引入的第三方资源。

## 1. 提供商 / 模型官方图标

- 包名：`@lobehub/icons-static-svg`
- 版本：1.102.0（本阶段安装时 npm 上的当前版本）
- 来源：<https://github.com/lobehub/lobe-icons>
- 许可证：MIT
- 用途：在「模型与提供商」页、模型编辑页、模型选择弹层里显示各家模型的官方图标。

本阶段只把实际用到的 18 个 SVG 从包里复制到 `src/icons/`，构建时由 `scripts/build.mjs` 内联进单文件 `dist/index.html`；**没有把整个图标包或其 `node_modules` 打进 dist**。

实际复制的文件：

| 文件 | 图标 |
| --- | --- |
| `deepseek-color.svg` | DeepSeek |
| `openai.svg` | OpenAI |
| `claude-color.svg` | Claude |
| `anthropic.svg` | Anthropic |
| `gemini-color.svg` | Gemini |
| `google-color.svg` | Google |
| `openrouter-color.svg` | OpenRouter |
| `siliconcloud-color.svg` | SiliconCloud / 硅基流动 |
| `qwen-color.svg` | Qwen |
| `kimi-color.svg` | Kimi |
| `moonshot.svg` | Moonshot |
| `zhipu-color.svg` | 智谱 |
| `doubao-color.svg` | 豆包 |
| `bytedance-color.svg` | ByteDance |
| `volcengine-color.svg` | 火山引擎 |
| `grok.svg` | Grok / xAI |
| `mistral-color.svg` | Mistral |
| `meta-color.svg` | Meta |

构建时对 SVG 做的唯一改动：去掉 `<title>`（避免重复可读文本）、去掉固定的 `width/height="1em"` 与内联 `style`（尺寸交给 CSS），压缩空白。图形本身未改动。

MIT 许可证允许免费使用、复制、修改、合并、发布、分发、再许可和/或销售软件的副本，前提是保留版权声明与许可声明。原始版权归 lobehub / 各图标作者所有。各模型与公司的名称、商标归各自权利人所有，这里仅用于在界面上标识对应的提供商与模型。

## 2. 没有引入的东西

- 没有引入图表库：统计页的热力图、柱状图、排行条、余额卡全部用纯 SVG / CSS 手写。
- 没有引入 UI 框架、字体文件或图标字体；正文继续使用系统字体栈。
- 没有把 SillyTavern 或任何参考 App 的代码、截图、文案拷进项目。提示词预设的「导入酒馆 JSON」只按公开的字段结构读数据，不包含酒馆源码。
- 参考截图（`ref/user-feedback-r6/`）只用于理解信息结构，没有出现在 `dist/` 或交付截图里。

## 3. 壁纸与图片

`assets/wallpapers-720/` 下的 17 张壁纸沿用项目此前整理/提供的素材，未在本阶段新增第三方图片。
