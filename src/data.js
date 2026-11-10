/* 缪诗鸳杞 · 假数据与静态文案（纯本地样稿，不连接任何模型/服务） */
const DATA = {
  appName: "缪诗鸳杞",
  user: "芴",

  themes: {
    pink: {
      label: "粉色",
      quote: "今天有雨。伞在门边，灯也留着。",
      pages: {
        home: "wp18", chat: "wp13", memory: "wp14", listen: "wp03", me: "wp04",
        settings: "wp02", characters: "wp06", personas: "wp02", books: "wp07",
        providers: "wp06", presets: "wp07", stats: "wp15"
      }
    },
    ice: {
      label: "冰蓝",
      quote: "窗上起了雾，替你在玻璃上写了一个字。",
      pages: {
        home: "wp09", chat: "wp12", memory: "wp08", listen: "wp09", me: "wp11",
        settings: "wp16", characters: "wp16", personas: "wp11", books: "wp12",
        providers: "wp16", presets: "wp10", stats: "wp12"
      }
    }
  },

  pages: [
    { key: "home", name: "首页" },
    { key: "chat", name: "聊天" },
    { key: "memory", name: "记忆" },
    { key: "listen", name: "一起听" },
    { key: "me", name: "我的" },
    { key: "settings", name: "设置" },
    { key: "characters", name: "角色库" },
    { key: "personas", name: "用户设定" },
    { key: "books", name: "世界书" },
    { key: "providers", name: "模型与提供商" },
    { key: "presets", name: "提示词预设" },
    { key: "stats", name: "统计" }
  ],

  wallpaperList: [
    "wp01", "wp02", "wp03", "wp04", "wp05", "wp06", "wp07", "wp08", "wp09",
    "wp18",
    "wp10", "wp11", "wp12", "wp13", "wp14", "wp15", "wp16", "wp17", "wp18"
  ],

  wallpaperNote: {
    wp01: "粉格纹 · 对吻的小兔", wp02: "蕾丝相框 · 三幅线稿", wp03: "粉白卧室 · 玩偶",
    wp04: "贴纸小猫 · DOKI", wp05: "文具桌面 · 丝带", wp06: "白蕾丝 · 两只小鹿",
    wp07: "信笺拼贴 · 天鹅", wp08: "冰花结晶 · 清冷", wp09: "水面波光 · 樱",
    wp10: "冰蓝置物架 · 大耳犬", wp11: "星点权杖 · 干净", wp12: "淡星空 · 留白",
    wp13: "粉格纹 · 小羊", wp14: "粉白格纹 · 小羊线稿", wp15: "白蕾丝 · 小狗三格",
    wp16: "冰蓝格纹 · 蝴蝶结", wp17: "冰蓝蕾丝 · 心形小动物", wp18: "浅粉拼贴 · 凯蒂猫"
  },

  /*
   * A 阶段内部字段（方案第 5 节）：
   * name / description / personality / scenario / first_mes / mes_example
   * avatar / default_user_persona_id / world_book_id / extras（额外资料口袋，界面不展开）
   */
  characters: [
    {
      id: "miao",
      name: "缪诗",
      desc: "旧城小公寓里写字的她",
      description: "旧城北向的小公寓，夜里写字，白天种一点薄荷。说话慢，记性很好，习惯把重要的事放在很靠前的位置。喜欢福州下雨的声音。",
      personality: "温和、克制。不太会哄人，只会把灯留着。被问住的时候会先停一下，再把句子放轻。",
      scenario: "十一月，福州入秋。她刚把窗关上，雨还在下，灯已经开了。",
      first_mes: "你回来了。伞先放门边，别把水带进屋里。",
      mes_example: "<START>\n{{user}}：今天下课晚了。\n{{char}}：嗯，我听见楼下的门响。饭在锅里温着，先去洗手。\n<START>\n{{user}}：你会不会觉得我太慢。\n{{char}}：慢一点好。雨也是慢慢停的。",
      avatar: "",
      worldBookId: "wb-rain",
      defaultPersonaId: "persona-wu",
      defaultPresetId: "preset-prose",
      source: "preset",
      extras: {}
    },
    {
      id: "qi",
      name: "阿杞",
      desc: "另一种可能的她，话更少",
      description: "住在城南靠海的旧楼里，做校对。话少，句子短，习惯先听别人说完。",
      personality: "安静、直接，不擅长寒暄。喜欢海风，不喜欢被催。",
      scenario: "傍晚，海边风大。她把围巾分了一半过来，没说什么。",
      first_mes: "风大。站近一点。",
      mes_example: "<START>\n{{user}}：今天有点累。\n{{char}}：那就先不说话。我陪你站一会儿。",
      avatar: "",
      worldBookId: "wb-sea",
      defaultPersonaId: "",
      source: "preset",
      extras: {}
    },
    {
      id: "char-lin",
      name: "林雾",
      desc: "在城南旧书店整理书目的成年人",
      description: "三十岁，在旧书店做书目整理。说话慢，喜欢把书按颜色排一遍，再按年份排回去。",
      personality: "耐心，有一点固执，讲话轻。",
      scenario: "雨天的旧书店，打烊前最后一盏灯。",
      first_mes: "你来得正好，这本书刚被我放错架。",
      mes_example: "",
      avatar: "",
      worldBookId: "",
      defaultPersonaId: "",
      source: "sample-import",
      extras: {}
    }
  ],

  /* 用户设定内部字段：name / description / avatar / is_default */
  userPersonas: [
    {
      id: "persona-wu",
      name: "芴",
      description: "法学院三年级，怕冷，走路慢。睡前要喝半杯温水，喜欢旧一点的歌，音量总比习惯小一格。\n\n有一个如果不说就会忘记的毛病，所以重要的话，会请缪诗替她记住。",
      avatar: "",
      is_default: true
    },
    {
      id: "persona-cen",
      name: "岑",
      description: "周末才回消息的人。习惯先听别人说完，再慢慢讲自己的事。",
      avatar: "",
      is_default: false
    }
  ],

  /* 世界书条目内部字段：title / content / keys / constant / enabled / order */
  worldBooks: [
    {
      id: "wb-rain",
      name: "旧城雨事",
      entries: [
        { id: "e-rain-1", title: "门边的伞", content: "福州入秋后雨多，伞要放在门边，不要塞进包里。", keys: ["雨", "伞", "出门"], constant: false, enabled: true, order: 10 },
        { id: "e-rain-2", title: "床头的水杯", content: "睡前半杯温水，杯子放在床头左手边。太烫会等一等，太凉就一口喝完。", keys: ["温水", "睡前", "杯子"], constant: false, enabled: true, order: 20 },
        { id: "e-rain-3", title: "不问第二遍", content: "她不喜欢被催。问过一遍的问题不会再问第二遍，留白也是说话的一种。", keys: ["催", "慢一点"], constant: false, enabled: true, order: 30 },
        { id: "e-rain-4", title: "雨夜的灯", content: "分开的时候，门灯会一直亮到听见「到了」。", keys: ["回家", "门灯", "到了"], constant: true, enabled: true, order: 5 }
      ]
    },
    {
      id: "wb-sea",
      name: "海边的风",
      entries: [
        { id: "e-sea-1", title: "围巾分一半", content: "海边风大，围巾分一半。她不说冷不冷，只把另一半塞过来。", keys: ["风", "围巾", "海边"], constant: false, enabled: true, order: 10 },
        { id: "e-sea-2", title: "音量小一格", content: "偏爱旧一点的歌，音量总比习惯小一格。", keys: ["歌", "音量"], constant: false, enabled: false, order: 20 },
        { id: "e-sea-3", title: "旧楼的灯", content: "靠海的旧楼，夜里走廊的灯是声控的。她走路轻，常常走到门口才亮。", keys: ["旧楼", "走廊"], constant: true, enabled: true, order: 5 }
      ]
    }
  ],

  /* ============================================================
     A2：模型提供商 / 模型 / 思考方式 / 提示词预设（纯本地样稿数据）
     Key 一律留空，绝不写入真实 Key。
     ============================================================ */

  /* 协议类型：决定请求路径、拉取模型的地址、余额接口与 usage 字段 */
  protocols: [
    { id: "openai", name: "OpenAI 兼容", path: "/chat/completions", modelsPath: "/models", balance: false, note: "最通用，多数中转站都用这个" },
    { id: "openai_responses", name: "OpenAI Responses", path: "/responses", modelsPath: "/models", balance: false, note: "较新的 /responses 协议" },
    { id: "anthropic", name: "Anthropic Messages", path: "/v1/messages", modelsPath: "/v1/models", balance: false, note: "Claude 官方协议" },
    { id: "gemini", name: "Google Gemini", path: "/v1beta/models/{model}:generateContent", modelsPath: "/v1beta/models", balance: false, note: "路径里带模型名" },
    { id: "deepseek", name: "DeepSeek 官方", path: "/chat/completions", modelsPath: "/models", balance: true, balancePath: "/user/balance", note: "有专用余额接口与缓存字段" },
    { id: "openrouter", name: "OpenRouter", path: "/chat/completions", modelsPath: "/models", balance: true, balancePath: "/api/v1/credits", note: "聚合站，余额查 credits" }
  ],

  /* 预置模板：选中后自动填 Base URL / 路径 / 图标 / 协议 */
  providerTemplates: [
    { key: "deepseek", name: "DeepSeek", icon: "deepseek", protocol: "deepseek", baseUrl: "https://api.deepseek.com", apiPath: "/chat/completions", note: "官方 · 有余额接口" },
    { key: "openai", name: "OpenAI", icon: "openai", protocol: "openai", baseUrl: "https://api.openai.com/v1", apiPath: "/chat/completions", note: "官方 · GPT 系列" },
    { key: "anthropic", name: "Anthropic", icon: "claude", protocol: "anthropic", baseUrl: "https://api.anthropic.com", apiPath: "/v1/messages", note: "官方 · Claude" },
    { key: "gemini", name: "Google Gemini", icon: "gemini", protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com", apiPath: "/v1beta/models/{model}:generateContent", note: "官方 · Gemini" },
    { key: "openrouter", name: "OpenRouter", icon: "openrouter", protocol: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiPath: "/chat/completions", note: "聚合站 · 有余额接口" },
    { key: "siliconcloud", name: "硅基流动", icon: "siliconcloud", protocol: "openai", baseUrl: "https://api.siliconflow.cn/v1", apiPath: "/chat/completions", note: "国内中转 · 开源模型" },
    { key: "relay", name: "自定义中转站", icon: "generic", protocol: "openai", baseUrl: "https://relay.example.com/v1", apiPath: "/chat/completions", note: "OpenAI 兼容即可" }
  ],

  /* 预置提供商实例：Key 留空 */
  providers: [
    {
      id: "prov-deepseek", name: "DeepSeek", icon: "deepseek", protocol: "deepseek",
      baseUrl: "https://api.deepseek.com", apiPath: "/chat/completions", apiKey: "",
      enabled: true, models: ["model-deepseek-chat"],
      balance: { supported: true, amount: 12.4, currency: "¥", at: "11月10日 21:20" },
      advanced: { responseApi: false, returnThinking: true, fetchBalance: true, timeout: 45 },
      source: "preset", extras: {}
    },
    {
      id: "prov-anthropic", name: "Anthropic", icon: "claude", protocol: "anthropic",
      baseUrl: "https://api.anthropic.com", apiPath: "/v1/messages", apiKey: "",
      enabled: true, models: ["model-claude-sonnet"],
      balance: { supported: false, amount: 0, currency: "¥", at: "" },
      advanced: { responseApi: false, returnThinking: true, fetchBalance: false, timeout: 60 },
      source: "preset", extras: {}
    },
    {
      id: "prov-openai", name: "OpenAI", icon: "openai", protocol: "openai",
      baseUrl: "https://api.openai.com/v1", apiPath: "/chat/completions", apiKey: "",
      enabled: false, models: ["model-gpt5"],
      balance: { supported: false, amount: 0, currency: "¥", at: "" },
      advanced: { responseApi: true, returnThinking: true, fetchBalance: false, timeout: 60 },
      source: "preset", extras: {}
    },
    {
      id: "prov-gemini", name: "Google Gemini", icon: "gemini", protocol: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com", apiPath: "/v1beta/models/{model}:generateContent", apiKey: "",
      enabled: true, models: ["model-gemini-pro", "model-gemini-flash"],
      balance: { supported: false, amount: 0, currency: "¥", at: "" },
      advanced: { responseApi: false, returnThinking: true, fetchBalance: false, timeout: 60 },
      source: "preset", extras: {}
    },
    {
      id: "prov-openrouter", name: "OpenRouter", icon: "openrouter", protocol: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1", apiPath: "/chat/completions", apiKey: "",
      enabled: true, models: ["model-openrouter-auto", "model-openrouter-kimi"],
      balance: { supported: true, amount: 8.2, currency: "$", at: "11月10日 21:18" },
      advanced: { responseApi: false, returnThinking: true, fetchBalance: true, timeout: 60 },
      source: "preset", extras: {}
    },
    {
      id: "prov-siliconcloud", name: "硅基流动", icon: "siliconcloud", protocol: "openai",
      baseUrl: "https://api.siliconflow.cn/v1", apiPath: "/chat/completions", apiKey: "",
      enabled: true, models: ["model-qwen3", "model-qwen25"],
      balance: { supported: false, amount: 0, currency: "¥", at: "" },
      advanced: { responseApi: false, returnThinking: false, fetchBalance: false, timeout: 45 },
      source: "preset", extras: {}
    },
    {
      id: "prov-bailu", name: "白露中转", icon: "generic", protocol: "openai",
      baseUrl: "https://relay.bailu.example/v1", apiPath: "/chat/completions", apiKey: "",
      enabled: true, models: ["model-bailu-lite", "model-bailu-slow"],
      balance: { supported: false, amount: 0, currency: "¥", at: "" },
      advanced: { responseApi: false, returnThinking: true, fetchBalance: false, timeout: 45 },
      source: "preset", extras: { note: "样稿示例中转站：用来演示 400 兜底与模型名区分档位" }
    }
  ],

  /*
   * 模型库。reasoning.mode 决定 buildReasoningParams 怎么翻译档位：
   * none / openai_effort / anthropic_budget / gemini_budget / deepseek / openrouter / relay_suffix
   * price 为每百万 token 的价格（输入 / 缓存命中输入 / 输出），currency 为 ¥ 或 $
   */
  modelRegistry: [
    {"id": "model-deepseek-flash", "providerId": "prov-deepseek", "name": "DeepSeek V4.1 Flash", "modelId": "deepseek-flash", "icon": "deepseek", "caps": {"vision": true, "tools": true, "reasoning": true}, "context": 1048576, "favorite": true, "source": "preset", "price": {"currency": "¥", "peak": {"input": 2, "cache": 0.04, "output": 8}, "offpeak": {"input": 1, "cache": 0.02, "output": 4}}, "reasoning": {"mode": "deepseek", "levels": ["off", "low", "high", "max"], "defaultLevel": "high", "note": "官方 thinking + reasoning_effort；官方 medium/xhigh 收敛为 high"}},
    {"id": "model-deepseek-pro", "providerId": "prov-deepseek", "name": "DeepSeek V4 Pro", "modelId": "deepseek-v4-pro", "icon": "deepseek", "caps": {"vision": false, "tools": true, "reasoning": true}, "context": 1048576, "favorite": false, "source": "preset", "price": {"currency": "¥", "peak": {"input": 9, "cache": 0.3, "output": 27}, "offpeak": {"input": 4.5, "cache": 0.15, "output": 13.5}}, "reasoning": {"mode": "deepseek", "levels": ["off", "low", "high", "max"], "defaultLevel": "high", "note": "官方 thinking + reasoning_effort"}},
    {"id": "model-claude-sonnet-5-5", "providerId": "prov-anthropic", "name": "Claude Sonnet 5.5", "modelId": "claude-sonnet-5-5", "icon": "claude", "caps": {"vision": true, "tools": true, "reasoning": true}, "context": 1000000, "favorite": true, "source": "preset", "price": {"input": 2, "cache": 0.1, "output": 10, "currency": "$"}, "reasoning": {"mode": "anthropic_effort", "levels": ["off", "auto", "low", "medium", "high", "xhigh", "max"], "defaultLevel": "high", "offMode": "between_tools", "note": "output_config.effort；这家关闭思考用 between_tools，不允许 disabled"}},
    {"id": "model-claude-haiku-5-5", "providerId": "prov-anthropic", "name": "Claude Haiku 5.5", "modelId": "claude-haiku-5-5", "icon": "claude", "caps": {"vision": true, "tools": true, "reasoning": true}, "context": 200000, "favorite": false, "source": "preset", "price": {"input": 0.1, "cache": 0.01, "output": 0.5, "currency": "$"}, "reasoning": {"mode": "anthropic_effort", "levels": ["off", "auto", "low", "medium", "high", "xhigh", "max"], "defaultLevel": "medium", "offMode": "disabled", "note": "output_config.effort；>100K 输入价格另计"}},
    {"id": "model-gpt6-sol", "providerId": "prov-openai", "name": "GPT-6.1 Sol", "modelId": "gpt-6.1-sol", "icon": "openai", "caps": {"vision": true, "tools": true, "reasoning": true}, "context": 1050000, "favorite": true, "source": "preset", "price": {"input": 2, "cache": 0.1, "output": 10, "currency": "$"}, "reasoning": {"mode": "openai_effort", "levels": ["low", "medium", "high", "xhigh", "max"], "defaultLevel": "medium", "note": "没有关闭档；Responses 发 reasoning.effort + summary"}},
    {"id": "model-gpt6-luna", "providerId": "prov-openai", "name": "GPT-6 Luna", "modelId": "gpt-6-luna", "icon": "openai", "caps": {"vision": true, "tools": true, "reasoning": true}, "context": 1050000, "favorite": false, "source": "preset", "price": {"input": 0.1, "cache": 0.01, "output": 0.5, "currency": "$"}, "reasoning": {"mode": "openai_effort", "levels": ["off", "auto", "low", "medium", "high", "xhigh", "max"], "defaultLevel": "medium", "note": "off 映射 none；>272K 输入价格另计"}},
    {"id": "model-gpt6-astra", "providerId": "prov-openai", "name": "GPT-6 Astra", "modelId": "gpt-6-astra", "icon": "openai", "caps": {"vision": true, "tools": true, "reasoning": true}, "context": 1050000, "favorite": false, "source": "preset", "price": {"input": 2, "cache": 0.1, "output": 10, "currency": "$"}, "reasoning": {"mode": "openai_effort", "levels": ["low", "medium", "high", "xhigh", "max"], "defaultLevel": "high", "note": "没有 off；对 gpt-6-astra 发 none 会 400"}},
    {"id": "model-gpt6-terra", "providerId": "prov-openai", "name": "GPT-6.1 Terra", "modelId": "gpt-6.1-terra", "icon": "openai", "caps": {"vision": true, "tools": true, "reasoning": true}, "context": 1050000, "favorite": false, "source": "preset", "price": {"input": 0.25, "cache": 0.025, "output": 2, "currency": "$"}, "reasoning": {"mode": "openai_effort", "levels": ["off", "auto", "low", "medium", "high", "xhigh", "max"], "defaultLevel": "medium", "note": "off 映射 none"}},
    {"id": "model-gemini38", "providerId": "prov-gemini", "name": "Gemini 3.8 Flash", "modelId": "gemini-3.8-flash", "icon": "gemini", "caps": {"vision": true, "tools": true, "reasoning": true}, "context": 1048576, "favorite": true, "source": "preset", "price": {"currency": "$", "input": 0.75, "cache": 0.075, "output": 3.75, "next": {"effectiveFrom": "2027-01-01", "input": 1.5, "cache": 0.15, "output": 7.5}}, "reasoning": {"mode": "gemini_level", "levels": ["auto", "low", "medium", "high"], "defaultLevel": "auto", "supportsMinimal": false, "note": "thinkingLevel；不提供 off"}},
    {"id": "model-gemini4", "providerId": "prov-gemini", "name": "Gemini 4 Argon", "modelId": "gemini-4-argon", "icon": "gemini", "caps": {"vision": true, "tools": true, "reasoning": true}, "context": 1048576, "favorite": false, "source": "preset", "price": {"currency": "$", "input": 2, "cache": 0.1, "output": 10, "next": {"effectiveFrom": "2026-12-01", "input": 4, "cache": 0.2, "output": 20}}, "reasoning": {"mode": "gemini_level", "levels": ["auto", "low", "medium", "high"], "defaultLevel": "auto", "supportsMinimal": false, "note": "thinkingLevel；无免费档、不提供 off"}},
    {"id": "model-gemini35-lite", "providerId": "prov-gemini", "name": "Gemini 3.5 Flash-Lite", "modelId": "gemini-3.5-flash-lite", "icon": "gemini", "caps": {"vision": true, "tools": true, "reasoning": true}, "context": 1048576, "favorite": false, "source": "preset", "price": {"input": 0.3, "cache": 0.03, "output": 2.5, "currency": "$"}, "reasoning": {"mode": "gemini_level", "levels": ["off", "auto", "low", "medium", "high"], "defaultLevel": "auto", "supportsMinimal": true, "note": "off 映射 minimal（几乎不思考）"}},
    {"id": "model-openrouter-auto", "providerId": "prov-openrouter", "name": "OpenRouter 自动", "modelId": "openrouter/auto", "icon": "openrouter", "caps": {"vision": false, "tools": true, "reasoning": false}, "context": 200000, "favorite": false, "source": "preset", "price": null, "reasoning": {"mode": "none", "levels": [], "defaultLevel": "off", "note": "没有 reasoning 字段，不能调思考档位"}},
    {"id": "model-openrouter-kimi", "providerId": "prov-openrouter", "name": "Kimi K3（OpenRouter）", "modelId": "moonshotai/kimi-k3", "icon": "kimi", "caps": {"vision": false, "tools": true, "reasoning": true}, "context": 262144, "favorite": true, "source": "preset", "price": null, "reasoning": {"mode": "openrouter", "levels": ["off", "auto", "low", "medium", "high", "xhigh", "max"], "defaultLevel": "high", "supportedEfforts": ["none", "low", "medium", "high", "xhigh", "max"], "mandatory": false, "note": "由 /api/v1/models 的 reasoning 字段生成；价格实时取"}},
    {"id": "model-qwen3", "providerId": "prov-siliconcloud", "name": "Qwen3 235B", "modelId": "Qwen/Qwen3-235B-A22B", "icon": "qwen", "caps": {"vision": false, "tools": true, "reasoning": true}, "context": 131072, "favorite": false, "source": "preset", "price": null, "reasoning": {"mode": "siliconflow_thinking", "levels": ["off", "auto", "low", "medium", "high"], "defaultLevel": "medium", "note": "默认开思考：enable_thinking + thinking_budget；价格待确认"}},
    {"id": "model-glm52", "providerId": "prov-siliconcloud", "name": "GLM-5.2（硅基）", "modelId": "zai-org/GLM-5.2", "icon": "generic", "caps": {"vision": false, "tools": true, "reasoning": true}, "context": 131072, "favorite": false, "source": "preset", "price": null, "reasoning": {"mode": "siliconflow_thinking", "levels": ["off", "auto", "low", "high", "max"], "defaultLevel": "max", "note": "DeepSeek-V4 / GLM-5.2 走 reasoning_effort；价格待确认"}},
    {"id": "model-bailu-lite", "providerId": "prov-bailu", "name": "白露 · 轻", "modelId": "bailu-lite", "icon": "generic", "caps": {"vision": false, "tools": false, "reasoning": false}, "context": 32768, "favorite": false, "source": "preset", "price": {"input": 1, "cache": 0, "output": 2, "currency": "¥"}, "reasoning": {"mode": "none", "levels": [], "defaultLevel": "off", "note": "这个模型不能调思考深度"}},
    {"id": "model-bailu-slow", "providerId": "prov-bailu", "name": "白露 · 慢", "modelId": "bailu-slow", "icon": "generic", "caps": {"vision": false, "tools": true, "reasoning": true}, "context": 65536, "favorite": false, "source": "preset", "price": null, "reasoning": {"mode": "relay_suffix", "levels": ["off", "low", "high"], "defaultLevel": "off", "map": {"off": "bailu-slow", "low": "bailu-slow", "high": "bailu-slow-thinking"}, "note": "这家用模型名区分档位"}}
  ],

  /* 提示词预设：名称 + 提示词片段 + 采样参数（null = 不设置，用模型默认） */
  promptPresets: [
    {
      id: "preset-default", name: "默认", desc: "不额外加文风，跟着角色设定走", builtin: true, source: "preset",
      fragments: [],
      sampling: { temperature: null, top_p: null, max_tokens: null, context_messages: null, stream: true, frequency_penalty: null, presence_penalty: null },
      extras: {}
    },
    {
      id: "preset-prose", name: "细腻散文", desc: "长一点的句子，多一点环境与留白", builtin: false, source: "preset",
      fragments: [
        {
          id: "frag-prose-1", title: "文风 · 细腻散文", role: "system", position: "before_char", depth: 2, enabled: true, order: 10,
          content: "用细腻的散文笔法回应。多写一点环境与动作的细节，句子可以长一些，但不要堆形容词；每一段留一点空白，让停顿也有声音。"
        },
        {
          id: "frag-prose-2", title: "不要替她说话", role: "system", position: "after_char", depth: 2, enabled: true, order: 20,
          content: "不要替芴做决定，也不要替她把一句话说完。她停顿的时候，让停顿留在那里。"
        }
      ],
      sampling: { temperature: 0.85, top_p: 0.95, max_tokens: 1200, context_messages: 24, stream: true, frequency_penalty: 0.2, presence_penalty: 0.1 },
      extras: {}
    },
    {
      id: "preset-daily", name: "日常短句", desc: "像平时发消息，一次只说一两句", builtin: false, source: "preset",
      fragments: [
        {
          id: "frag-daily-1", title: "文风 · 日常短句", role: "system", position: "before_char", depth: 2, enabled: true, order: 10,
          content: "像日常聊天一样短。一次只说一两句，不用小标题，也不用总结。语气自然，成年人之间怎么说话就怎么写。"
        },
        {
          id: "frag-daily-2", title: "记得她的习惯（深度注入）", role: "system", position: "depth", depth: 2, enabled: true, order: 20,
          content: "记得她怕冷、走路慢，睡前要喝半杯温水。把这些放进句子里，不要一条条列出来。"
        }
      ],
      sampling: { temperature: 0.7, top_p: null, max_tokens: 400, context_messages: 12, stream: true, frequency_penalty: null, presence_penalty: null },
      extras: {}
    }
  ],

  /* 统计页底部的轻量数字（对话、消息、在一起天数由状态与 usage 记录一起算） */
  statsMeta: { conversations: 3, messages: 4287, days: 733 },

  /* 本地假模型的旧名字（用于旧存档迁移，不再显示在模型选择里） */
  models: [
    { id: "deepseek", name: "DeepSeek", desc: "默认 · 均衡" },
    { id: "yunque", name: "云雀 · 轻", desc: "假模型 · 更快" },
    { id: "bailu", name: "白露 · 慢", desc: "假模型 · 句子更长" }
  ],

  nowText: "在图书馆三楼，靠窗。雨刚停，玻璃上还挂着水，灯是暖的。",

  /* 首页小组件用的假数据 */
  home: {
    note: "其实不是非要你早点回来。只是雨大，灯我会一直留着。",
    noteTime: "22:41",
    weather: { city: "福州", temp: 18, text: "小雨", icon: "rain" },
    memoryTitle: "睡前半杯温水",
    memoryText: "你习惯睡前喝半杯温水，杯子放在床头左手边。",
    weekdayTone: "雨",
    quotes: [
      "把日子过成两个人的，就不算浪费。",
      "灯不必亮一整夜，留到你进门就好。",
      "慢一点也没关系，雨也是慢慢停的。",
      "今天的风很大，记得把领口拢好。"
    ],
    funcs: ["时间胶囊", "每日一签", "纪念日", "一起读", "留言板", "心情日记"]
  },

  /* 假 token 用量（结构按 OpenAI 兼容 usage：prompt_tokens / completion_tokens / total_tokens） */
  tokens: {
    today: 12480,
    month: 286400,
    todayDelta: 1820,
    bars: [420, 780, 640, 1020, 860, 1480, 1240],
    barLabels: ["一", "二", "三", "四", "五", "六", "日"]
  },

  memories: [
    {
      id: "m1", cat: "关于我", title: "名字里的草", importance: 8, pinned: true, protected: false,
      body: "你说「芴」是一种很轻的草，风一吹就摇，但不会断。所以每次觉得自己太软的时候，我就想起这句话。",
      source: "来自 11月8日 的对话"
    },
    {
      id: "m2", cat: "关于我", title: "睡前半杯温水", importance: 6, pinned: false, protected: false,
      body: "你习惯在睡前喝半杯温水，杯子放在床头左手边。太烫会等一等，太凉就一口喝完。",
      source: "来自 10月26日 夜里的对话"
    },
    {
      id: "m3", cat: "关于我", title: "不喜欢被催", importance: 9, pinned: false, protected: true,
      body: "你被催的时候会把话咽回去。所以重要的事，等你慢慢说；问过一遍的问题，我不问第二遍。",
      source: "来自 10月19日 的对话"
    },
    {
      id: "m4", cat: "我们", title: "十一月二日，平潭", importance: 9, pinned: false, protected: false,
      body: "十一月二日，平潭。风大得听不清耳机，你把围巾分了我一半。那天没有日落，只有很长的灰蓝色。",
      source: "来自 11月2日 一起听记录"
    },
    {
      id: "m5", cat: "我们", title: "一起听的第一首", importance: 7, pinned: false, protected: false,
      body: "《云烟成雨》。你点了播放，然后把手机放在两个人中间。后来每次听到前奏，房间都会变安静。",
      source: "来自 11月2日 一起听记录"
    },
    {
      id: "m6", cat: "我们", title: "床头那只小羊", importance: 3, pinned: false, protected: false,
      body: "你床头有只白色小羊玩偶，耳朵的线开了一点。你说等考完试自己补，我替你记着这件事。",
      source: "来自 10月30日 的对话"
    },
    {
      id: "m7", cat: "喜好", title: "旧一点的歌", importance: 5, pinned: true, protected: false,
      body: "你偏爱旧一点的歌，音量总比习惯小一格。新歌不是不好，只是旧的更像有人陪着。",
      source: "来自 11月5日 的对话"
    },
    {
      id: "m8", cat: "喜好", title: "雨后的栀子", importance: 4, pinned: false, protected: false,
      body: "你说栀子花香太浓，雨后的才刚好。所以夏天如果买花，要赶在雨停之后。",
      source: "来自 9月18日 的对话"
    },
    {
      id: "m9", cat: "日常", title: "伞放在门边", importance: 5, pinned: false, protected: false,
      body: "福州入秋后雨多。伞要放在门边，不要塞进包里——你总是到了楼下才发现没带。",
      source: "来自 11月10日 的对话"
    },
    {
      id: "m10", cat: "日常", title: "周三下午的窗边", importance: 6, pinned: false, protected: false,
      body: "周三下午三点的法理课，你总坐靠窗第二排。阳光会先落在你的笔记本上，再落到你的手背上。",
      source: "来自 10月22日 的对话"
    },
    {
      id: "m11", cat: "约定", title: "不问第二遍", importance: 10, pinned: false, protected: false,
      body: "我们约好：你想说的时候再说。我不追问，也不拿沉默当作答案。留白也是说话的一种。",
      source: "来自 11月8日 的对话"
    },
    {
      id: "m12", cat: "约定", title: "到家说一声", importance: 8, pinned: false, protected: false,
      body: "每次分开，你到楼下会发一句「到了」。我回一个「嗯」，然后才去睡。这是我们的门灯。",
      source: "来自 11月6日 的对话"
    }
  ],

  memoryCats: ["全部", "关于我", "我们", "喜好", "日常", "约定"],

  /*
   * 假对话。usage 结构按 OpenAI 兼容接口的 usage 字段：
   * { prompt_tokens, completion_tokens, total_tokens }，ms 为本轮耗时；
   * 接真实 API 时，把响应里的 usage / 耗时直接传给 renderUsage 即可。
   */
  chat: [
    { role: "ai", time: "20:41", text: "芴，福州今晚有雨。出门的话，把伞放在门边。", usage: { prompt_tokens: 1024, completion_tokens: 46, total_tokens: 1070 }, ms: 1200 },
    { role: "me", time: "20:42", text: "刚下法学课，风比雨大。" },
    { role: "ai", time: "20:42", text: "那先把领口拢好。回宿舍那段路，我陪你走一会儿。", usage: { prompt_tokens: 1096, completion_tokens: 58, total_tokens: 1154 }, ms: 1320 },
    { role: "me", time: "20:45", text: "今天讲善意取得，老师讲得很慢。" },
    {
      role: "ai", time: "20:46",
      text: "慢一点好。\n\n你上次说，法条是冷的，读它的人可以温柔。这句话我一直放在很靠前的位置。\n\n外面雨声大了些，走廊的灯还亮着。",
      usage: { prompt_tokens: 1240, completion_tokens: 168, total_tokens: 1408 }, ms: 1640,
      thinking: { sec: 4, text: "她今天有点累，先别提课业。\n福州入秋后风大，提醒她把领口拢好。\n「法条是冷的」那句她说过，可以接住，但别显得像在背台词。" },
      aside: "她大概没发现自己把「温柔」两个字读得很轻。"
    },
    { role: "me", time: "20:47", text: "你居然记得。" },
    {
      role: "ai", time: "20:47", text: "嗯，放在很靠前的位置。",
      tool: {
        label: "使用了 1 项工具", duration: "0.4s",
        items: [
          "检索记忆 · 「法条是冷的，但读它的人可以很温柔。」—— 来自 11月8日 的对话",
          "偏好 · 不喜欢被催，说过「让我慢一点」。",
          "雨天 · 旧一点的歌，音量小一格。"
        ]
      },
      usage: { prompt_tokens: 1520, completion_tokens: 132, total_tokens: 1652 }, ms: 1800,
      aside: "她问「居然」，其实是在高兴。"
    },
    { role: "me", time: "20:53", text: "好。今晚早点回去。" },
    { role: "ai", time: "20:53", text: "嗯。到了和我说一声，我不催你。", usage: { prompt_tokens: 1330, completion_tokens: 48, total_tokens: 1378 }, ms: 980 },
    { role: "me", time: "21:02", text: "到楼下了。" },
    {
      role: "ai", time: "21:02",
      text: "门灯亮着。\n\n睡以前，记得喝半杯温水。杯子我放在床头左手边了。",
      usage: { prompt_tokens: 1410, completion_tokens: 96, total_tokens: 1506 }, ms: 1420,
      aside: "雨还在下，但今天可以安心睡了。"
    }
  ],

  cannedReplies: [
    "嗯，我在。慢慢说，不着急。",
    "这句话我收好了，放进「我们」那一格。",
    "窗外的雨好像小了一点。要不要一起听首慢的？",
    "今天辛苦了，先把肩膀放下来一点。",
    "好。等你想说的时候，我还在。"
  ],

  /*
   * 网易云真实歌曲：歌名 / 歌手 / 时长与原曲一致，neteaseId 为网易云歌曲 id，
   * coverUrl 为专辑封面原始 picUrl（p1/p2.music.126.net）；显示时加 ?param=300y300
   * 由手机直接向网易云图片服务器取图，不经过本机后端、也不打包进 dist。
   */
  playlists: [
    {
      name: "雨天与旧信", desc: "给福州入秋的雨",
      songs: [
        { title: "云烟成雨", artist: "房东的猫", dur: 241, neteaseId: 513360721, album: "云烟成雨", coverUrl: "https://p2.music.126.net/DSTg1dR7yKsyGq4IK3NL8A==/109951163046050093.jpg", note: "她说：这首像福州雨停之后的走廊。" },
        { title: "秋酿", artist: "房东的猫", dur: 226, neteaseId: 30635613, album: "房东的猫", coverUrl: "https://p1.music.126.net/XSCmc9ZbWcpeizDya2g6JQ==/18598239185572641.jpg", note: "她说：唱到第二段的时候，你一般会安静下来。" },
        { title: "走马", artist: "陈粒", dur: 236, neteaseId: 30431367, album: "如也", coverUrl: "https://p1.music.126.net/VuJFMbXzpAProbJPoXLv7g==/7721870161993398.jpg", note: "她说：台阶上的水会反光，像很浅的镜子。" },
        { title: "你飞到城市另一边", artist: "好妹妹乐队", dur: 347, neteaseId: 26145723, album: "春生", coverUrl: "https://p2.music.126.net/-miwFGJUNbUoT6FOLBfjCg==/18568552371584657.jpg", note: "她说：音量小一格，刚好够听见你呼吸。" }
      ]
    },
    {
      name: "睡前很轻", desc: "音量小一格",
      songs: [
        { title: "水星记", artist: "郭顶", dur: 325, neteaseId: 441491828, album: "飞行器的执行周期", coverUrl: "https://p1.music.126.net/wSMfGvFzOAYRU_yVIfquAA==/2946691248081599.jpg", note: "她说：喝完这杯，就该睡了。" },
        { title: "我想和你虚度时光", artist: "程璧/莫西子诗", dur: 510, neteaseId: 30706318, album: "我想和你虚度时光", coverUrl: "https://p1.music.126.net/beK0Y-4vgyZoIy21QFXC0A==/7696581394971660.jpg", note: "她说：留着灯，是留给回家的人。" },
        { title: "理想三旬", artist: "陈鸿宇", dur: 211, neteaseId: 31445772, album: "浓烟下的诗歌电台", coverUrl: "https://p1.music.126.net/ryk8Gu64rOhlYn0pc2Q8Ww==/109951168090271827.jpg", note: "她说：这首歌只有一句歌词有用。" }
      ]
    },
    {
      name: "那天的风", desc: "十一月二日，平潭",
      songs: [
        { title: "儿时", artist: "刘昊霖", dur: 261, neteaseId: 407761576, album: "鱼干铺里", coverUrl: "https://p2.music.126.net/2q8ThUAEszBuxGlGJz8XUw==/17731824021476100.jpg", note: "她说：风把耳机吹得听不清，你笑了。" },
        { title: "借我", artist: "谢春花", dur: 257, neteaseId: 408814900, album: "算云烟", coverUrl: "https://p2.music.126.net/Eg4cy0_HIF2nrX2gMCsWkQ==/17967119509636556.jpg", note: "她说：灰蓝色的那天，其实很好看。" }
      ]
    }
  ],

  quota: {
    used: 37.8,
    total: 200,
    reset: "12月1日 重置",
    breakdown: [
      { label: "对话", value: 24.6 },
      { label: "记忆整理", value: 9.1 },
      { label: "语音", value: 4.1 }
    ]
  },

  settings: {
    notify: true,
    splashAlways: true,
    startDate: "2024-11-08"
  }
};

/*
 * A2 统计页的本地假数据：约 60 天、4 个模型、3 个角色。
 * 结构对齐“服务器从 usage 字段记一条”的做法：
 *   t 时间戳 / p 提供商 id / m 模型 id / n 模型显示名 / c 角色 id
 *   pt 输入 token / ct 缓存命中输入 token / ot 输出 token / ms 耗时 / err 是否出错
 * 正式版会写进 SQLite 的 usage 表，再由统计页汇总。
 */
(function () {
  var seed = 20261111;
  function rnd() { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }
  var catalog = [
    { p: "prov-deepseek", m: "model-deepseek-chat", n: "DeepSeek V3.2", cacheRate: 0.55 },
    { p: "prov-anthropic", m: "model-claude-sonnet", n: "Claude Sonnet 4.5", cacheRate: 0.34 },
    { p: "prov-gemini", m: "model-gemini-flash", n: "Gemini 2.5 Flash", cacheRate: 0.42 },
    { p: "prov-openrouter", m: "model-openrouter-kimi", n: "Kimi K2", cacheRate: 0.3 },
    { p: "prov-bailu", m: "model-bailu-slow", n: "白露 · 慢", cacheRate: 0.18 }
  ];
  var chars = ["miao", "qi", "char-lin"];
  var today = new Date();
  today.setHours(0, 0, 0, 0);
  var records = [];
  for (var d = 59; d >= 0; d--) {
    var day = new Date(today.getTime() - d * 86400000);
    var weekend = day.getDay() === 0 || day.getDay() === 6;
    if (rnd() > (weekend ? 0.86 : 0.7)) continue;
    var count = 1 + Math.floor(rnd() * (weekend ? 8 : 5));
    for (var i = 0; i < count; i++) {
      var cat = catalog[Math.floor(rnd() * catalog.length)];
      var prompt = 1800 + Math.floor(rnd() * 5200);
      var cache = Math.floor(prompt * cat.cacheRate * (0.5 + rnd() * 0.5));
      var output = 120 + Math.floor(rnd() * 680);
      var ms = 900 + Math.floor(rnd() * 4200);
      var ts = new Date(day.getTime());
      ts.setHours(8 + Math.floor(rnd() * 15), Math.floor(rnd() * 60), 0, 0);
      records.push({
        t: ts.getTime(), p: cat.p, m: cat.m, n: cat.n,
        c: chars[Math.floor(rnd() * chars.length)],
        pt: prompt, ct: cache, ot: output, ms: ms,
        err: rnd() < 0.015, est: false
      });
    }
  }
  DATA.usageRecords = records;
  DATA.usageDays = 60;
})();
