#!/usr/bin/env bash
# qlaybot v0.4.3 — Group 6 step 22 shell harness (spec §5.3).
#
# Black-box end-to-end smoke of Plan Mode + verbose transcript + sandbox.
# Exercises the real `dist/cli.js` binary; complements ink-testing-library
# tests with a pty-path and production-build assertions the TS tests cannot
# cover (package.json bin, dist/ correctness, real streaming).
#
# Fix-round-2 updates:
#   (F1) plan body must be > 200 chars (wc -c on the "## Plan" body slice).
#   (F2) verbose transcript must contain plan_mode_entered + plan_mode_exited
#        + user_prompt events.
#   (F3) HOME redirected to the tmpdir so ~/.qlaybot/history lands there and
#        the sandbox-invariant check reads a deterministic path.
#
# Exit behavior:
#   - If ANTHROPIC_API_KEY is unset:  echo SKIP and exit 0.
#   - Any assertion failure:          exit 1 with a diagnostic message.
#   - Happy path:                     exit 0.

set -e

# ─────────────────────────────────────────────────────────────────────────────
# Skip guard — honour CI without an API key.
# ─────────────────────────────────────────────────────────────────────────────
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "SKIP: ANTHROPIC_API_KEY unset"
  exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
# Locate repo, build dist/ if missing, set a sandboxed workspace dir + HOME.
# ─────────────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

if [ ! -f "${AGENT_DIR}/dist/cli.js" ]; then
  echo "[test-plan-mode.sh] dist/cli.js missing, running npm run build..."
  (cd "${AGENT_DIR}" && npm run build)
fi

TMP_WORKSPACE="$(mktemp -d -t qlaybot-plan-mode-XXXXXX)"
TMP_HOME="$(mktemp -d -t qlaybot-plan-mode-home-XXXXXX)"
export QLAYBOT_WORKSPACE_DIR="${TMP_WORKSPACE}"
# (Fix F3) HOME redirection — history + verbose transcript land beneath
# paths WE control; the sandbox-invariant check reads a deterministic path
# instead of probing ~/.qlaybot/history.
export HOME="${TMP_HOME}"

cleanup() {
  rm -rf "${TMP_WORKSPACE}" "${TMP_HOME}" || true
}
trap cleanup EXIT

MSG="plan a Hall bar with 6 contacts"
MODEL="${QLAYBOT_PLAN_MODE_MODEL:-sonnet}"

# ─────────────────────────────────────────────────────────────────────────────
# Run 1 — default (no --verbose). Transcripts MUST NOT be written.
# ─────────────────────────────────────────────────────────────────────────────
echo "[test-plan-mode.sh] run 1 (no --verbose) ..."
set +e
timeout 300 node "${AGENT_DIR}/dist/cli.js" \
  --message "${MSG}" \
  --model "${MODEL}"
EXIT1=$?
set -e

if [ "${EXIT1}" -ne 0 ]; then
  echo "[FAIL] run 1 exited ${EXIT1}" >&2
  exit 1
fi

# Assertion 1: at least one plans/plan-*.md file exists in the workspace.
shopt -s nullglob
PLAN_FILES=("${TMP_WORKSPACE}/plans"/plan-*.md)
shopt -u nullglob
if [ "${#PLAN_FILES[@]}" -eq 0 ]; then
  echo "[FAIL] no plans/plan-*.md file in ${TMP_WORKSPACE}/plans/" >&2
  exit 1
fi

# Assertion 2: plan file has >0 bytes and contains `## Plan`.
PLAN_FILE="${PLAN_FILES[0]}"
if [ ! -s "${PLAN_FILE}" ]; then
  echo "[FAIL] plan file ${PLAN_FILE} is empty" >&2
  exit 1
fi
if ! grep -q "## Plan" "${PLAN_FILE}"; then
  echo "[FAIL] plan file missing '## Plan' section" >&2
  exit 1
fi

