"""统计：全部数字来自 SQLite 的 usage 表。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from .. import usage
from .deps import get_conn

router = APIRouter(prefix="/api", tags=["stats"])


@router.get("/usage/summary")
def usage_summary(conn=Depends(get_conn)) -> dict:
    return usage.usage_summary(conn)


@router.get("/stats")
def stats(
    range: str = Query("7d"),
    metric: str = Query("token"),
    rank: str = Query("model"),
    conn=Depends(get_conn),
) -> dict:
    return usage.get_stats(conn, range, metric, rank)
