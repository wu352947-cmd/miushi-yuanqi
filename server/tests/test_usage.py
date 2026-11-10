"""usage 写入与统计汇总（含估算标记）。"""

from server import db, usage


def test_record_and_aggregate(client):
    with db.get_db() as conn:
        models = [db.model_json(r) for r in conn.execute("SELECT * FROM models").fetchall()]
        deepseek = next(m for m in models if m["id"] == "model-deepseek-flash")  # 峰谷单价
        qwen = next(m for m in models if m["id"] == "model-qwen3")  # 价格待确认（None）
        usage.record_usage(
            conn, character_id="miao", provider_id="prov-deepseek", model_id=deepseek["id"],
            model_key=deepseek["modelId"], model_name=deepseek["name"],
            prompt_tokens=1000, cache_tokens=400, output_tokens=200, duration_ms=1200, ok=True,
            estimated=False,
        )
        usage.record_usage(
            conn, character_id="qi", provider_id="prov-siliconcloud", model_id=qwen["id"],
            model_key=qwen["modelId"], model_name=qwen["name"],
            prompt_tokens=500, cache_tokens=0, output_tokens=100, duration_ms=800, ok=True,
            estimated=True,
        )
        usage.record_usage(
            conn, character_id="miao", provider_id="prov-deepseek", model_id="model-without-price",
            model_key="x", model_name="没设单价的模型",
            prompt_tokens=300, cache_tokens=0, output_tokens=50, duration_ms=400, ok=False,
            error_kind="server", estimated=False,
        )
        stats = usage.get_stats(conn, "7d", "token", "model")
    overview = stats["overview"]
    assert overview["count"] == 3
    assert overview["prompt"] == 1800
    assert overview["cache"] == 400
    assert overview["output"] == 350
    assert overview["estimatedCount"] == 1
    assert overview["errors"] == 1
    assert overview["hitRate"] > 0
    assert overview["unpricedCount"] >= 1
    # deepseek 是峰谷价：按当前时刻选 peak / offpeak
    expected, priced = usage._cost(1000, 400, 200, deepseek, usage.currency_rate(), 0, None)
    assert priced is True
    assert abs(overview["cost"] - expected) < 1e-6
    assert overview["reasoning"] == 0
    assert stats["chart"]["mode"] == "day"
    assert len(stats["chart"]["buckets"]) == 7
    assert stats["rank"]["tab"] == "model"
    assert stats["rank"]["items"]
    assert stats["lite"]["messages"] >= 0
    assert stats["balance"]


def test_usage_summary(client):
    with db.get_db() as conn:
        usage.record_usage(conn, prompt_tokens=10, output_tokens=5, model_id="model-deepseek-flash")
        summary = usage.usage_summary(conn)
    assert summary["today"] >= 15
    assert len(summary["bars"]) == 7


def test_estimated_usage_marked(client):
    with db.get_db() as conn:
        usage.record_usage(conn, prompt_tokens=10, output_tokens=5, estimated=True)
        row = conn.execute("SELECT * FROM usage ORDER BY id DESC LIMIT 1").fetchone()
    assert row["estimated"] == 1
