#!/usr/bin/env bash
# 缪诗鸳杞部署脚本：工作副本 -> 生产 -> 重启 -> 验证
#
#   ./deploy.sh                  完整流程（检查 / 构建 / 测试 / 备份 / 同步 / 重启）
#   ./deploy.sh --dry-run        只显示会改哪些文件，不动生产
#   ./deploy.sh --no-build       跳过前端构建（直接用已提交的 dist）
#   ./deploy.sh --no-test        跳过测试（急修时用）
#   ./deploy.sh --allow-dirty    允许未提交改动（不建议，仓库就查不出问题了）
#   ./deploy.sh --rollback FILE  用某次备份回滚
#
# 生产：/opt/miushi-yuanqi（属主 miushi，systemd: miushi-yuanqi，127.0.0.1:8100）

set -u

SRC="$(cd "$(dirname "$0")" && pwd)"
DST=/opt/miushi-yuanqi
SVC=miushi-yuanqi
PY="$DST/.venv/bin/python"
BK_DIR=/opt/backup
STAMP=$(date +%Y%m%d-%H%M%S)

DO_BUILD=1
DO_TEST=1
ALLOW_DIRTY=0
DRY=0
ROLLBACK=""

while [ $# -gt 0 ]; do
  case "$1" in
    --no-build)    DO_BUILD=0 ;;
    --no-test)     DO_TEST=0 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --dry-run)     DRY=1 ;;
    --rollback)    shift; ROLLBACK="${1:-}" ;;
    -h|--help)     sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
  shift
done

