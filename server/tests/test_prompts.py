"""提示词拼装顺序、世界书激活、绑定优先级。"""

from server import prompts


def char():
    return {
        "id": "c1",
        "name": "缪诗",
        "description": "旧城小公寓里写字的她。",
        "personality": "温和克制。",
        "scenario": "雨夜。",
        "worldBookId": "",
    }


def persona():
    return {"id": "p1", "name": "芴", "description": "法学院三年级。", "is_default": True}


def preset():
    return {
        "id": "pre1",
        "name": "细腻散文",
        "fragments": [
            {"id": "f1", "title": "前置", "content": "前置内容", "role": "system", "position": "before_char", "order": 1, "enabled": True},
            {"id": "f2", "title": "后置", "content": "后置内容", "role": "system", "position": "after_char", "order": 2, "enabled": True},
            {"id": "f3", "title": "深度", "content": "深度内容", "role": "system", "position": "depth", "depth": 2, "order": 3, "enabled": True},
            {"id": "f4", "title": "尾部", "content": "尾部内容", "role": "system", "position": "after_user", "order": 4, "enabled": True},
        ],
        "sampling": {"context_messages": 10, "max_tokens": 800},
    }


def books():
    return [
        {
            "id": "b1",
            "name": "旧城雨事",
            "entries": [
                {"id": "e1", "title": "门边的伞", "content": "伞放门边。", "keys": ["雨", "伞"], "constant": False, "enabled": True, "order": 10},
                {"id": "e2", "title": "门灯", "content": "门灯留到听见到了。", "keys": ["回家"], "constant": True, "enabled": True, "order": 5},
                {"id": "e3", "title": "停用条目", "content": "不该出现", "keys": ["雨"], "constant": False, "enabled": False, "order": 1},
            ],
        },
        {
            "id": "b2",
            "name": "海边的风",
            "entries": [
                {"id": "e4", "title": "围巾", "content": "围巾分一半。", "keys": ["风", "围巾"], "constant": False, "enabled": True, "order": 10},
            ],
        },
    ]


def messages():
    return [
        {"role": "ai", "text": "你回来了。"},
        {"role": "me", "text": "今天风很大。"},
        {"role": "ai", "text": "把领口拢好。"},
        {"role": "me", "text": "嗯。"},
    ]


def assemble(**overrides):
    context = {
        "character": char(),
        "persona": persona(),
        "books": books(),
        "preset": preset(),
        "model": {"id": "m1", "name": "测试模型", "modelId": "test-model"},
        "messages": messages(),
        "user_text": "外面下雨了要带伞吗",
        "now_text": "在图书馆三楼。",
        "memories": [{"title": "温水", "body": "睡前半杯温水", "pinned": True, "importance": 8}],
    }
    context.update(overrides)
    return prompts.assemble(context)


def test_assemble_order():
    out = assemble()
    kinds = [block["kind"] for block in out["blocks"]]
    # 前置 → 角色 → after_char → 世界书 → 用户设定 → 记忆 → 聊天 → 后置 → 当前用户句
    assert kinds[0] == "preset"
    assert kinds[1] == "char"
    assert kinds[2] == "preset"
    assert "book" in kinds
    assert kinds.index("user") > kinds.index("book")
    assert kinds.index("memory") > kinds.index("user")
    assert kinds[-1] == "current"
    assert [b["kind"] for b in out["blocks"]].count("chat") == 4
    assert "当前用户句" in out["text"]


def test_depth_fragment_inserted_before_nth_from_end():
    blocks = assemble()["blocks"]
    texts = [b.get("text") for b in blocks]
    depth_index = texts.index("深度内容")
    chat_texts = [b.get("text") for b in blocks if b["kind"] == "chat"]
    assert depth_index < len(texts)
    assert chat_texts[-2] in texts[depth_index + 1:]
    # 深度 2：插在倒数第 2 条聊天之前
    assert texts[depth_index + 1] == chat_texts[-2]


