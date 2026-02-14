#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROXY_SCRIPT="${ROOT_DIR}/src/Sources/Resources/cursor-proxy.js"
PORT=8319
CANARY_MODEL="${CANARY_MODEL:-composer-1.5}"
RESET_SCRIPT="${ROOT_DIR}/scripts/reset-runtime.sh"

if ! command -v node >/dev/null 2>&1; then
  echo "❌ node is required for smoke test"
  exit 1
fi

if [ ! -f "${PROXY_SCRIPT}" ]; then
  echo "❌ cursor-proxy.js not found at ${PROXY_SCRIPT}"
  exit 1
fi

TMP_DIR="$(mktemp -d)"
LOG_FILE="${TMP_DIR}/cursor-proxy.log"

cleanup() {
  if [ -n "${PROXY_PID:-}" ] && kill -0 "${PROXY_PID}" >/dev/null 2>&1; then
    kill "${PROXY_PID}" >/dev/null 2>&1 || true
    wait "${PROXY_PID}" 2>/dev/null || true
  fi
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

bash "${RESET_SCRIPT}"
node "${PROXY_SCRIPT}" >"${LOG_FILE}" 2>&1 &
PROXY_PID=$!

echo "🧪 waiting for cursor-proxy on :${PORT}"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

HEALTH="$(curl -fsS "http://127.0.0.1:${PORT}/health")"
if [ "${HEALTH}" != "OK" ]; then
  echo "❌ health check failed: ${HEALTH}"
  exit 1
fi
echo "✅ health check passed"

CHAT_REQ="{\"model\":\"${CANARY_MODEL}\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"smoke test canary (${CANARY_MODEL})\"}]}"
CHAT_HTTP="$(curl -sS -o "${TMP_DIR}/chat.out" -w "%{http_code}" -X POST "http://127.0.0.1:${PORT}/v1/chat/completions" -H "Content-Type: application/json" -H "Authorization: Bearer dummy-cursor-token" -d "${CHAT_REQ}" || true)"
CHAT_RESP="$(<"${TMP_DIR}/chat.out")"

if [[ "${CHAT_HTTP}" =~ ^(200|500|502)$ ]] && [ -n "${CHAT_RESP}" ]; then
  echo "✅ canary (${CANARY_MODEL}) endpoint responded (http=${CHAT_HTTP})"
else
  echo "❌ canary (${CANARY_MODEL}) check failed (http=${CHAT_HTTP})"
  if [ -f "${LOG_FILE}" ]; then
    echo "---- cursor-proxy log ----"
    sed -n '1,120p' "${LOG_FILE}"
  fi
  exit 1
fi

echo "🎉 cursor-proxy smoke test passed"