# (Fix F1) Assertion: plan body (everything between "## Plan" and the next
# "##" section, or EOF) is > 200 chars.
PLAN_BODY="$(awk '/^## Plan/{flag=1; next} /^## /{flag=0} flag' "${PLAN_FILE}")"
BODY_CHARS=$(printf '%s' "${PLAN_BODY}" | wc -c | tr -d ' ')
if [ "${BODY_CHARS}" -le 200 ]; then
  echo "[FAIL] plan body is only ${BODY_CHARS} chars (expected > 200)" >&2
  exit 1
fi

# Assertion 3: qlaybot-transcripts is ABSENT without --verbose.
if [ -d "${TMP_WORKSPACE}/qlaybot-transcripts" ]; then
  TRANSCRIPT_COUNT=$(ls "${TMP_WORKSPACE}/qlaybot-transcripts/"*.jsonl 2>/dev/null | wc -l | tr -d ' ')
  if [ "${TRANSCRIPT_COUNT}" -gt 0 ]; then
    echo "[FAIL] qlaybot-transcripts/*.jsonl present WITHOUT --verbose" >&2
    exit 1
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# Run 2 — with --verbose. Transcripts MUST be present.
# ─────────────────────────────────────────────────────────────────────────────
echo "[test-plan-mode.sh] run 2 (--verbose) ..."
set +e
timeout 300 node "${AGENT_DIR}/dist/cli.js" \
  --verbose \
  --message "${MSG}" \
  --model "${MODEL}"
EXIT2=$?
set -e

if [ "${EXIT2}" -ne 0 ]; then
  echo "[FAIL] run 2 (--verbose) exited ${EXIT2}" >&2
  exit 1
fi

# Assertion 4: qlaybot-transcripts/*.jsonl present with --verbose.
shopt -s nullglob
TRANSCRIPT_FILES=("${TMP_WORKSPACE}/qlaybot-transcripts"/*.jsonl)
shopt -u nullglob
if [ "${#TRANSCRIPT_FILES[@]}" -eq 0 ]; then
  echo "[FAIL] no qlaybot-transcripts/*.jsonl after --verbose run" >&2
  exit 1
fi

VERBOSE_TRANSCRIPT="${TRANSCRIPT_FILES[0]}"

# (Fix F2) Assertion: verbose transcript contains required event markers.
for event in "plan_mode_entered" "plan_mode_exited" "user_prompt"; do
  if ! grep -q "${event}" "${VERBOSE_TRANSCRIPT}"; then
    echo "[FAIL] verbose transcript missing event: ${event}" >&2
    exit 1
  fi
done

# (Fix F3) Assertion 5: between plan_mode_entered and plan_mode_exited, no
# calls to execute_script / auto_route / create_layout. We now read the
# deterministic verbose transcript path (no soft-warn fallback).
python3 - "${VERBOSE_TRANSCRIPT}" <<'PY'
import json, sys
path = sys.argv[1]
lines = open(path, encoding="utf-8").read().splitlines()
forbidden = ("execute_script", "auto_route", "create_layout")
in_plan = False
bad = []
for line in lines:
  try:
    e = json.loads(line)
  except Exception:
    continue
  t = e.get("type") or ""
  tool_name = (e.get("toolName")
               or (e.get("data") or {}).get("toolName")
               or "")
  if t == "plan_mode_entered" or tool_name == "enter_plan_mode":
    in_plan = True
    continue
  if t == "plan_mode_exited" or tool_name == "exit_plan_mode":
    in_plan = False
    continue
  if in_plan and (t == "tool_call" or t == "tool_use" or tool_name):
    name = tool_name or ""
    for f in forbidden:
      if f in name:
        bad.append(name)
if bad:
  print("[FAIL] forbidden tool calls inside plan mode: " + ", ".join(sorted(set(bad))), file=sys.stderr)
  sys.exit(1)
print("[OK] sandbox invariant held: no forbidden tools during plan mode")
PY

echo "[PASS] tests/test-plan-mode.sh"
exit 0
