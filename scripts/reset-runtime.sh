#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SMOKE_TMP_ROOT="${ROOT_DIR}/.tmp/smoke"

kill_port_processes() {
  local target_port="$1"
  local pids
  pids="$(lsof -ti tcp:"${target_port}" 2>/dev/null || true)"
  if [ -n "${pids}" ]; then
    echo "ℹ️ killing stale process(es) on :${target_port}"
    kill ${pids} >/dev/null 2>&1 || true
    sleep 0.3
    pids="$(lsof -ti tcp:"${target_port}" 2>/dev/null || true)"
    if [ -n "${pids}" ]; then
      kill -9 ${pids} >/dev/null 2>&1 || true
    fi
  fi
}

echo "🧹 resetting runtime state"
pkill -f "cursor-proxy.js" >/dev/null 2>&1 || true
pkill -f "VibeProxy-dev.app" >/dev/null 2>&1 || true
pkill -f "VibeProxy.app" >/dev/null 2>&1 || true

kill_port_processes 8317
kill_port_processes 8318
kill_port_processes 8319

rm -rf "${SMOKE_TMP_ROOT}"
mkdir -p "${SMOKE_TMP_ROOT}"
echo "✅ runtime state reset complete"