def test_worldbook_constant_and_keyword_activation():
    out = assemble()
    book_blocks = [b for b in out["blocks"] if b["kind"] == "book"]
    text = "\n".join(b["text"] for b in book_blocks)
    assert "门边的伞" in text  # 关键词「雨」「伞」命中
    assert "门灯" in text  # 常开
    assert "围巾" in text  # 关键词「风」命中
    assert "不该出现" not in text  # 停用条目
    assert out["meta"]["worldActivated"]


def test_worldbook_budget_skips_long_entries():
    big_books = [
        {
            "id": "b",
            "name": "大书",
            "entries": [
                {"id": "1", "title": "常开短条", "content": "短", "keys": [], "constant": True, "enabled": True, "order": 1},
                {"id": "2", "title": "超长", "content": "长" * 5000, "keys": [], "constant": True, "enabled": True, "order": 2},
            ],
        }
    ]
    out = assemble(books=big_books, world_budget=100)
    text = "\n".join(b["text"] for b in out["blocks"] if b["kind"] == "book")
    assert "常开短条" in text
    assert "超长" not in text
    assert out["meta"]["worldSkipped"] == 1


def test_disabled_fragment_not_included():
    p = preset()
    p["fragments"][0]["enabled"] = False
    out = assemble(preset=p)
    assert "前置内容" not in out["text"]


def test_context_messages_limit():
    long_history = [{"role": "me" if i % 2 else "ai", "text": "第" + str(i) + "句"} for i in range(40)]
    p = preset()
    p["sampling"]["context_messages"] = 6
    out = assemble(messages=long_history, preset=p)
    assert out["meta"]["contextMessages"] == 6
    chat_blocks = [b for b in out["blocks"] if b["kind"] == "chat"]
    assert len(chat_blocks) == 6
    assert chat_blocks[-1]["text"] == "第39句"


def test_resolve_persona_preset_books_priority():
    personas = [
        {"id": "g", "name": "全局", "description": "", "is_default": True},
        {"id": "char-default", "name": "角色默认", "description": ""},
        {"id": "chat-pinned", "name": "这场指定", "description": ""},
    ]
    character = {"id": "c", "name": "角色", "defaultPersonaId": "char-default", "defaultPresetId": "p-char", "worldBookId": "b1"}
    chat = {"personaId": "chat-pinned", "worldBookId": "b2", "presetId": "p-chat"}
    presets = [
        {"id": "p-global", "name": "全局"},
        {"id": "p-char", "name": "角色"},
        {"id": "p-chat", "name": "这场"},
    ]
    books = [{"id": "b0", "name": "全局书"}, {"id": "b1", "name": "角色书"}, {"id": "b2", "name": "聊天书"}]
    person, source = prompts.resolve_persona(chat, character, personas)
    assert (person["id"], source) == ("chat-pinned", "chat")
    person, source = prompts.resolve_persona({}, character, personas)
    assert (person["id"], source) == ("char-default", "char")
    person, source = prompts.resolve_persona({}, {}, personas)
    assert (person["id"], source) == ("g", "global")
    preset, source = prompts.resolve_preset(chat, character, presets, "p-global")
    assert (preset["id"], source) == ("p-chat", "chat")
    preset, source = prompts.resolve_preset({}, character, presets, "p-global")
    assert (preset["id"], source) == ("p-char", "char")
    preset, source = prompts.resolve_preset({}, {}, presets, "p-global")
    assert (preset["id"], source) == ("p-global", "global")
    merged = prompts.resolve_books("b0", character, chat, books)
    assert [b["id"] for b in merged] == ["b0", "b1", "b2"]
    # 同一本被多处引用只算一次
    merged = prompts.resolve_books("b1", character, {"worldBookId": "b1"}, books)
    assert [b["id"] for b in merged] == ["b1"]
