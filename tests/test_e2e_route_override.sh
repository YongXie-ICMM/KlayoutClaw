#!/usr/bin/env bash
# E2E: agent runs auto_route twice — first dry_run to see the Hungarian
# assignment, then pin_pairs_override to force a crossed pairing. Proves
# the ml14 "manual pairing" workflow works end-to-end.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MCP_URL="http://127.0.0.1:8765/mcp"
RESULT_JSON="/tmp/e2e_route_override.json"
DRYRUN_JSON="/tmp/e2e_route_override_dryrun.json"
CLAUDE_LOG="/tmp/e2e_route_override.log"
MAX_WAIT_SEC=900   # 15 min cap — agent does 2 route calls

echo "=== E2E: pin_pairs_override ==="

CONDA_SH=""
for p in "$HOME/anaconda3" "$HOME/miniforge3" "$HOME/miniconda3"; do
    if [ -f "$p/etc/profile.d/conda.sh" ]; then
        CONDA_SH="$p/etc/profile.d/conda.sh"
        break
    fi
done
if [ -z "$CONDA_SH" ]; then
    echo "ERROR: no conda install found"
    exit 1
fi
# shellcheck disable=SC1090
source "$CONDA_SH"
conda activate instrMCPdev

curl -sf "$MCP_URL" > /dev/null 2>&1 || {
    echo "ERROR: MCP server down at $MCP_URL — open KLayout first."
    exit 1
}

read -r -d '' PROMPT <<'EOF' || true
Using klayoutclaw MCP:
  1. create_layout (fresh, blank).
  2. Via execute_script, draw four pins:
        L100/0 at (0,0)-(2,2)
        L100/0 at (0,100)-(2,102)
        L101/0 at (50,0)-(52,2)
        L101/0 at (50,100)-(52,102)
     (Two vertically-separated pairs. Hungarian will match them in
     parallel: A0->B0 at y=0, A1->B1 at y=100. We want the crossed
     pairing: A0->B1, A1->B0.)
  3. auto_route with dry_run=true, pin_layer_a="100/0", pin_layer_b="101/0",
     output_layer="10/0", map_resolution=2.0, path_width=2.0. Write the
     response JSON to /tmp/e2e_route_override_dryrun.json.
  4. auto_route AGAIN with dry_run=false, pin_pairs_override=[[0,1],[1,0]],
     same layer specs and same map_resolution/path_width. Write the
     response JSON to /tmp/e2e_route_override.json.
  5. Print "E2E_DONE" on success, "E2E_FAIL: <msg>" on any error.
EOF

: > "$CLAUDE_LOG"
claude \
    --mcp-config "$PROJECT_DIR/mcp_config.json" \
    --dangerously-skip-permissions \
    --print "$PROMPT" > "$CLAUDE_LOG" 2>&1 &
CLAUDE_PID=$!
TIMED_OUT=0
for ((elapsed=0; elapsed<MAX_WAIT_SEC; elapsed+=5)); do
    if ! kill -0 "$CLAUDE_PID" 2>/dev/null; then
        break
    fi
    sleep 5
done
if kill -0 "$CLAUDE_PID" 2>/dev/null; then
    kill -9 "$CLAUDE_PID" 2>/dev/null || true
    TIMED_OUT=1
fi
set +e
wait "$CLAUDE_PID"
CLAUDE_RC=$?
set -e

if [ "$TIMED_OUT" -eq 1 ]; then
    echo "FAIL: claude timed out after ${MAX_WAIT_SEC}s"
    tail -40 "$CLAUDE_LOG"
    exit 3
elif [ "$CLAUDE_RC" -ne 0 ]; then
    echo "FAIL: claude exited rc=$CLAUDE_RC"
    tail -40 "$CLAUDE_LOG"
    exit 2
fi

grep -q "E2E_FAIL" "$CLAUDE_LOG" && {
    echo "FAIL: agent reported E2E_FAIL"
    tail -40 "$CLAUDE_LOG"
    exit 2
}
grep -q "E2E_DONE" "$CLAUDE_LOG" || {
    echo "FAIL: agent did not emit E2E_DONE marker"
    tail -40 "$CLAUDE_LOG"
    exit 3
}
test -f "$RESULT_JSON" || {
    echo "FAIL: override result JSON missing at $RESULT_JSON"
    exit 4
}

python - <<'PY'
import json
with open("/tmp/e2e_route_override.json") as f:
    r = json.load(f)
# Override must have succeeded (status success OR partial — not failed)
assert r["status"] in ("success", "partial"), r
assert r["routed_pairs"] == 2, r
paths = r.get("paths", [])
assert len(paths) == 2, paths
# Each path's endpoints (in um) must span y=0..100 diagonally (dy >= 50 um);
# Hungarian parallel routes would have dy ~ 0.
for p in paths:
    # Support either points_um or points_dbu (worker chooses)
    if "points_um" in p:
        pts = p["points_um"]
    elif "points_dbu" in p:
        pts = [[x * 0.001, y * 0.001] for x, y in p["points_dbu"]]
    else:
        raise AssertionError(f"path missing points_um/points_dbu: {p}")
    dy = abs(pts[-1][1] - pts[0][1])
    assert dy > 50, f"override did not apply; dy={dy} suggests straight Hungarian paths. path={p!r}"
print("PASS: pin_pairs_override produced crossed pairing; routes committed.")
PY

echo "=== E2E: pin_pairs_override PASSED ==="
