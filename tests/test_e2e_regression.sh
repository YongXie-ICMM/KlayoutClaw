#!/usr/bin/env bash
# Runs every Phase 1-6 E2E sequentially. Exits non-zero on ANY failure.
# Use this as the single entry point for a full regression run.
set -uo pipefail   # note: NO -e — we want to tally failures, not exit early

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FAIL=0
PASSED=()
FAILED=()
for t in \
    test_e2e_non_hallbar.sh \
    test_e2e_material_overlap.sh \
    test_e2e_route_override.sh \
    test_e2e_crossing_pairs.sh \
    test_e2e_heavy_script.sh \
    test_e2e_alt_device.sh ; do
    echo ""
    echo "############################"
    echo "# Running $t"
    echo "############################"
    if bash "$SCRIPT_DIR/$t"; then
        PASSED+=("$t")
    else
        FAIL=$((FAIL+1))
        FAILED+=("$t")
    fi
done

echo ""
echo "============================"
echo "E2E REGRESSION SUMMARY"
echo "============================"
echo "Passed (${#PASSED[@]}):"
for t in "${PASSED[@]}"; do echo "  ✓ $t"; done
echo "Failed (${#FAILED[@]}):"
for t in "${FAILED[@]}"; do echo "  ✗ $t"; done
exit $FAIL
