#!/usr/bin/env python
"""qlaybot v0.4.4 Phase 5 — VC MCP handler unit tests (Tasks 5.1-5.9).

These tests exercise the 9 handlers in ``tools.vc_mcp_handlers`` against a
frozen G5 backend (``plugin.klayoutclaw_vc.repo``).  They do NOT require
KLayout's GUI — only ``klayout.db`` Python bindings + ``git`` on PATH.

Contract the Executor must honour
---------------------------------
The test-friendly entry-point shape this test file targets is:

    # module: tools/vc_mcp_handlers.py
    REGISTRY: dict  # keyed by id(layout)
    VC_EXPORT_INLINE_CAP_BYTES: int = 256 * 1024

    def reset_registry() -> None: ...
    def vc_init(args: dict, *, layout, gds_path_hint=None) -> dict: ...
    def vc_checkpoint(args: dict, *, layout, gds_path_hint=None) -> dict: ...
    def vc_history(args: dict, *, layout, gds_path_hint=None) -> dict: ...
    def vc_checkout(args: dict, *, layout, gds_path_hint=None) -> dict: ...
    def vc_diff(args: dict, *, layout, gds_path_hint=None) -> dict: ...
    def vc_branch(args: dict, *, layout, gds_path_hint=None) -> dict: ...
    def vc_tag(args: dict, *, layout, gds_path_hint=None) -> dict: ...
    def vc_export(args: dict, *, layout, gds_path_hint=None) -> dict: ...
    def vc_status(args: dict, *, layout, gds_path_hint=None) -> dict: ...

Key behaviours verified here:

* ``vc_init`` RB-1 auto-detection returns ``{ok: True, mode, repo_path}``.
* Uninitialised handlers return the uniform sentinel
  ``{ok: False, reason: "vc not initialized"}`` — 7 handlers, NOT
  ``vc_init`` / ``vc_status`` (status returns the same sentinel but is
  always callable without error).
* ``vc_init`` can be re-invoked (G5 auto-invalidates the prior handle).
* ``vc_checkpoint`` / ``vc_history`` / ``vc_checkout`` / ``vc_diff`` /
  ``vc_branch`` / ``vc_tag`` / ``vc_export`` / ``vc_status`` all pass
  through the G5 layer's response shape.
* ``vc_export`` owns the size-based truncation logic with cap
  ``VC_EXPORT_INLINE_CAP_BYTES = 256 * 1024``.
* Lifecycle (T9) + full-loop (T14) + merge-conflict (T46) + tag duplicate
  (T40) + large-export (T45) are exercised end-to-end.

These tests should FAIL with ImportError until the Executor lands
``tools/vc_mcp_handlers.py``.
"""
from __future__ import annotations

import base64
import os
import sys

import pytest

# Keep project root on sys.path so ``plugin.klayoutclaw_vc.*`` and
# ``tools.*`` imports resolve the same way as test_vc_repo.py.
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)


# ---------------------------------------------------------------------------
# Import the module under test — this is the ONLY place we let an
# ImportError surface.  We deliberately do NOT use pytest.importorskip for
# ``tools.vc_mcp_handlers``: these are TRD failing tests and must FAIL
# until the Executor lands the module — a silent skip would let an
# incomplete implementation slip through.
#
# ``klayout.db`` IS optional via importorskip because it's an
# environment-level dep (matching test_vc_repo.py's policy).
# ---------------------------------------------------------------------------

pya = pytest.importorskip("klayout.db", reason="klayout.db Python bindings required")

try:
    from tools import vc_mcp_handlers as handlers  # type: ignore[attr-defined]
