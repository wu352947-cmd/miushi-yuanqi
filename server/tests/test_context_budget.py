"""上下文预算可配置：override 优先、受窗口封顶、assemble 真的用它。"""

from server import prompts


def _model(window=1048576):
    return {"context": window}


def _sampling(max_tokens=1200):
    return {"max_tokens": max_tokens}


def test_default_budget_is_32k():
    assert prompts.history_budget(_model(), _sampling()) == 32000


def test_override_wins():
    """设置里调了 8000，就该是 8000，不被默认值盖掉。"""
    assert prompts.history_budget(_model(), _sampling(), 8000) == 8000
    assert prompts.history_budget(_model(), _sampling(), 64000) == 64000


def test_override_capped_by_window():
    """窗口小的时候，用户设得再大也不能把窗口塞满。"""
    budget = prompts.history_budget(_model(4000), _sampling(1200), 128000)
    assert budget <= int((4000 - 1200) * 0.9)
    assert budget >= 1024


def test_override_ignores_zero():
    """0 表示「没设」，回到默认，不是「预算为 0」。"""
    assert prompts.history_budget(_model(), _sampling(), 0) == 32000


def _assemble(messages, context_budget):
    return prompts.assemble(
        {
            "character": {"name": "羽蓉", "description": "她。"},
            "persona": {"name": "杭舟", "description": "我。"},
            "books": [],
            "preset": None,
            "model": {"context": 1048576},
            "messages": messages,
            "user_text": "嗯。",
            "context_budget": context_budget,
        }
    )


def test_assemble_uses_configured_budget():
    """预算调小，带的历史就该少——这是用户能感觉到的那个数字。"""
    long_msgs = [
        {"id": i + 1, "role": "ai", "text": "这是一段很长的内容。" * 60} for i in range(10)
    ]
    wide = _assemble(long_msgs, 0)
    narrow = _assemble(long_msgs, 2000)
    assert wide["meta"]["contextMessages"] == 10
    assert narrow["meta"]["contextMessages"] < 10
    assert narrow["meta"]["contextMessages"] >= 1