c_say()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
c_ok()   { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
c_warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
c_die()  { printf '\033[1;31m  ✗ %s\033[0m\n' "$*"; exit 1; }

# ---------- 回滚 ----------
if [ -n "$ROLLBACK" ]; then
  [ -f "$ROLLBACK" ] || c_die "找不到备份：$ROLLBACK"
  c_say "回滚到 $(basename "$ROLLBACK")"
  tar xzf "$ROLLBACK" -C "$DST" || c_die "解包失败"
  chown -R miushi:miushi "$DST/server" "$DST/src" "$DST/dist" "$DST/assets" 2>/dev/null
  find "$DST/server" -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null
  systemctl restart "$SVC"
  sleep 3
  systemctl is-active --quiet "$SVC" && c_ok "服务已重启" || {
    journalctl -u "$SVC" -n 20 --no-pager; c_die "服务没起来"
  }
  echo
  echo "  最近的备份："
  ls -1t "$BK_DIR"/msyq-deploy-*.tar.gz 2>/dev/null | head -5 | sed 's/^/    /'
  exit 0
fi

# ---------- 前置 ----------
[ "$(id -u)" -eq 0 ] || c_die "需要 root（要改 miushi 属主）"
command -v rsync >/dev/null || c_die "缺 rsync：apt-get install -y rsync"
[ -d "$DST" ] || c_die "生产目录不存在：$DST"

# ---------- 1. 工作区 ----------
c_say "1/6 工作区"
if [ -d "$SRC/.git" ]; then
  DIRTY=$(git -C "$SRC" status --porcelain)
  if [ -n "$DIRTY" ]; then
    if [ "$ALLOW_DIRTY" -eq 0 ]; then
      echo "$DIRTY" | head -20 | sed 's/^/    /'
      c_die "有未提交改动。先 commit，或加 --allow-dirty"
    fi
    c_warn "有未提交改动（已放行）"
  else
    c_ok "干净 @ $(git -C "$SRC" rev-parse --short HEAD)"
  fi
  AHEAD=$(git -C "$SRC" rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
  [ "$AHEAD" -gt 0 ] && c_warn "$AHEAD 个提交还没 push"
fi

# ---------- 2. 构建 ----------
c_say "2/6 构建前端"
if [ "$DO_BUILD" -eq 1 ]; then
  command -v node >/dev/null || c_die "缺 node"
  if ! ( cd "$SRC" && node scripts/build.mjs >/tmp/msyq-build.log 2>&1 ); then
    tail -8 /tmp/msyq-build.log | sed 's/^/    /'
    c_die "构建失败"
  fi
  c_ok "dist/index.html  $(du -h "$SRC/dist/index.html" | cut -f1)"
  git -C "$SRC" diff --quiet -- dist/index.html 2>/dev/null \
    || c_warn "dist 有变化，记得提交（否则线上与仓库不一致）"
else
  c_warn "跳过（用现有 dist）"
fi

# ---------- 3. 测试 ----------
c_say "3/6 测试"
if [ "$DO_TEST" -eq 1 ]; then
  [ -x "$PY" ] || c_die "找不到 venv：$PY"
  LOG=/tmp/msyq-test.log
  # 用退出码判断：本项目 pytest.ini 的 addopts 抑制了 summary 行，grep "passed" 抓不到
  if ! ( cd "$SRC" && "$PY" -m pytest -q > "$LOG" 2>&1 ); then
    tr '\r' '\n' < "$LOG" | grep -E '^(FAILED|ERROR)' | head -10 | sed 's/^/    /'
    tail -5 "$LOG" | sed 's/^/    /'
    c_die "测试不通过，已中止（SKIP? 用 --no-test）"
  fi
  N=$(tr '\r' '\n' < "$LOG" | grep -oE '[0-9]+ (passed|个通过)' | tail -1)
  DOTS=$(tr '\r' '\n' < "$LOG" | grep -c '\.\.\.\.')
  c_ok "通过${N:+（$N）}${N:-（$DOTS 行进度，无失败）}"
else
  c_warn "跳过"
fi

# ---------- 4. 备份 ----------
c_say "4/6 备份生产"
mkdir -p "$BK_DIR"
BK="$BK_DIR/msyq-deploy-$STAMP.tar.gz"
if [ "$DRY" -eq 1 ]; then
  c_warn "dry-run 不备份"
else
  tar czf "$BK" -C "$DST" server src dist assets 2>/dev/null || c_die "备份失败"
  [ -s "$BK" ] || c_die "备份是空的"
  c_ok "$(basename "$BK")  $(du -h "$BK" | cut -f1)"
fi

# ---------- 5. 同步 ----------
c_say "5/6 同步"
CHANGED=/tmp/msyq-deploy-changes.txt
: > "$CHANGED"
OPTS="-a --delete --checksum --itemize-changes"
[ "$DRY" -eq 1 ] && OPTS="$OPTS -n"
for d in server src dist assets; do
  [ -d "$SRC/$d" ] || continue
  # tests/ 只在开发端跑，生产 venv 没装 pytest，同步过去纯属噪音
  rsync $OPTS --exclude='__pycache__/' --exclude='tests/' "$SRC/$d/" "$DST/$d/" >> "$CHANGED" 2>&1
done
find "$DST/server" -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null
chown -R miushi:miushi "$DST/server" "$DST/src" "$DST/dist" "$DST/assets" 2>/dev/null

# grep -c 无匹配时自己就会输出 0 并返回 1，再 `|| echo 0` 会拼成 "0\n0"
FILES=$(grep -cE '^[<>]f' "$CHANGED" 2>/dev/null)
FILES=${FILES:-0}
if [ "$FILES" -eq 0 ]; then
  c_ok "无文件变化"
else
  c_ok "$FILES 个文件："
  grep -E '^[<>]f' "$CHANGED" | awk '{print "    " $2}' | head -20
  [ "$FILES" -gt 20 ] && echo "    ...还有 $((FILES - 20)) 个"
fi

if [ "$DRY" -eq 1 ]; then
  echo
  c_warn "--dry-run：生产未改动，未重启"
  exit 0
fi

# ---------- 6. 重启 + 验证 ----------
c_say "6/6 重启 + 验证"
systemctl restart "$SVC"
# systemctl is-active 只说明进程起来了，uvicorn 还没 bind 时请求会直接失败。
# 所以按端口实际可用为准，轮询等待（最多 30 秒）。
CODE=000
for _ in $(seq 1 30); do
  sleep 1
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:8100/ 2>/dev/null) || CODE=000
  case "$CODE" in 200|302) break ;; esac
  systemctl is-active --quiet "$SVC" || break
done
if [ "$CODE" != "200" ] && [ "$CODE" != "302" ]; then
  journalctl -u "$SVC" -n 25 --no-pager | sed 's/^/    /'
  c_die "本地 HTTP $CODE（可回滚：$0 --rollback $BK）"
fi
c_ok "服务 active，本地 HTTP $CODE"

printf '\n\033[1;32m部署完成\033[0m  %s\n' "$STAMP"
printf '  回滚：%s --rollback %s\n\n' "$0" "$BK"