except ImportError as _imp_err:  # pragma: no cover - pre-Executor state
    # Raise loudly via a module-level pytest.fail() so every collected
    # test reports the same actionable message instead of a silent
    # skip.  (We deliberately do NOT wrap this in a fixture — collection
    # itself should surface the failure so CI sees it.)
    pytest.fail(
        "tools/vc_mcp_handlers.py not implemented yet — Phase 5 Executor "
        "must land the 9-handler module before these tests can run. "
        f"Original ImportError: {_imp_err}",
        pytrace=False,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


UNINIT_REASON = "vc not initialized"


def _make_layout(n_shapes: int = 1, *, layer: int = 1, datatype: int = 0):
    """Simple pya.Layout with ``n_shapes`` boxes on one layer."""
    layout = pya.Layout()
    layout.dbu = 0.001
    top = layout.create_cell("TOP")
    li = layout.layer(layer, datatype)
    for i in range(n_shapes):
        top.shapes(li).insert(pya.Box(i * 100, 0, i * 100 + 50, 50))
    return layout


def _write_gds(tmp_path, name: str = "design.gds", n_shapes: int = 1) -> str:
    path = os.path.join(str(tmp_path), name)
    lay = _make_layout(n_shapes=n_shapes)
    lay.write(path)
    return path


def _add_shape(layout, *, layer: int = 1, datatype: int = 0,
               x: int = 1000, y: int = 1000):
    top = layout.top_cell() or layout.create_cell("TOP")
    li = layout.layer(layer, datatype)
    top.shapes(li).insert(pya.Box(x, y, x + 50, y + 50))


def _init(layout, gds_path, *, mode: str = "auto"):
    """Convenience wrapper around vc_init."""
    return handlers.vc_init(
        {"mode": mode, "gds_path": gds_path},
        layout=layout,
        gds_path_hint=gds_path,
    )


@pytest.fixture(autouse=True)
def _clean_registry():
    """Always start with a clean REGISTRY to isolate tests."""
    reset = getattr(handlers, "reset_registry", None)
    assert callable(reset), (
        "tools.vc_mcp_handlers MUST expose a test-only reset_registry() "
        "callable so tests can isolate their registry state."
    )
    reset()
    yield
    reset()


# ---------------------------------------------------------------------------
# TestVcInit — MCP-1
# ---------------------------------------------------------------------------


class TestVcInit:
    def test_init_auto_on_virgin_path_returns_memory(self, tmp_path):
        """RB-1: with no sidecar, auto → memory."""
        layout = _make_layout()
        gds = _write_gds(tmp_path)

        resp = _init(layout, gds)

        assert resp.get("ok") is True, f"expected ok=True, got {resp!r}"
        assert resp.get("mode") == "memory", f"expected mode=memory, got {resp!r}"
        assert isinstance(resp.get("repo_path"), str) and resp["repo_path"], (
            f"expected non-empty repo_path string, got {resp!r}"
        )

    def test_init_memory_forces_memory_even_if_sidecar_exists(self, tmp_path):
        """mode='memory' never promotes to disk."""
        from plugin.klayoutclaw_vc import repo as repo_mod
        layout = _make_layout()
        gds = _write_gds(tmp_path)

        # Seed a valid sidecar so auto-mode WOULD pick disk.
        seed_layout = _make_layout()
        seed_handle = repo_mod.init(gds)
        assert seed_handle.checkpoint(seed_layout, "seed")["ok"] is True
        repo_mod.migrate_to_disk(seed_handle, gds)
        seed_handle.close()
        assert os.path.isdir(gds + ".vc"), "sidecar should exist after migrate_to_disk"

        handlers.reset_registry()
        resp = _init(layout, gds, mode="memory")
        assert resp.get("ok") is True
        assert resp.get("mode") == "memory", (
            f"mode='memory' must NEVER auto-upgrade to disk. Got: {resp!r}"
        )

    def test_init_disk_on_writable_virgin_path_succeeds(self, tmp_path):
        """Positive disk-mode init: on a writable virgin path, disk mode
        MUST succeed, create a real sidecar directory, and materialise a
        .git/ inside it.  Guards against a handler that always falls back
        to memory or reports success without actually building the sidecar."""
        layout = _make_layout()
        gds = _write_gds(tmp_path)
        sidecar = gds + ".vc"
        assert not os.path.exists(sidecar), (
            "pre-cond: sidecar must NOT exist before disk-mode init"
        )

        resp = _init(layout, gds, mode="disk")

        assert resp.get("ok") is True, f"disk init on writable path failed: {resp!r}"
        assert resp.get("mode") == "disk", (
            f"disk init must return mode=disk (no silent fallback): {resp!r}"
        )
        repo_path = resp.get("repo_path")
        assert isinstance(repo_path, str) and repo_path, (
            f"repo_path must be a non-empty str: {resp!r}"
        )
        # The repo_path must be the sidecar next to the gds.
        assert repo_path.rstrip("/").endswith("design.gds.vc"), (
            f"repo_path must be the sidecar '<gds>.vc'; got {repo_path!r}"
        )
        # Sidecar directory must exist on disk with a real .git subdirectory.
        assert os.path.isdir(sidecar), (
            f"disk-mode init must create sidecar directory at {sidecar}"
        )
        assert os.path.isdir(os.path.join(sidecar, ".git")), (
            f"disk-mode init must initialise a real git repo at {sidecar}/.git"
        )

    def test_init_disk_requires_writable_sidecar(self, tmp_path):
        """mode='disk' hard-requires a writable sidecar — NO silent
        fallback; and no partial sidecar is left behind on failure."""
        # Running as root bypasses POSIX file-mode checks, so this test
        # can't meaningfully exercise the hard-require contract.
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            pytest.skip(
                "running as root — POSIX chmod 0o500 is ineffective, "
                "so the writable-sidecar hard-require contract can't "
                "be exercised here."
            )

        layout = _make_layout()

        # Create a non-writable sidecar parent so disk-mode can't create
        # or write into it.  We achieve this by putting the gds INSIDE a
        # directory we then chmod 0o500.
        protected_dir = os.path.join(str(tmp_path), "protected")
        os.makedirs(protected_dir, exist_ok=True)
        gds_in_protected = os.path.join(protected_dir, "design.gds")
        _make_layout().write(gds_in_protected)

        sidecar = gds_in_protected + ".vc"
        try:
            os.chmod(protected_dir, 0o500)
            resp = _init(layout, gds_in_protected, mode="disk")
            # Capture sidecar-existence BEFORE restoring permissions so we
            # see the post-failure state as the handler left it.
            sidecar_exists_after_fail = os.path.exists(sidecar)
        finally:
            # Always restore so pytest tmp_path cleanup works.
            os.chmod(protected_dir, 0o700)

        assert resp.get("ok") is False, (
            f"disk mode on non-writable sidecar MUST fail, got {resp!r}"
        )
        reason = resp.get("reason", "")
        assert isinstance(reason, str) and reason, f"reason must be non-empty, got {resp!r}"
        low = reason.lower()
        assert "disk" in low and ("writ" in low or "permission" in low or "sidecar" in low), (
            f"reason must mention disk/sidecar/writable: {reason!r}"
        )
        # Hard-require contract: no partial sidecar should have been created.
        assert not sidecar_exists_after_fail, (
            f"disk-mode hard-require violation: a partial sidecar was "
            f"left at {sidecar} after a failed init. Implementation must "
            "clean up on failure or avoid creating the dir before verifying "
            "writability."
        )

    def test_init_missing_gds_path_returns_error(self, tmp_path):
        layout = _make_layout()
        resp = handlers.vc_init({"mode": "auto"}, layout=layout, gds_path_hint=None)

        assert resp.get("ok") is False, f"expected ok=False on missing gds_path: {resp!r}"
        reason = resp.get("reason", "").lower()
        assert "gds_path" in reason or "required" in reason, (
            f"reason must mention gds_path/required, got {resp!r}"
        )

    def test_init_auto_on_existing_sidecar_returns_disk(self, tmp_path):
        """RB-1: auto mode detects existing valid sidecar → disk."""
        from plugin.klayoutclaw_vc import repo as repo_mod
        layout = _make_layout()
        gds = _write_gds(tmp_path)

        # Seed a valid sidecar.
        seed_layout = _make_layout()
        seed_handle = repo_mod.init(gds)
        cp = seed_handle.checkpoint(seed_layout, "seed")
        assert cp["ok"] is True
        repo_mod.migrate_to_disk(seed_handle, gds)
        seed_handle.close()

        handlers.reset_registry()
        resp = _init(layout, gds, mode="auto")

        assert resp.get("ok") is True
        assert resp.get("mode") == "disk", (
            f"auto mode with valid sidecar must pick disk, got {resp!r}"
        )

    def test_init_reinit_is_allowed(self, tmp_path):
        """G5 auto-invalidates the prior handle; re-init must succeed."""
        layout = _make_layout()
        gds = _write_gds(tmp_path)

        r1 = _init(layout, gds)
        assert r1["ok"] is True
        r2 = _init(layout, gds)
        assert r2["ok"] is True, f"re-init must succeed, got {r2!r}"


# ---------------------------------------------------------------------------
# TestVcCheckpoint — MCP-2
# ---------------------------------------------------------------------------


class TestVcCheckpoint:
    def test_checkpoint_happy_path(self, tmp_path):
        layout = _make_layout()
        gds = _write_gds(tmp_path)
        assert _init(layout, gds)["ok"] is True

        resp = handlers.vc_checkpoint(
            {"message": "baseline"}, layout=layout, gds_path_hint=gds
        )

        assert resp.get("ok") is True, f"checkpoint failed: {resp!r}"
        sha = resp.get("sha")
        assert isinstance(sha, str) and len(sha) >= 7, f"sha missing/short: {resp!r}"
        ts = resp.get("ts")
        assert isinstance(ts, str) and ts, f"ts missing: {resp!r}"

    def test_checkpoint_passes_tags(self, tmp_path):
        layout = _make_layout()
        gds = _write_gds(tmp_path)
        assert _init(layout, gds)["ok"] is True

        resp = handlers.vc_checkpoint(
            {"message": "tagged", "tags": ["v1.0"]},
            layout=layout, gds_path_hint=gds,
        )
        assert resp.get("ok") is True

        hist = handlers.vc_history({}, layout=layout, gds_path_hint=gds)
        assert hist.get("ok") is True
        commits = hist.get("commits", [])
        assert len(commits) == 1
        assert "v1.0" in commits[0].get("tags", []), (
            f"tag v1.0 should be in commit tags, got: {commits[0]}"
        )


# ---------------------------------------------------------------------------
# TestVcHistory — MCP-3
# ---------------------------------------------------------------------------


class TestVcHistory:
    def test_history_wraps_g5_list_in_ok_envelope(self, tmp_path):
        layout = _make_layout()
        gds = _write_gds(tmp_path)
        assert _init(layout, gds)["ok"] is True

        for msg in ["first", "second", "third"]:
            _add_shape(layout, x=len(msg) * 10)
            r = handlers.vc_checkpoint(
                {"message": msg}, layout=layout, gds_path_hint=gds
            )
            assert r["ok"] is True, f"checkpoint {msg!r} failed: {r!r}"

        resp = handlers.vc_history({}, layout=layout, gds_path_hint=gds)

        assert resp.get("ok") is True, f"history must wrap as {{ok:True, ...}}: {resp!r}"
        commits = resp.get("commits")
        assert isinstance(commits, list), f"commits must be a list: {resp!r}"
        assert len(commits) == 3, f"expected 3 commits, got {len(commits)}: {commits!r}"

        for c in commits:
            for key in ("sha", "message", "ts", "tags", "branch", "stats"):
                assert key in c, f"commit missing key {key!r}: {c!r}"
            stats = c["stats"]
            assert isinstance(stats, dict)
            for sk in ("polygon_count", "layer_count", "bbox"):
                assert sk in stats, f"stats missing {sk!r}: {stats!r}"

    def test_history_honours_limit(self, tmp_path):
        layout = _make_layout()
        gds = _write_gds(tmp_path)
        assert _init(layout, gds)["ok"] is True

        for msg in ["a", "b", "c"]:
            _add_shape(layout, x=ord(msg) * 10)
            handlers.vc_checkpoint({"message": msg}, layout=layout, gds_path_hint=gds)

        resp = handlers.vc_history({"limit": 2}, layout=layout, gds_path_hint=gds)
        assert resp.get("ok") is True
        assert len(resp["commits"]) == 2, (
            f"limit=2 must cap commits at 2, got {len(resp['commits'])}"
        )


# ---------------------------------------------------------------------------
# TestVcCheckout — MCP-4
# ---------------------------------------------------------------------------


class TestVcCheckout:
    def test_checkout_by_sha_restores_git_state(self, tmp_path):
        """Checkout must actually move HEAD in the underlying sidecar —
        not just echo the requested sha back.  Proof: re-export HEAD
        after checkout and assert the polygon count matches state A,
        not state B.
        """
        # State A: layout with EXACTLY 1 polygon.
        layout_a = _make_layout(n_shapes=1)
        gds = _write_gds(tmp_path)
        assert _init(layout_a, gds)["ok"] is True

        cp_a = handlers.vc_checkpoint(
            {"message": "state-A (1 polygon)"},
            layout=layout_a, gds_path_hint=gds,
        )
        assert cp_a["ok"] is True
        sha_a = cp_a["sha"]

        # State B: add 4 more polygons → now 5 total.
        for i in range(4):
            _add_shape(layout_a, x=500 + i * 100)
        cp_b = handlers.vc_checkpoint(
            {"message": "state-B (5 polygons)"},
            layout=layout_a, gds_path_hint=gds,
        )
        assert cp_b["ok"] is True
        sha_b = cp_b["sha"]
        assert sha_a != sha_b

        # Sanity: history should be 2 commits with different polygon counts.
        hist_before = handlers.vc_history({}, layout=layout_a, gds_path_hint=gds)
        assert hist_before["ok"] is True
        assert len(hist_before["commits"]) == 2
        # commits[0] is HEAD (=state B), commits[1] is state A.
        by_sha = {c["sha"]: c for c in hist_before["commits"]}
        assert by_sha[sha_a]["stats"]["polygon_count"] == 1
        assert by_sha[sha_b]["stats"]["polygon_count"] == 5

        # --- The checkout under test. ---
        resp = handlers.vc_checkout(
            {"ref": sha_a}, layout=layout_a, gds_path_hint=gds,
        )
        assert resp.get("ok") is True, f"checkout failed: {resp!r}"
        assert resp.get("sha") == sha_a, (
            f"returned sha must match requested: {resp!r}"
        )

        # MCP-4: the handler MUST rewrite the caller's in-memory layout
        # to reflect state A — NOT only move the sidecar HEAD.  Spec
        # §5.2.4 MCP-4 / plan line 861: "restore the layout in the
        # current view".  A buggy impl that calls
        # ``RepoHandle.checkout(ref)`` on the sidecar but forgets to
        # re-populate the live ``pya.Layout`` would leave ``layout_a``
        # with 5 polygons (state B) while the sidecar is at sha_a.
        #
        # Count live polygons directly on the passed-in layout BEFORE
        # the export-HEAD round-trip, so an in-memory-rewrite failure
        # surfaces with a clear message rather than being masked by the
        # softer export mismatch.
        live_poly_count = 0
        for cell in layout_a.each_cell():
            for _li in layout_a.layer_indexes():
                for _shape in cell.shapes(_li).each():
                    live_poly_count += 1
        assert live_poly_count == 1, (
            f"vc_checkout did not rewrite in-memory layout: "
            f"{live_poly_count} polygons (expected 1 for state A). "
            "Handler must re-populate the live layout after calling "
            "RepoHandle.checkout() — sidecar HEAD moving is necessary "
            "but not sufficient per MCP-4."
        )

        # PROOF the working tree / HEAD actually moved: export HEAD and
        # count polygons.  A handler that returns ok=True without calling
        # into RepoHandle.checkout() would leave HEAD at sha_b → 5 polygons.
        exp_head = handlers.vc_export(
            {"ref": "HEAD", "format": "gds"},
            layout=layout_a, gds_path_hint=gds,
        )
        assert exp_head.get("ok") is True, (
            f"export(HEAD) must succeed after checkout: {exp_head!r}"
        )

        # Resolve the exported bytes — either inlined (base64) or at a path.
        if exp_head.get("truncated"):
            path = exp_head["path"]
            gds_bytes = open(path, "rb").read()
        else:
            gds_bytes = base64.b64decode(exp_head["content"])

        import tempfile as _tmp
        with _tmp.NamedTemporaryFile(suffix=".gds", delete=False) as tmp_fh:
            tmp_fh.write(gds_bytes)
            tmp_gds = tmp_fh.name
        try:
            reloaded = pya.Layout()
            reloaded.read(tmp_gds)
            reloaded_count = 0
            for c in reloaded.each_cell():
                for li in reloaded.layer_indexes():
                    reloaded_count += c.shapes(li).size()
            assert reloaded_count == 1, (
                f"checkout(sha_a) must restore state A (1 polygon). "
                f"Exported HEAD has {reloaded_count} polygons — "
                "the handler likely returned ok=True without calling "
                "RepoHandle.checkout()."
            )
        finally:
            try:
                os.unlink(tmp_gds)
            except Exception:
                pass

    def test_checkout_bad_ref_returns_error(self, tmp_path):
        layout = _make_layout()
        gds = _write_gds(tmp_path)
        assert _init(layout, gds)["ok"] is True
        handlers.vc_checkpoint({"message": "initial"}, layout=layout, gds_path_hint=gds)

        resp = handlers.vc_checkout(
            {"ref": "doesnotexist_deadbeef"}, layout=layout, gds_path_hint=gds,
        )
        assert resp.get("ok") is False, f"bad ref must fail, got {resp!r}"
        assert isinstance(resp.get("reason"), str) and resp["reason"], (
            f"reason must be non-empty, got {resp!r}"
        )


# ---------------------------------------------------------------------------
# TestVcDiff — MCP-5 — T13
# ---------------------------------------------------------------------------


class TestVcDiff:
    def test_diff_reports_polygon_count_delta(self, tmp_path):
        """T13: add a polygon between two checkpoints; delta != 0."""
        layout = _make_layout()
        gds = _write_gds(tmp_path)
        assert _init(layout, gds)["ok"] is True

        cp_a = handlers.vc_checkpoint(
            {"message": "before"}, layout=layout, gds_path_hint=gds,
        )
        assert cp_a["ok"] is True

        # Mutate the layout: add a new shape on a new layer so it's a real
        # diff, not a no-op.
        _add_shape(layout, layer=2, x=5000)

        cp_b = handlers.vc_checkpoint(
            {"message": "after"}, layout=layout, gds_path_hint=gds,
        )
        assert cp_b["ok"] is True

        resp = handlers.vc_diff(
            {"ref_a": cp_a["sha"], "ref_b": cp_b["sha"]},
            layout=layout, gds_path_hint=gds,
        )

        assert isinstance(resp, dict), f"diff must return dict: {resp!r}"
        for key in ("added_polygons", "removed_polygons", "moved_polygons",
                    "layer_stats", "bbox_delta", "polygon_count_delta"):
            assert key in resp, f"diff missing key {key!r}: {resp!r}"
        delta = resp["polygon_count_delta"]
        assert delta != 0, f"polygon_count_delta should be non-zero: {resp!r}"


# ---------------------------------------------------------------------------
# TestVcBranch — MCP-6 — T12 + T46
# ---------------------------------------------------------------------------


class TestVcBranch:
    def test_list_wraps_bare_list_in_ok_envelope(self, tmp_path):
        """T12 precursor: G5's branch(op='list') returns a bare list;
        handler must wrap as {ok: True, names: [...]}. """
        layout = _make_layout()
        gds = _write_gds(tmp_path)
        assert _init(layout, gds)["ok"] is True
        handlers.vc_checkpoint({"message": "base"}, layout=layout, gds_path_hint=gds)

        resp = handlers.vc_branch({"op": "list"}, layout=layout, gds_path_hint=gds)

        assert resp.get("ok") is True, f"branch list must wrap as ok=True dict: {resp!r}"
        names = resp.get("names")
        assert isinstance(names, list), f"names must be a list: {resp!r}"
        # After one checkpoint there is at least the default branch present.
        assert len(names) >= 1, f"expected >=1 branch, got: {names!r}"
        for n in names:
            assert isinstance(n, str) and n, f"branch name must be non-empty str: {n!r}"

    def test_create_and_switch_happy_path(self, tmp_path):
        """T12: create + switch branch."""
        layout = _make_layout()
        gds = _write_gds(tmp_path)
        assert _init(layout, gds)["ok"] is True
        handlers.vc_checkpoint({"message": "base"}, layout=layout, gds_path_hint=gds)

        cr = handlers.vc_branch(
            {"op": "create", "name": "feature-x"},
            layout=layout, gds_path_hint=gds,
        )
        assert cr.get("ok") is True, f"create failed: {cr!r}"

        sw = handlers.vc_branch(
            {"op": "switch", "name": "feature-x"},
            layout=layout, gds_path_hint=gds,
        )
        assert sw.get("ok") is True, f"switch failed: {sw!r}"

        # Confirm via list that the branch shows up.
        ls = handlers.vc_branch({"op": "list"}, layout=layout, gds_path_hint=gds)
        assert "feature-x" in ls.get("names", []), (
            f"feature-x must appear in branch list: {ls!r}"
        )

    def test_merge_conflict_T46(self, tmp_path):
        """T46: two branches REPLACE the same shape on the same (cell,
        layer, datatype) with different geometry — merge MUST return
        ``{ok: False, conflicts: [...]}`` AND leave both branches' HEADs
        unchanged.

        Pattern follows G5's own ``test_vc_repo.py::test_branch_merge_
        conflict_returns_structured_error`` (T46 source of truth):
        seed ``main`` with one polygon, then on each branch REPLACE that
        polygon with a differently-located variant on the same
        (cell=TOP, layer=1, datatype=0).  That guarantees
        ``_polygon_conflicts`` in G5 finds distinct signatures on the
        same key.
        """
        gds = _write_gds(tmp_path)

        # Seed main with exactly one polygon at (0, 0, 1000, 1000).
        base = pya.Layout()
        base.dbu = 0.001
        base_top = base.create_cell("TOP")
        base_li = base.layer(1, 0)
        base_top.shapes(base_li).insert(pya.Box(0, 0, 1000, 1000))

        assert _init(base, gds)["ok"] is True
        cp_seed = handlers.vc_checkpoint(
            {"message": "seed"}, layout=base, gds_path_hint=gds,
        )
        assert cp_seed["ok"] is True

        main_status = handlers.vc_status({}, layout=base, gds_path_hint=gds)
        assert main_status.get("ok") is True
        main_branch = main_status["branch"]

        # --- Branch A: REPLACE the polygon with a shifted variant. ---
        assert handlers.vc_branch(
            {"op": "create", "name": "feat/a"},
            layout=base, gds_path_hint=gds,
        )["ok"] is True
        assert handlers.vc_branch(
            {"op": "switch", "name": "feat/a"},
            layout=base, gds_path_hint=gds,
        )["ok"] is True

        variant_a = pya.Layout()
        variant_a.dbu = 0.001
        ta = variant_a.create_cell("TOP")
        la = variant_a.layer(1, 0)
        ta.shapes(la).insert(pya.Box(100, 100, 1100, 1100))
        assert handlers.vc_checkpoint(
            {"message": "A-edit"}, layout=variant_a, gds_path_hint=gds,
        )["ok"] is True

        # --- Branch B: REPLACE the polygon with a DIFFERENTLY shifted
        # variant, branching off main (not off A). ---
        assert handlers.vc_branch(
            {"op": "switch", "name": main_branch},
            layout=base, gds_path_hint=gds,
        )["ok"] is True
        assert handlers.vc_branch(
            {"op": "create", "name": "feat/b"},
            layout=base, gds_path_hint=gds,
        )["ok"] is True
        assert handlers.vc_branch(
            {"op": "switch", "name": "feat/b"},
            layout=base, gds_path_hint=gds,
        )["ok"] is True

        variant_b = pya.Layout()
        variant_b.dbu = 0.001
        tb = variant_b.create_cell("TOP")
        lb = variant_b.layer(1, 0)
        tb.shapes(lb).insert(pya.Box(-100, -100, 900, 900))
        assert handlers.vc_checkpoint(
            {"message": "B-edit"}, layout=variant_b, gds_path_hint=gds,
        )["ok"] is True

        # Capture pre-merge heads for both feature branches.
        hist_a_before = handlers.vc_history(
            {"branch": "feat/a"}, layout=base, gds_path_hint=gds,
        )
        hist_b_before = handlers.vc_history(
            {"branch": "feat/b"}, layout=base, gds_path_hint=gds,
        )
        assert hist_a_before.get("ok") is True
        assert hist_b_before.get("ok") is True
        assert hist_a_before["commits"], (
            "pre-cond: feat/a history must be non-empty before merge"
        )
        assert hist_b_before["commits"], (
            "pre-cond: feat/b history must be non-empty before merge"
        )
        a_before_sha = hist_a_before["commits"][0]["sha"]
        b_before_sha = hist_b_before["commits"][0]["sha"]

        # Switch back to main.  Merging feat/a first MAY succeed (fast-forward
        # or plain merge) — we don't care; the conflict test is on the
        # SECOND merge below.
        assert handlers.vc_branch(
            {"op": "switch", "name": main_branch},
            layout=base, gds_path_hint=gds,
        )["ok"] is True
        handlers.vc_branch(
            {"op": "merge", "name": "feat/a"},
            layout=base, gds_path_hint=gds,
        )  # ignore result — may or may not conflict vs the seed

        # Record main's head AFTER the first merge so we can assert it
        # does not move across the conflicting second merge.
        hist_main_before_conflict = handlers.vc_history(
            {"branch": main_branch}, layout=base, gds_path_hint=gds,
        )
        assert hist_main_before_conflict.get("ok") is True
        assert hist_main_before_conflict["commits"], (
            "pre-cond: main history must be non-empty before conflict merge"
        )
        main_head_before_conflict = hist_main_before_conflict["commits"][0]["sha"]

        # --- THE conflicting merge: main <- feat/b (when main already
        # carries feat/a, or its seed replacement differs from feat/b). ---
        merge = handlers.vc_branch(
            {"op": "merge", "name": "feat/b"},
            layout=base, gds_path_hint=gds,
        )

        # UNCONDITIONAL contract — no if/else escape hatch.
        assert isinstance(merge, dict), f"merge must return dict: {merge!r}"
        assert merge.get("ok") is False, (
            f"T46: conflicting merge MUST report ok=False, got {merge!r}"
        )
        conflicts = merge.get("conflicts")
        assert isinstance(conflicts, list), (
            f"T46: 'conflicts' must be a list, got {merge!r}"
        )
        assert len(conflicts) > 0, (
            f"T46: conflicts must be non-empty, got {merge!r}"
        )
        for i, c in enumerate(conflicts):
            assert isinstance(c, dict), (
                f"T46: conflicts[{i}] must be a dict, got {c!r}"
            )
            for k in ("cell", "layer", "bbox"):
                assert k in c, (
                    f"T46: conflicts[{i}] missing required key {k!r}: {c!r}"
                )

        # Atomicity: NEITHER feature branch's HEAD moved across the failed merge.
        hist_a_after = handlers.vc_history(
            {"branch": "feat/a"}, layout=base, gds_path_hint=gds,
        )
        hist_b_after = handlers.vc_history(
            {"branch": "feat/b"}, layout=base, gds_path_hint=gds,
        )
        assert hist_a_after.get("ok") is True
        assert hist_b_after.get("ok") is True
        assert hist_a_after["commits"], (
            "T46 post: feat/a history corrupted — history is empty"
        )
        assert hist_b_after["commits"], (
            "T46 post: feat/b history corrupted — history is empty"
        )
        assert hist_a_after["commits"][0]["sha"] == a_before_sha, (
            f"T46: feat/a HEAD moved across failed merge: "
            f"{a_before_sha} -> {hist_a_after['commits'][0]['sha']}"
        )
        assert hist_b_after["commits"][0]["sha"] == b_before_sha, (
            f"T46: feat/b HEAD moved across failed merge: "
            f"{b_before_sha} -> {hist_b_after['commits'][0]['sha']}"
        )

        # Atomicity: main's HEAD also must not move across the failed merge.
        hist_main_after = handlers.vc_history(
            {"branch": main_branch}, layout=base, gds_path_hint=gds,
        )
        assert hist_main_after.get("ok") is True
        assert hist_main_after["commits"], (
            "T46 post: main history corrupted — history is empty"
        )
        assert hist_main_after["commits"][0]["sha"] == main_head_before_conflict, (
            f"T46: main HEAD moved across failed merge: "
            f"{main_head_before_conflict} -> {hist_main_after['commits'][0]['sha']}"
        )

    def test_branch_unknown_op_returns_error(self, tmp_path):
        """Robustness: the op-dispatch must default-deny unknown ops with
        an error dict rather than raising or silently succeeding."""
        layout = _make_layout()
        gds = _write_gds(tmp_path)
        assert _init(layout, gds)["ok"] is True
        handlers.vc_checkpoint({"message": "base"}, layout=layout, gds_path_hint=gds)

        resp = handlers.vc_branch(
            {"op": "rebase"}, layout=layout, gds_path_hint=gds,
        )
        assert isinstance(resp, dict), f"unknown-op must return dict: {resp!r}"
        assert resp.get("ok") is False, (
            f"unknown op must be rejected: {resp!r}"
        )
        reason = resp.get("reason", "")
        assert isinstance(reason, str) and reason, (
            f"reason must be non-empty: {resp!r}"
        )


# ---------------------------------------------------------------------------
# TestVcTag — MCP-9 — T40
# ---------------------------------------------------------------------------


class TestVcTag:
    def test_tag_baseline_happy_path(self, tmp_path):
        layout = _make_layout()
        gds = _write_gds(tmp_path)
        assert _init(layout, gds)["ok"] is True
        cp = handlers.vc_checkpoint({"message": "base"}, layout=layout, gds_path_hint=gds)
        assert cp["ok"] is True

        resp = handlers.vc_tag(
            {"name": "baseline"}, layout=layout, gds_path_hint=gds,
        )
        assert resp.get("ok") is True, f"tag failed: {resp!r}"
        assert resp.get("sha") == cp["sha"], (
            f"tag sha should match HEAD sha: {resp!r}"
        )

    def test_tag_duplicate_fails_with_exists_message(self, tmp_path):
        """T40: duplicate tag returns error referencing 'already exists'."""
        layout = _make_layout()
        gds = _write_gds(tmp_path)
        assert _init(layout, gds)["ok"] is True
        handlers.vc_checkpoint({"message": "base"}, layout=layout, gds_path_hint=gds)

        r1 = handlers.vc_tag({"name": "release"}, layout=layout, gds_path_hint=gds)
        assert r1["ok"] is True
        r2 = handlers.vc_tag({"name": "release"}, layout=layout, gds_path_hint=gds)
        assert r2.get("ok") is False, f"duplicate tag must fail, got {r2!r}"
        reason = r2.get("reason", "").lower()
        assert "already exists" in reason or "exists" in reason, (
            f"reason must mention existence, got {r2!r}"
        )

    def test_tag_invalid_ref_fails(self, tmp_path):
        """T40: tag on an invalid ref returns error mentioning not-found/invalid."""
        layout = _make_layout()
        gds = _write_gds(tmp_path)
        assert _init(layout, gds)["ok"] is True
        handlers.vc_checkpoint({"message": "base"}, layout=layout, gds_path_hint=gds)

        resp = handlers.vc_tag(
            {"name": "bogus", "ref": "deadbeef_nosuchref"},
            layout=layout, gds_path_hint=gds,
        )
        assert resp.get("ok") is False, f"invalid ref tag must fail: {resp!r}"
        reason = resp.get("reason", "").lower()
        assert ("not found" in reason or "invalid" in reason or "unknown" in reason), (
            f"reason must mention not-found/invalid: {resp!r}"
        )


# ---------------------------------------------------------------------------
# TestVcExport — MCP-7 — T45 truncation
# ---------------------------------------------------------------------------


class TestVcExport:
    def test_export_small_gds_inlined_base64(self, tmp_path):
        """Small GDS payload: truncated=False, content is valid GDS
        bytes when base64-decoded (proved by ``pya.Layout.read`` succeeding)."""
        layout = _make_layout(n_shapes=1)
        gds = _write_gds(tmp_path)
        assert _init(layout, gds)["ok"] is True
        cp = handlers.vc_checkpoint({"message": "tiny"}, layout=layout, gds_path_hint=gds)
        assert cp["ok"] is True

        resp = handlers.vc_export(
            {"ref": cp["sha"], "format": "gds"},
            layout=layout, gds_path_hint=gds,
        )

        assert resp.get("ok") is True, f"small export must succeed: {resp!r}"
        assert resp.get("format") == "gds"
        assert resp.get("truncated") is False, (
            f"small gds must not be truncated: {resp!r}"
        )
        content = resp.get("content")
        assert isinstance(content, str) and content, (
            f"content must be non-empty str: {resp!r}"
        )
        # Confirm it's valid base64 that decodes to non-empty bytes.
        gds_bytes = base64.b64decode(content)
        assert len(gds_bytes) > 0, "decoded base64 must not be empty"

        # GDS magic-byte sanity: the bytes must load as a real GDS via pya.
        import tempfile as _tmp
        with _tmp.NamedTemporaryFile(suffix=".gds", delete=False) as tmp_fh:
            tmp_fh.write(gds_bytes)
            tmp_gds = tmp_fh.name
        try:
            reloaded = pya.Layout()
            reloaded.read(tmp_gds)  # raises if bytes aren't a real GDS
            reloaded_count = 0
            for c in reloaded.each_cell():
                for li in reloaded.layer_indexes():
                    reloaded_count += c.shapes(li).size()
            assert reloaded_count == 1, (
                f"reloaded GDS must contain the single polygon we checkpointed; "
                f"got {reloaded_count} polygons"
            )
        finally:
            try:
                os.unlink(tmp_gds)
            except Exception:
                pass

    def test_export_small_pya_inlined_string(self, tmp_path):
        """Small pya payload: content is the G5 serialiser output, i.e.
        contains ``import klayout.db as pya`` and ``pya.Layout`` (per
        serializer.py's DM-3 contract)."""
        layout = _make_layout(n_shapes=1)
        gds = _write_gds(tmp_path)
        assert _init(layout, gds)["ok"] is True
        cp = handlers.vc_checkpoint({"message": "tiny"}, layout=layout, gds_path_hint=gds)

        resp = handlers.vc_export(
            {"ref": cp["sha"], "format": "pya"},
            layout=layout, gds_path_hint=gds,
        )
        assert resp.get("ok") is True, f"pya export must succeed: {resp!r}"
        assert resp.get("format") == "pya"
        assert resp.get("truncated") is False
        content = resp.get("content")
        assert isinstance(content, str) and content, (
            f"pya content must be non-empty str: {content[:120]!r}"
        )
        # G5 serializer.py::to_pya_code emits a flat script whose only
        # top-level import is `import klayout.db as pya` and which
        # constructs a `pya.Layout` (DM-3 contract).
        assert "import klayout.db as pya" in content, (
            f"pya export must emit the canonical pya import; got head: "
            f"{content[:200]!r}"
        )
        assert "pya.Layout" in content, (
            f"pya export must reference pya.Layout; got head: {content[:200]!r}"
        )

    def test_export_honors_ref_arg(self, tmp_path):
        """``ref`` must be honoured — the exported bytes reflect the
        requested sha, NOT the current working state.  A handler that
        ignores ``ref`` and re-serialises the live ``layout`` arg would
        return state B's polygon count here."""
        # State A: 1 polygon.
        layout = _make_layout(n_shapes=1)
        gds = _write_gds(tmp_path)
        assert _init(layout, gds)["ok"] is True
        cp_a = handlers.vc_checkpoint(
            {"message": "A"}, layout=layout, gds_path_hint=gds,
        )
        assert cp_a["ok"] is True
        sha_a = cp_a["sha"]

        # State B: 5 polygons total.
        for i in range(4):
            _add_shape(layout, x=1000 + i * 100)
        cp_b = handlers.vc_checkpoint(
            {"message": "B"}, layout=layout, gds_path_hint=gds,
        )
        assert cp_b["ok"] is True
        assert cp_b["sha"] != sha_a

        # Export sha_a — must return state A's bytes (1 polygon), NOT B's.
        resp = handlers.vc_export(
            {"ref": sha_a, "format": "gds"},
            layout=layout, gds_path_hint=gds,
        )
        assert resp.get("ok") is True, f"export(sha_a) failed: {resp!r}"

        if resp.get("truncated"):
            path = resp["path"]
            gds_bytes = open(path, "rb").read()
        else:
            gds_bytes = base64.b64decode(resp["content"])

        import tempfile as _tmp
        with _tmp.NamedTemporaryFile(suffix=".gds", delete=False) as tmp_fh:
            tmp_fh.write(gds_bytes)
            tmp_gds = tmp_fh.name
        try:
            reloaded = pya.Layout()
            reloaded.read(tmp_gds)
            count = 0
            for c in reloaded.each_cell():
                for li in reloaded.layer_indexes():
                    count += c.shapes(li).size()
            assert count == 1, (
                f"export({sha_a!r}) must return state A's bytes (1 polygon); "
                f"got {count} polygons — handler likely ignored the ref and "
                "exported the live layout instead."
            )
        finally:
            try:
                os.unlink(tmp_gds)
            except Exception:
                pass

        # Same check in pya format — ref-honouring must survive DM-3
        # reconstruction.  G5's to_pya_code (serializer.py:422-530)
        # emits a FLAT script that inlines the snapshot as a ``_DOC``
        # dict literal and iterates it from a fixed boilerplate
        # containing four ``.insert(`` callsites regardless of shape
        # count (text/path/polygon/instance branches).  So counting
        # ``.insert(`` callsites is not valid; instead we execute the
        # emitted code in a fresh namespace (same pattern as the T45
        # pya truncation test below) and count shapes on the
        # reconstructed ``layout``.
        resp_pya = handlers.vc_export(
            {"ref": sha_a, "format": "pya"},
            layout=layout, gds_path_hint=gds,
        )
        assert resp_pya.get("ok") is True
        pya_content = resp_pya["content"]

        # DM-3: executing the emitted code in a fresh namespace binds
        # a module-level ``layout`` variable (pya.Layout).  That layout
        # must carry state A (1 polygon), NOT state B (5 polygons) —
        # proving the handler honoured the ``ref`` argument and did
        # not re-serialise the live 5-polygon ``layout`` arg.
        exec_ns: dict = {}
        exec(compile(pya_content, "<pya_export_sha_a>", "exec"), exec_ns)
        reconstructed = exec_ns.get("layout")
        assert reconstructed is not None and isinstance(reconstructed, pya.Layout), (
            "DM-3: pya export must bind a module-level `layout` pya.Layout "
            f"after exec; namespace keys: {sorted(exec_ns.keys())}; "
            f"content head: {pya_content[:200]!r}"
        )
        recon_count = 0
        for c in reconstructed.each_cell():
            for lidx in reconstructed.layer_indexes():
                recon_count += c.shapes(lidx).size()
        assert recon_count == 1, (
            f"pya export of sha_a must reconstruct state A's 1-polygon layout; "
            f"got {recon_count} polygons after DM-3 reconstruction — handler "
            "likely ignored the `ref` argument and exported the live "
            "5-polygon layout instead."
        )

    def test_export_large_gds_truncated_to_tempfile_T45(self, tmp_path):
        """T45: large GDS export exceeds VC_EXPORT_INLINE_CAP_BYTES and is
        written to a tempfile; returned bytes on disk reload into a layout
        containing the expected number of shapes."""
        cap = getattr(handlers, "VC_EXPORT_INLINE_CAP_BYTES", None)
        assert cap == 256 * 1024, (
            "VC_EXPORT_INLINE_CAP_BYTES must be defined as 256*1024 "
            f"in tools.vc_mcp_handlers, got {cap!r}"
        )

        # Generate a layout large enough that gds bytes exceed the cap.
        # ~6000 shapes across 4 layers gets comfortably over 256 KB in GDS.
        layout = pya.Layout()
        layout.dbu = 0.001
        top = layout.create_cell("TOP")
        n_per_layer = 1600
        total = 0
        for ly_idx in range(4):
            li = layout.layer(ly_idx + 1, 0)
            for i in range(n_per_layer):
                top.shapes(li).insert(
                    pya.Box(i * 120, ly_idx * 200, i * 120 + 80, ly_idx * 200 + 80)
                )
                total += 1

        gds = os.path.join(str(tmp_path), "big.gds")
        layout.write(gds)
        assert os.path.getsize(gds) > cap, (
            f"precondition: on-disk gds must exceed cap ({os.path.getsize(gds)} vs {cap})"
        )

        assert _init(layout, gds)["ok"] is True
        cp = handlers.vc_checkpoint(
            {"message": "big"}, layout=layout, gds_path_hint=gds,
        )
        assert cp["ok"] is True, f"large checkpoint must succeed: {cp!r}"

        resp = handlers.vc_export(
            {"ref": cp["sha"], "format": "gds"},
            layout=layout, gds_path_hint=gds,
        )

        assert resp.get("ok") is True, f"large export must succeed: {resp!r}"
        assert resp.get("truncated") is True, (
            f"export exceeding {cap} bytes must be truncated: {resp!r}"
        )
        assert resp.get("format") == "gds"
        # MCP-7 / plan line 897: truncated responses are path-mode only —
        # `content` MUST NOT be populated with the oversize payload.
        content = resp.get("content")
        assert content in (None, "", b""), (
            f"truncated gds response must NOT populate `content` "
            f"(path-mode only per MCP-7); got content of length "
            f"{len(content) if content is not None else 0!r}"
        )
        path = resp.get("path")
        assert isinstance(path, str) and os.path.isabs(path), (
            f"path must be absolute: {resp!r}"
        )
        assert os.path.exists(path), f"truncated path must exist on disk: {path}"
        assert os.path.getsize(path) > cap, (
            f"tempfile must actually contain the (>cap) payload, got {os.path.getsize(path)}"
        )

        # And the bytes reload into a valid pya.Layout with the same shape count.
        reloaded = pya.Layout()
        reloaded.read(path)
        got = 0
        for c in reloaded.each_cell():
            for lidx in reloaded.layer_indexes():
                got += c.shapes(lidx).size()
        assert got == total, (
            f"reloaded shape count {got} must equal original {total}"
        )

    def test_export_large_pya_truncated_to_tempfile_T45_pya(self, tmp_path):
        """T45 (pya variant): an oversize ``pya`` export MUST truncate
        to a tempfile — spec §5.2.4 MCP-7 and plan line 897 both mandate
        the cap applies to BOTH formats.  An impl that inlines >256 KB
        of pya code (ignoring the cap) or that omits the tempfile
        branch for ``format="pya"`` must fail here.

        Contract (path-mode only):
          * ``ok=True``, ``format="pya"``, ``truncated=True``
          * ``content`` is absent / empty (NOT populated with the payload)
          * ``path`` is an absolute, existing file
          * the tempfile contains real, executable pya code
            (``import klayout.db as pya`` + ``pya.Layout``)
          * DM-3 round-trip: executing the code in a fresh namespace
            yields a ``pya.Layout`` with the expected shape count
        """
        cap = getattr(handlers, "VC_EXPORT_INLINE_CAP_BYTES", None)
        assert cap == 256 * 1024, (
            "VC_EXPORT_INLINE_CAP_BYTES must be defined as 256*1024 "
            f"in tools.vc_mcp_handlers, got {cap!r}"
        )

        # Build a layout large enough that to_pya_code(layout) > cap.
        # Pya code is verbose (multiple tokens per shape) so 6400 shapes
        # comfortably exceeds 256 KB as pya text.
        layout = pya.Layout()
        layout.dbu = 0.001
        top = layout.create_cell("TOP")
        n_per_layer = 1600
        total = 0
        for ly_idx in range(4):
            li = layout.layer(ly_idx + 1, 0)
            for i in range(n_per_layer):
                top.shapes(li).insert(
                    pya.Box(i * 120, ly_idx * 200, i * 120 + 80, ly_idx * 200 + 80)
                )
                total += 1

        gds = os.path.join(str(tmp_path), "big_pya.gds")
        layout.write(gds)

        # Precondition: the pya serialisation of this layout must exceed cap.
        # We compute this directly via G5's serializer — this is a read-only
        # test helper, not an assertion on handler internals.
        from plugin.klayoutclaw_vc import serializer as _ser
        pya_code_precheck = _ser.to_pya_code(layout)
        assert len(pya_code_precheck.encode("utf-8")) > cap, (
            f"precondition: to_pya_code(layout) must exceed {cap} bytes "
            f"to exercise the oversize path; got "
            f"{len(pya_code_precheck.encode('utf-8'))} bytes"
        )

        assert _init(layout, gds)["ok"] is True
        cp = handlers.vc_checkpoint(
            {"message": "big-pya"}, layout=layout, gds_path_hint=gds,
        )
        assert cp["ok"] is True, f"large checkpoint must succeed: {cp!r}"

        resp = handlers.vc_export(
            {"ref": cp["sha"], "format": "pya"},
            layout=layout, gds_path_hint=gds,
        )

        assert resp.get("ok") is True, f"large pya export must succeed: {resp!r}"
        assert resp.get("format") == "pya"
        assert resp.get("truncated") is True, (
            f"pya export exceeding {cap} bytes MUST be truncated — "
            f"the cap applies to BOTH formats per MCP-7 / plan line 897. "
            f"Got: {resp!r}"
        )

        # content MUST NOT be populated (path-mode only).
        content = resp.get("content")
        assert content in (None, ""), (
            f"truncated pya response must NOT populate `content` "
            f"(path-mode only per MCP-7); got content of length "
            f"{len(content) if content is not None else 0!r}"
        )

        path = resp.get("path")
        assert isinstance(path, str) and os.path.isabs(path), (
            f"truncated pya export must return an absolute path, got {resp!r}"
        )
        assert os.path.exists(path), (
            f"truncated pya export path must exist on disk: {path}"
        )
        assert os.path.getsize(path) > cap, (
            f"tempfile must actually contain the (>cap) payload, got "
            f"{os.path.getsize(path)}"
        )

        # The file content must be real executable pya code.
        with open(path, "r", encoding="utf-8") as fh:
            pya_code = fh.read()
        assert "import klayout.db as pya" in pya_code, (
            f"truncated pya tempfile must contain the canonical pya import; "
            f"head: {pya_code[:200]!r}"
        )
        assert "pya.Layout" in pya_code, (
            f"truncated pya tempfile must reference pya.Layout; "
            f"head: {pya_code[:200]!r}"
        )

        # DM-3 round-trip: executing the pya code in a FRESH namespace
        # must yield a bound ``layout`` variable that is a valid
        # pya.Layout with the original shape count.  Per G5
        # serializer.py DM-3 contract: "the emitted code leaves a
        # module-level ``layout`` variable bound to the reconstructed
        # pya.Layout after execution."
        #
        # We use in-process ``exec()`` rather than a subprocess here —
        # the purpose is to prove the tempfile is real, executable pya
        # code, and exec() with a dedicated namespace is deterministic
        # and avoids subprocess serialisation fragility.
        exec_ns: dict = {}
        exec(compile(pya_code, path, "exec"), exec_ns)
        reconstructed = exec_ns.get("layout")
        assert reconstructed is not None, (
            "DM-3: executed pya code must bind a module-level `layout` "
            f"variable; exec namespace keys: {sorted(exec_ns.keys())}"
        )
        assert isinstance(reconstructed, pya.Layout), (
            f"DM-3: `layout` must be a pya.Layout; got {type(reconstructed).__name__}"
        )

        roundtripped = 0
        for c in reconstructed.each_cell():
            for lidx in reconstructed.layer_indexes():
                roundtripped += c.shapes(lidx).size()
        assert roundtripped == total, (
            f"DM-3 round-trip: reconstructed layout must have {total} "
            f"shapes (same as original), got {roundtripped}"
        )


# ---------------------------------------------------------------------------
# TestVcStatus — MCP-8
# ---------------------------------------------------------------------------


class TestVcStatus:
    def test_status_uninit_returns_sentinel(self, tmp_path):
        """Uninit status must NOT raise and must return the uniform sentinel."""
        layout = _make_layout()
        gds = _write_gds(tmp_path)  # file exists but no init

        resp = handlers.vc_status({}, layout=layout, gds_path_hint=gds)

        assert isinstance(resp, dict), f"status must return dict, got {resp!r}"
        assert resp.get("ok") is False
        assert resp.get("reason") == UNINIT_REASON, (
            f"uninit status must return uniform sentinel: {resp!r}"
        )

    def test_status_initialized_passthrough(self, tmp_path):
        layout = _make_layout()
        gds = _write_gds(tmp_path)
        assert _init(layout, gds)["ok"] is True
        cp = handlers.vc_checkpoint({"message": "init"}, layout=layout, gds_path_hint=gds)
        assert cp["ok"] is True

        resp = handlers.vc_status({}, layout=layout, gds_path_hint=gds)
        assert resp.get("ok") is True, f"status after init must be ok: {resp!r}"
        for key in ("branch", "dirty", "last_checkpoint_ts", "pending", "mode"):
            assert key in resp, f"status missing {key!r}: {resp!r}"
        assert resp["mode"] in ("memory", "disk")


# ---------------------------------------------------------------------------
# TestGracefulDegradation — §8.3 cross-cutting
# ---------------------------------------------------------------------------


class TestGracefulDegradation:
    """When VC is not initialized, every handler EXCEPT vc_init and vc_status
    must return the uniform sentinel ``{ok: False, reason: "vc not initialized"}``."""

    @pytest.mark.parametrize("tool,args", [
        ("vc_checkpoint", {"message": "x"}),
        ("vc_history", {}),
        ("vc_checkout", {"ref": "HEAD"}),
        ("vc_diff", {"ref_a": "HEAD", "ref_b": "HEAD~1"}),
        ("vc_branch", {"op": "list"}),
        ("vc_tag", {"name": "x"}),
        ("vc_export", {"ref": "HEAD", "format": "gds"}),
    ])
    def test_uninit_returns_uniform_sentinel(self, tmp_path, tool, args):
        layout = _make_layout()
        gds = _write_gds(tmp_path)

        fn = getattr(handlers, tool)
        resp = fn(args, layout=layout, gds_path_hint=gds)

        assert isinstance(resp, dict), f"{tool}: must return dict, got {resp!r}"
        assert resp.get("ok") is False, (
            f"{tool}: uninit must be ok=False, got {resp!r}"
        )
        assert resp.get("reason") == UNINIT_REASON, (
            f"{tool}: uninit reason must be {UNINIT_REASON!r}, got {resp!r}"
        )

    def test_vc_status_uninit_also_uses_sentinel_but_does_not_raise(self, tmp_path):
        """vc_status is always callable; uninit still yields the sentinel."""
        layout = _make_layout()
        gds = _write_gds(tmp_path)
        resp = handlers.vc_status({}, layout=layout, gds_path_hint=gds)
        assert resp.get("ok") is False
        assert resp.get("reason") == UNINIT_REASON

    def test_vc_status_on_unknown_layout_does_not_raise(self, tmp_path):
        """status must be cheap: constructing + calling on an unknown layout
        must not raise — at most returns the sentinel."""
        layout = pya.Layout()  # totally fresh, never seen before
        # No gds path hint on purpose.
        resp = handlers.vc_status({}, layout=layout, gds_path_hint=None)
        assert isinstance(resp, dict)
        assert resp.get("ok") is False
        assert resp.get("reason") == UNINIT_REASON


# ---------------------------------------------------------------------------
# TestLifecycle — T9 (init -> cp -> cp -> history -> checkout)
# ---------------------------------------------------------------------------


class TestLifecycle:
    def test_T9_full_memory_lifecycle(self, tmp_path):
        """T9: init memory → checkpoint A → checkpoint B → history shows 2
        → checkout A → checkout still valid."""
        layout = _make_layout()
        gds = _write_gds(tmp_path)

        init_resp = _init(layout, gds, mode="memory")
        assert init_resp["ok"] is True
        assert init_resp["mode"] == "memory"

        a = handlers.vc_checkpoint({"message": "A"}, layout=layout, gds_path_hint=gds)
        assert a["ok"] is True

        _add_shape(layout, x=2000)
        b = handlers.vc_checkpoint({"message": "B"}, layout=layout, gds_path_hint=gds)
        assert b["ok"] is True

        hist = handlers.vc_history({}, layout=layout, gds_path_hint=gds)
        assert hist["ok"] is True
        assert len(hist["commits"]) == 2, (
            f"expected 2 commits after 2 checkpoints, got {hist!r}"
        )

        co = handlers.vc_checkout({"ref": a["sha"]}, layout=layout, gds_path_hint=gds)
        assert co["ok"] is True
        assert co["sha"] == a["sha"]

    def test_T14_full_loop_with_diff(self, tmp_path):
        """T14: init → checkpoint baseline → simulate routing edit (add
        polygon) → checkpoint → history=2 → diff shows non-zero delta."""
        layout = _make_layout(n_shapes=1)
        gds = _write_gds(tmp_path)
        assert _init(layout, gds)["ok"] is True

        base = handlers.vc_checkpoint(
            {"message": "baseline"}, layout=layout, gds_path_hint=gds,
        )
        assert base["ok"] is True

        # Simulate a routing edit — add a polygon on a NEW layer.
        _add_shape(layout, layer=10, x=5000)

        after = handlers.vc_checkpoint(
            {"message": "after routing"}, layout=layout, gds_path_hint=gds,
        )
        assert after["ok"] is True

        hist = handlers.vc_history({}, layout=layout, gds_path_hint=gds)
        assert hist["ok"] is True and len(hist["commits"]) == 2

        diff = handlers.vc_diff(
            {"ref_a": base["sha"], "ref_b": after["sha"]},
            layout=layout, gds_path_hint=gds,
        )
        assert diff.get("polygon_count_delta", 0) != 0, (
            f"T14 diff polygon_count_delta must be non-zero: {diff!r}"
        )


# ---------------------------------------------------------------------------
# TestCrossCutting — T28(a)(b) sidecar behaviour
# ---------------------------------------------------------------------------


class TestCrossCutting:
    def test_T28a_init_on_gds_no_sidecar_returns_memory(self, tmp_path):
        layout = _make_layout()
        gds = _write_gds(tmp_path)
        # Ensure no sidecar.
        sidecar = gds + ".vc"
        assert not os.path.exists(sidecar)

        resp = _init(layout, gds, mode="auto")
        assert resp["ok"] is True
        assert resp["mode"] == "memory"

    def test_T28b_init_on_gds_with_valid_sidecar_returns_disk(self, tmp_path):
        from plugin.klayoutclaw_vc import repo as repo_mod

        layout = _make_layout()
        gds = _write_gds(tmp_path)

        seed = repo_mod.init(gds)
        cp = seed.checkpoint(_make_layout(), "seed")
        assert cp["ok"] is True
        repo_mod.migrate_to_disk(seed, gds)
        seed.close()
        assert os.path.isdir(gds + ".vc")

        handlers.reset_registry()
        resp = _init(layout, gds, mode="auto")
        assert resp["ok"] is True
        assert resp["mode"] == "disk", (
            f"valid sidecar + auto mode must pick disk: {resp!r}"
        )
