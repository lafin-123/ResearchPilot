#!/usr/bin/env bash
# Minimal bridge CLI for POSIX environments. Full command support is in research.ps1.
set -euo pipefail

dir="$PWD"
while [[ ! -f "$dir/.research/bridge.json" ]]; do
  parent="$(dirname "$dir")"
  if [[ "$parent" == "$dir" ]]; then
    echo "未找到 .research/bridge.json。请在 ResearchPilot 项目目录内运行。" >&2
    exit 1
  fi
  dir="$parent"
done

port="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$dir/.research/bridge.json")"
token="$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$dir/.research/bridge.json")"
project="$(sed -n 's/.*"projectId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$dir/.research/bridge.json")"

method="${1:-status}"
case "$method" in
  status) body_method="status" ;;
  "docs list") body_method="docs.list" ;;
  "exps list") body_method="exps.list" ;;
  "refs list") body_method="refs.list" ;;
  "figs list") body_method="figs.list" ;;
  "ssh list") body_method="ssh.list" ;;
  *)
    echo "该精简 CLI 仅支持 status、docs list、exps list、refs list、figs list、ssh list。完整命令请使用 Windows 的 research.cmd。" >&2
    exit 1
    ;;
esac

curl --silent --show-error --fail \
  -H "Authorization: Bearer $token" \
  -H "Content-Type: application/json" \
  --data "{\"method\":\"$body_method\",\"params\":{},\"projectId\":\"$project\"}" \
  "http://127.0.0.1:$port/rpc"
