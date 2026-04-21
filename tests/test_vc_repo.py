#!/usr/bin/env python
"""Tests for plugin.klayoutclaw_vc.repo (qlaybot v0.4.4 Phase 4, §5.2.2).

Covers:
  * RB-1 auto-detection (disk if sidecar exists, memory if not; no premature
    sidecar creation — T28(b)).
  * RB-2 atomicity (T33): injected OSError during ``git commit`` leaves HEAD
    and refs unchanged, in-memory state intact, and ``status().dirty == True``.
  * RB-3 memory-mode lifecycle (T9 precursor): init memory -> checkpoint ->
    ``migrate_to_disk`` -> sidecar present -> re-init -> history intact.
  * RB-4 handle invariants (T34): ``status()`` re-reads on-disk state, handle
    invalidation returns ``{ok: False, reason: "handle invalidated"}``, and a
    fresh ``init()`` yields a different RepoHandle.
  * API-shape checks for ``history``, ``checkout``, ``diff``, ``branch``,
    ``tag``, ``export``, plus error-dict shapes on invalid inputs.

Contract notes for the Executor (hard requirements for T33 to pass)
-------------------------------------------------------------------
* Module path MUST be ``plugin.klayoutclaw_vc.repo``.
* The module MUST ``import subprocess`` at module level and call
  ``subprocess.run(...)`` (as an attribute access on the bound ``subprocess``
  module) for EVERY git invocation that mutates state.  T33 monkeypatches
  ``plugin.klayoutclaw_vc.repo.subprocess.run`` — any other indirection
  (``from subprocess import run``, a private helper that bypasses the
  monkeypatch) will break T33.
* ``init(gds_path)`` MUST return a ``RepoHandle``-like object — duck-typed
  in these tests to mean "has ``checkpoint``, ``history``, ``checkout``,
  ``diff``, ``branch``, ``tag``, ``export``, ``status`` callable methods"
  plus an ``invalidate`` (or ``close``) method.
* ``status()`` returns a dict with at LEAST the keys:
  ``branch``, ``dirty``, ``last_checkpoint_ts``, ``pending``, ``mode``.
  (Optional extras: ``recovery_offered``, ``last_good_sha``; exercised in
  ``test_vc_recovery.py``.)
* On every failure path, the handle methods MUST return a dict containing
  at least ``{"ok": False, "reason": <non-empty str>}`` — never raise.
* Merge conflicts MUST return ``{"ok": False, "conflicts": [{...}, ...]}``
  AND leave both branch refs unchanged.
"""
from __future__ import annotations

import os
import subprocess as _real_subprocess
import sys

import pytest

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

# Test-first: skip while Executor hasn't landed the module yet.
repo_mod = pytest.importorskip("plugin.klayoutclaw_vc.repo")

import klayout.db as pya  # noqa: E402


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def _make_layout(n_shapes: int = 1, *, layer: int = 1, datatype: int = 0):
    """Simple layout with ``n_shapes`` boxes on a single layer."""
    layout = pya.Layout()
    layout.dbu = 0.001
    top = layout.create_cell("TOP")
    li = layout.layer(layer, datatype)
    for i in range(n_shapes):
        top.shapes(li).insert(pya.Box(i * 100, 0, i * 100 + 50, 50))
    return layout


def _git(repo_dir: str, *args: str) -> str:
    """Run git directly against the sidecar and return stdout."""
    result = _real_subprocess.run(
        ["git", "-C", repo_dir, *args],
        capture_output=True, text=True, check=False,
    )
    return result.stdout.strip()


def _sidecar(gds_path: str) -> str:
    return gds_path + ".vc"


def _gds_path(tmp_path) -> str:
    # Some implementations may treat the string literally — we also create
    # a placeholder GDS on disk so repo init has something plausible to sit
    # next to.  We write a trivial layout so the path is a real file.
    path = os.path.join(str(tmp_path), "design.gds")
    lay = _make_layout()
    lay.write(path)
    return path


def _must_be_error_dict(value, reason_re: str | None = None):
    """Assert ``value`` is an ``{ok: False, reason: <non-empty>}``-shaped dict."""
    assert isinstance(value, dict), f"expected error dict, got {type(value).__name__}"
    assert value.get("ok") is False, f"expected ok=False, got {value!r}"
    reason = value.get("reason")
    assert isinstance(reason, str) and reason.strip(), \
        f"expected non-empty 'reason' string, got {reason!r}"
    if reason_re is not None:
        import re
        assert re.search(reason_re, reason, re.IGNORECASE), \
            f"reason {reason!r} did not match /{reason_re}/"


def _call_invalidate(handle):
    """Invoke whichever invalidation API the Executor exposes."""
    for attr in ("invalidate", "close"):
        fn = getattr(handle, attr, None)
        if callable(fn):
            fn()
            return
    pytest.fail("RepoHandle must expose invalidate() or close() per RB-4 contract")


def _exec_pya_code_subprocess(code: str, out_gds: str) -> None:
    """Run emitted pya code in a FRESH Python interpreter, then write layout.

    DM-3 driver contract: the emitted code MUST leave a module-level variable
    ``layout`` bound to the reconstructed ``pya.Layout``.  We append
    ``layout.write(<path>)`` and execute via ``_real_subprocess.run`` with a
    timeout.  Subprocess isolation ensures no test-fixture state can leak
    into the execution namespace — a stub ``f"pya.Layout() # {sha}"`` cannot
    pass, because it never inserts the committed shapes.

    Uses ``_real_subprocess`` (not the module-level ``subprocess`` from
    ``repo_mod``) to avoid interacting with any monkeypatches the caller may
    have installed on ``repo_mod.subprocess``.
    """
    driver = (
        code
        + "\n# driver appended by test (DM-3 contract: module-level `layout`)\n"
        + f"layout.write({out_gds!r})\n"
    )
    result = _real_subprocess.run(
        [sys.executable, "-c", driver],
        capture_output=True, text=True, timeout=60,
    )
    if result.returncode != 0:
        raise AssertionError(
            "export(pya) code failed to execute in a fresh subprocess.\n"
            f"stdout: {result.stdout}\nstderr: {result.stderr}"
        )
    assert os.path.exists(out_gds), (
        "export(pya): subprocess ran without error but no GDS was written — "
        "did the emitted code leave a `layout` variable?"
    )


def _total_shapes_in_gds(path: str) -> int:
    """Count all shapes across all cells and layers in a GDS file."""
    lay = pya.Layout()
    lay.read(path)
    total = 0
    for cell in lay.each_cell():
        for li in lay.layer_indexes():
            total += cell.shapes(li).size()
    return total


# ---------------------------------------------------------------------------
# Module-import smoke (still asserts real callables)
# ---------------------------------------------------------------------------


def test_repo_module_exposes_public_api():
    assert callable(getattr(repo_mod, "init", None)), \
        "repo.init must be a public callable"
    assert callable(getattr(repo_mod, "migrate_to_disk", None)), \
        "repo.migrate_to_disk must be a public callable"
    # The module MUST import subprocess at module level (T33 requirement).
    assert hasattr(repo_mod, "subprocess"), \
        "repo.py must `import subprocess` at module level so T33 can monkeypatch it"
    assert repo_mod.subprocess.run is _real_subprocess.run, \
        "repo.py must reference subprocess.run via the module (not `from subprocess import run`)"


# ---------------------------------------------------------------------------
# RB-1 / T28(b) — auto-detection + no premature sidecar
# ---------------------------------------------------------------------------


def test_init_memory_mode_when_sidecar_absent(tmp_path):
    """RB-1: no sibling sidecar -> mode='memory', and sidecar dir is NOT created."""
    gds = _gds_path(tmp_path)
    assert not os.path.exists(_sidecar(gds))

    handle = repo_mod.init(gds)
    try:
        st = handle.status()
        assert isinstance(st, dict)
        assert st.get("mode") == "memory", \
            f"RB-1: expected mode=memory, got {st.get('mode')!r}"
        # T28(b): sidecar MUST NOT exist on disk.
        assert not os.path.exists(_sidecar(gds)), \
            "T28(b) violated: sidecar created before migrate_to_disk / first save"
    finally:
        _call_invalidate(handle)


def test_init_disk_mode_when_sidecar_present(tmp_path):
    """RB-1: pre-existing valid git sidecar -> mode='disk'."""
    gds = _gds_path(tmp_path)
    sidecar = _sidecar(gds)
    os.makedirs(sidecar)
    _real_subprocess.run(["git", "-C", sidecar, "init", "-q"], check=True)
    _real_subprocess.run(
        ["git", "-C", sidecar, "-c", "user.email=t@t.t", "-c", "user.name=t",
         "commit", "--allow-empty", "-q", "-m", "seed"], check=True)

    handle = repo_mod.init(gds)
    try:
        st = handle.status()
        assert st.get("mode") == "disk", \
            f"RB-1: expected mode=disk, got {st.get('mode')!r}"
    finally:
        _call_invalidate(handle)


def test_status_contains_required_fields(tmp_path):
    """status() returns the documented 5-field dict shape."""
    gds = _gds_path(tmp_path)
    handle = repo_mod.init(gds)
    try:
        st = handle.status()
        required = {"branch", "dirty", "last_checkpoint_ts", "pending", "mode"}
        missing = required - set(st)
        assert not missing, f"status() missing required keys: {missing}"
    finally:
        _call_invalidate(handle)


# ---------------------------------------------------------------------------
# RB-3 / T9 — memory-mode lifecycle + migrate_to_disk (DM-4)
# ---------------------------------------------------------------------------


def test_memory_mode_checkpoint_then_migrate_to_disk(tmp_path):
    """RB-3 + DM-4: checkpoint in memory, migrate, confirm sidecar + history intact."""
    gds = _gds_path(tmp_path)
    sidecar = _sidecar(gds)
    assert not os.path.exists(sidecar)

    handle = repo_mod.init(gds)
    layout = _make_layout(n_shapes=1)
    r = handle.checkpoint(layout, "seed")
    assert isinstance(r, dict)
    assert r.get("ok") is True, f"RB-3: memory-mode checkpoint must succeed, got {r}"
    first_sha = r["sha"]
    assert isinstance(first_sha, str) and first_sha.strip(), \
        "checkpoint must return non-empty sha"

    # Still memory mode, still no on-disk sidecar.
    assert handle.status().get("mode") == "memory"
    assert not os.path.exists(sidecar), \
        "T28(b): sidecar must not exist before migrate_to_disk"

    repo_mod.migrate_to_disk(handle, gds)

    assert os.path.exists(sidecar), \
        "DM-4: migrate_to_disk must create sibling sidecar"
    assert handle.status().get("mode") == "disk", \
        "DM-4: status.mode must flip to 'disk' after migration"

    # Re-init must see the same history.
    _call_invalidate(handle)
    handle2 = repo_mod.init(gds)
    try:
        hist = handle2.history()
        assert isinstance(hist, list) and len(hist) >= 1, \
            "T9: re-init must preserve history from migrated memory repo"
        shas = [c.get("sha") for c in hist]
        assert first_sha in shas, \
            "T9: first memory-mode checkpoint must appear in re-init'd history"
    finally:
        _call_invalidate(handle2)


# ---------------------------------------------------------------------------
# RB-2 / T33 — checkpoint atomicity / fault injection
# ---------------------------------------------------------------------------


def test_checkpoint_failure_leaves_refs_unchanged(tmp_path, monkeypatch):
    """T33: injected OSError during git commit -> structured error, no mutation.

    Mechanism: after a seed checkpoint (so HEAD exists), patch
    ``plugin.klayoutclaw_vc.repo.subprocess.run`` so that any invocation whose
    argv contains ``commit`` raises OSError.  All other git calls pass through.
    """
    gds = _gds_path(tmp_path)
    handle = repo_mod.init(gds)
    try:
        # Seed commit A (so HEAD exists).
        layout = _make_layout(n_shapes=1)
        seed = handle.checkpoint(layout, "seed")
        assert seed.get("ok") is True, f"pre-condition seed failed: {seed}"

        # Migrate to disk if still in memory mode, so we can inspect HEAD.
        if handle.status().get("mode") == "memory":
            repo_mod.migrate_to_disk(handle, gds)
        sidecar = _sidecar(gds)
        assert os.path.exists(sidecar)

        head_before = _git(sidecar, "rev-parse", "HEAD")
        refs_before = _git(sidecar, "for-each-ref", "--format=%(refname) %(objectname)")

        # Install the fault injector.
        from plugin.klayoutclaw_vc import repo as target
        original_run = target.subprocess.run

        def fault_run(argv, *args, **kwargs):
            # Raise only on `git commit ...` — let all other git calls succeed.
            if isinstance(argv, (list, tuple)) and any(
                    a == "commit" for a in argv):
                raise OSError("injected: git commit failed")
            return original_run(argv, *args, **kwargs)

        monkeypatch.setattr(target.subprocess, "run", fault_run)

        # Try to checkpoint a mutated layout.
        mutated = _make_layout(n_shapes=5)  # deliberately different content
        result = handle.checkpoint(mutated, "should-fail")

        # (a) Structured error.
        _must_be_error_dict(result)

        # (b) HEAD and refs unchanged.
        head_after = _git(sidecar, "rev-parse", "HEAD")
        refs_after = _git(sidecar, "for-each-ref", "--format=%(refname) %(objectname)")
        assert head_after == head_before, \
            f"T33: HEAD moved on injected failure (before={head_before}, after={head_after})"
        assert refs_after == refs_before, \
            "T33: refs/heads mutated on injected failure"

        # Remove the injector; later assertions need normal git.
        monkeypatch.setattr(target.subprocess, "run", original_run)

        # (c) in-memory layout not mutated — the ``mutated`` variable is the
        # caller's own Layout object, which the repo must not clobber.  We
        # assert that its top cell still has the original 5 shapes.
        top = next(iter(mutated.top_cells()))
        li = mutated.layer(1, 0)
        assert top.shapes(li).size() == 5, \
            "T33: caller's layout must not be mutated by failed checkpoint"

        # (d) dirty=True afterwards.
        dirty = handle.status().get("dirty")
        assert dirty is True, \
            f"T33: status.dirty must be True after failed checkpoint, got {dirty!r}"
    finally:
        _call_invalidate(handle)


# ---------------------------------------------------------------------------
# RB-4 / T34 — handle invariants
# ---------------------------------------------------------------------------


def test_status_reflects_ondisk_head_not_cached(tmp_path):
    """T34(a): tamper HEAD on disk, status() must report the NEW on-disk state.

    Strategy: create two commits c1 then c2 with a guaranteed-distinct
    ``last_checkpoint_ts`` (sleep 1.1s between them so seconds-granularity
    timestamps differ).  Record ``status()`` at each.  Then tamper
    ``.git/HEAD`` to detach onto c1's sha and assert the third ``status()``
    reports c1's ``last_checkpoint_ts`` on a SPECIFIC field — not a
    three-way-disjunction "something changed".  Cached implementations
    that keep c2's timestamp will fail loudly.
    """
    import time

    gds = _gds_path(tmp_path)
    handle = repo_mod.init(gds)
    try:
        # Seed c1.
        r1 = handle.checkpoint(_make_layout(1), "c1")
        assert r1.get("ok"), f"seed1 failed: {r1}"
        if handle.status().get("mode") == "memory":
            repo_mod.migrate_to_disk(handle, gds)
        st_c1 = handle.status()
        c1_ts = st_c1.get("last_checkpoint_ts")
        sidecar = _sidecar(gds)
        c1_sha = _git(sidecar, "rev-parse", "HEAD")

        # Guarantee that c2's timestamp differs from c1's at second
        # granularity.  1.1s buffer for any implementation that rounds DOWN.
        time.sleep(1.1)

        r2 = handle.checkpoint(_make_layout(2), "c2")
        assert r2.get("ok"), f"seed2 failed: {r2}"
        st_c2 = handle.status()
        c2_ts = st_c2.get("last_checkpoint_ts")
        c2_sha = _git(sidecar, "rev-parse", "HEAD")

        # Pre-tamper sanity: two real commits must have distinct shas, and
        # their recorded last_checkpoint_ts must differ.
        assert c1_sha and c2_sha and c1_sha != c2_sha, \
            f"pre-cond: c1 and c2 must have distinct shas (c1={c1_sha}, c2={c2_sha})"
        assert c1_ts != c2_ts, (
            "T34(a) pre-condition: status().last_checkpoint_ts must be distinct "
            f"between two real commits, got c1={c1_ts!r}, c2={c2_ts!r}"
        )

        # Tamper .git/HEAD so it points at c1's sha (detached HEAD — valid git state).
        head_file = os.path.join(sidecar, ".git", "HEAD")
        with open(head_file, "w") as fh:
            fh.write(c1_sha + "\n")

        # Invalidate any ts-level cache by calling status() again.  A handle
        # that caches the last commit's ts in process memory will keep
        # returning c2_ts, even though HEAD on disk has moved back to c1.
        st_after = handle.status()
        ts_after = st_after.get("last_checkpoint_ts")

        # SPECIFIC assertion: ts_after must equal c1_ts, proving the handle
        # re-read from disk instead of returning a cached c2-era value.
        assert ts_after == c1_ts, (
            "T34(a): after detaching HEAD to c1, status().last_checkpoint_ts "
            f"must match c1's ({c1_ts!r}), got {ts_after!r} "
            f"(c2's ts was {c2_ts!r}).  status appears cached."
        )
        # And it must NOT equal c2_ts (otherwise the implementation is caching).
        assert ts_after != c2_ts, (
            "T34(a): status still returns c2's last_checkpoint_ts "
            f"({c2_ts!r}) after detaching HEAD to c1 — appears cached"
        )
    finally:
        _call_invalidate(handle)


def test_invalidated_handle_rejects_ops(tmp_path):
    """T34(b): invalidated handle returns structured error on every op."""
    gds = _gds_path(tmp_path)
    handle = repo_mod.init(gds)
    # Seed so checkpoint/history have meaningful context.
    handle.checkpoint(_make_layout(1), "seed")

    _call_invalidate(handle)

    layout = _make_layout(2)

    r_ckpt = handle.checkpoint(layout, "after-invalidate")
    _must_be_error_dict(r_ckpt, reason_re="handle invalidated")

    # status() after invalidation must also be safe — either an error dict or
    # an explicit sentinel.  We accept both, but it MUST NOT raise.
    try:
        st = handle.status()
        assert isinstance(st, dict)
    except Exception as e:  # pragma: no cover — defensive
        pytest.fail(f"status() on invalidated handle raised {type(e).__name__}: {e}")


def test_fresh_init_returns_different_handle(tmp_path):
    """T34(c): a fresh init() on the same path returns a different handle object."""
    gds = _gds_path(tmp_path)
    handle_a = repo_mod.init(gds)
    try:
        handle_a.checkpoint(_make_layout(1), "seed")
        if handle_a.status().get("mode") == "memory":
            repo_mod.migrate_to_disk(handle_a, gds)
    finally:
        _call_invalidate(handle_a)

    handle_b = repo_mod.init(gds)
    try:
        assert handle_b is not handle_a, \
            "T34(c): fresh init() must return a different RepoHandle identity"
        hist = handle_b.history()
        assert isinstance(hist, list) and len(hist) >= 1, \
            "T34(c): fresh handle must see on-disk history"
    finally:
        _call_invalidate(handle_b)


def test_fresh_init_invalidates_old_handle(tmp_path):
    """RB-4: fresh init(gds_path) MUST auto-invalidate any prior handle for that path.

    Spec §5.2.2 RB-4 says a RepoHandle is "reset on layout close or on a fresh
    init(gds_path) call".  Concretely: after the second init(), all methods on
    the FIRST handle must return ``{ok: False, reason: "handle invalidated"}``
    without any manual close()/invalidate() call from the test.  The second
    handle is unaffected.
    """
    gds = _gds_path(tmp_path)

    h1 = repo_mod.init(gds)
    # h1 must be valid at this point.
    s1 = h1.status()
    assert isinstance(s1, dict)
    # A fresh handle's status() shouldn't have ok=False if it has one at all.
    # Accept: no 'ok' key OR ok is True.
    assert s1.get("ok", True) is not False, \
        f"pre-cond: fresh handle must be valid, got status={s1}"

    # Fresh init on the SAME gds_path.
    h2 = repo_mod.init(gds)
    assert h2 is not h1, \
        "RB-4: fresh init() must return a new handle instance"

    # CRITICAL: h1 must now be invalidated.  status() returns an error dict.
    resp = h1.status()
    assert isinstance(resp, dict), \
        f"RB-4: invalidated handle status() must return a dict, got {type(resp).__name__}"
    assert resp.get("ok") is False, (
        "RB-4: status() on a handle invalidated by a fresh init() must return "
        f"{{ok: False, reason: 'handle invalidated'}}, got {resp!r}"
    )
    reason = resp.get("reason", "")
    assert "handle invalidated" in str(reason).lower(), (
        f"RB-4: expected reason to contain 'handle invalidated', got {reason!r}"
    )

    # And other ops on h1 too — checkpoint must refuse.
    layout = _make_layout(1)
    resp2 = h1.checkpoint(layout, "after-invalidation")
    assert isinstance(resp2, dict) and resp2.get("ok") is False, (
        f"RB-4: checkpoint on invalidated handle must return error dict, got {resp2!r}"
    )
    assert "handle invalidated" in str(resp2.get("reason", "")).lower(), (
        f"RB-4: checkpoint reason must contain 'handle invalidated', got {resp2!r}"
    )

    # h2 remains valid — checkpoint succeeds.
    try:
        resp3 = h2.checkpoint(layout, "on-new-handle")
        assert isinstance(resp3, dict) and resp3.get("ok") is True, (
            f"RB-4: the surviving handle must still accept ops, got {resp3!r}"
        )
    finally:
        _call_invalidate(h2)


# ---------------------------------------------------------------------------
# history(), checkout(), diff() — API shapes
# ---------------------------------------------------------------------------


def test_history_limit_and_shape(tmp_path):
    gds = _gds_path(tmp_path)
    handle = repo_mod.init(gds)
    try:
        for i in range(3):
            r = handle.checkpoint(_make_layout(i + 1), f"c{i}")
            assert r.get("ok"), f"checkpoint c{i} failed: {r}"

        full = handle.history()
        assert isinstance(full, list)
        assert len(full) >= 3, f"expected >=3 commits in history, got {len(full)}"

        capped = handle.history(limit=2)
        assert isinstance(capped, list)
        assert len(capped) == 2, f"history(limit=2) must return 2, got {len(capped)}"

        # Each entry is a dict with the documented keys.
        entry = capped[0]
        for key in ("sha", "message", "ts", "tags", "branch", "stats"):
            assert key in entry, f"history entry missing key {key!r}: {entry}"
        stats = entry["stats"]
        for key in ("polygon_count", "layer_count", "bbox"):
            assert key in stats, f"history.stats missing key {key!r}: {stats}"
    finally:
        _call_invalidate(handle)


def test_checkout_invalid_ref_returns_error(tmp_path):
    gds = _gds_path(tmp_path)
    handle = repo_mod.init(gds)
    try:
        handle.checkpoint(_make_layout(1), "seed")
        r = handle.checkout("nosuchref-deadbeef-xxxxxx")
        _must_be_error_dict(r)
    finally:
        _call_invalidate(handle)


def test_checkout_valid_ref_restores_state(tmp_path):
    """Happy-path checkout: checkout(valid_sha) moves LIVE HEAD to that ref.

    Spec §5.2.2 MCP-4 / VC-4 / T14: checkout(ref) moves the repo's live HEAD
    (and restores the layout) at ref.

    Anti-cheat structure:
      * We sleep 1.1s between commits so ``last_checkpoint_ts`` is distinct at
        seconds granularity — lets us later prove status() reflects the
        checked-out commit's timestamp.
      * We verify the LIVE state with an independent ``git rev-parse HEAD``
        query via ``_real_subprocess`` — this catches a no-op ``checkout()``
        that just returns ``{ok: True, sha: ref}`` without moving HEAD.
      * A no-op ``export(sha_a, ...)`` pair would still pass a byte-stable
        check because both sides read the same snapshot — so we additionally
        require status() to reflect A's ts (not B's) and require git HEAD to
        resolve to sha_a.
    """
    import time as _time

    gds = _gds_path(tmp_path)
    handle = repo_mod.init(gds)
    try:
        # Ensure disk mode so we can inspect .git/HEAD out-of-band.
        repo_mod.migrate_to_disk(handle, gds)
        sidecar = _sidecar(gds)

        # Commit A — 1 rectangle.  Capture A's status ts.
        la = pya.Layout()
        la.dbu = 0.001
        ca = la.create_cell("TOP")
        ca.shapes(la.layer(1, 0)).insert(pya.Box(0, 0, 100, 100))
        r_a = handle.checkpoint(la, "A")
        assert isinstance(r_a, dict) and r_a.get("ok") is True, \
            f"commit A must succeed, got {r_a!r}"
        sha_a = r_a["sha"]
        ts_at_a = handle.status().get("last_checkpoint_ts")
        head_after_a = _git(sidecar, "rev-parse", "HEAD")
        assert head_after_a == sha_a, (
            f"pre-cond: after committing A, git HEAD must be sha_a ({sha_a}), "
            f"got {head_after_a}"
        )
        export_a_before = handle.export(sha_a, "gds")
        assert isinstance(export_a_before, (bytes, bytearray)) and export_a_before, \
            f"pre-cond: export(A,gds) must return non-empty bytes, got {type(export_a_before).__name__}"

        # 1.1s gap so A's and B's last_checkpoint_ts cannot coincide at sec-granularity.
        _time.sleep(1.1)

        # Commit B — 2 rectangles (distinct content).
        lb = pya.Layout()
        lb.dbu = 0.001
        cb = lb.create_cell("TOP")
        cb.shapes(lb.layer(1, 0)).insert(pya.Box(0, 0, 100, 100))
        cb.shapes(lb.layer(1, 0)).insert(pya.Box(200, 200, 300, 300))
        r_b = handle.checkpoint(lb, "B")
        assert r_b.get("ok") is True, f"commit B must succeed, got {r_b!r}"
        sha_b = r_b["sha"]
        assert sha_b != sha_a, "A and B must have distinct shas"
        ts_at_b = handle.status().get("last_checkpoint_ts")
        head_after_b = _git(sidecar, "rev-parse", "HEAD")
        assert head_after_b == sha_b, (
            f"pre-cond: after committing B, git HEAD must be sha_b ({sha_b}), "
            f"got {head_after_b}"
        )
        assert ts_at_a != ts_at_b, (
            "pre-cond: A and B last_checkpoint_ts must differ "
            f"(got A={ts_at_a!r}, B={ts_at_b!r})"
        )

        # Checkout A — structured success.
        co = handle.checkout(sha_a)
        assert isinstance(co, dict), f"checkout must return dict, got {type(co).__name__}"
        assert co.get("ok") is True, f"MCP-4: checkout(valid ref) must return ok=True, got {co!r}"
        assert co.get("sha") == sha_a, (
            f"MCP-4: checkout response must echo the checked-out sha, "
            f"expected {sha_a!r}, got {co.get('sha')!r}"
        )

        # ------------------------------------------------------------
        # LIVE-HEAD proof: out-of-band git inspection.  This defeats a
        # no-op checkout() that returns {ok:True, sha:ref} without moving
        # HEAD.  Accept either attached HEAD on a branch pointing at A,
        # or detached HEAD pointing at A.
        # ------------------------------------------------------------
        head_now = _git(sidecar, "rev-parse", "HEAD")
        assert head_now == sha_a, (
            f"MCP-4 / VC-4 / T14: checkout(sha_a) must move the live git HEAD "
            f"to sha_a.  expected HEAD={sha_a}, got HEAD={head_now} "
            f"(sha_b was {sha_b})"
        )
        assert head_now != sha_b, (
            f"MCP-4: checkout did not actually move HEAD off B.  HEAD={head_now}, sha_b={sha_b}"
        )

        # ------------------------------------------------------------
        # handle.status() must also reflect the checked-out commit: its
        # last_checkpoint_ts should equal A's ts, NOT B's ts.  This
        # double-guards against a handle that caches B's state in memory.
        # ------------------------------------------------------------
        st_after_co = handle.status()
        ts_after_co = st_after_co.get("last_checkpoint_ts")
        assert ts_after_co == ts_at_a, (
            f"MCP-4: after checkout(A), status().last_checkpoint_ts must "
            f"equal A's ts ({ts_at_a!r}), got {ts_after_co!r} "
            f"(B's ts was {ts_at_b!r}).  Appears the handle is stale."
        )
        assert ts_after_co != ts_at_b, (
            "MCP-4: status still reports B's ts after checkout(A) — "
            f"got {ts_after_co!r}, B's ts was {ts_at_b!r}"
        )

        # ------------------------------------------------------------
        # history() (no branch filter) must show A at/near the top — the
        # current commit reachable from HEAD.  We locate A in history and
        # require it to be the FIRST entry.
        # ------------------------------------------------------------
        hist = handle.history()
        assert isinstance(hist, list) and hist, \
            f"history() must be non-empty after checkout, got {hist!r}"
        top_sha = hist[0].get("sha", "")
        assert top_sha == sha_a or (
            isinstance(top_sha, str) and isinstance(sha_a, str)
            and (top_sha.startswith(sha_a[:7]) or sha_a.startswith(top_sha[:7]))
        ), (
            f"MCP-4: after checkout(A), history()[0].sha must reference A. "
            f"expected {sha_a}, got top={top_sha!r} (hist={hist!r})"
        )

        # export at A must be byte-stable across the checkout cycle.
        export_a_after = handle.export(sha_a, "gds")
        assert export_a_after == export_a_before, (
            "MCP-4: export(sha_A,'gds') must be byte-stable across checkout"
        )

        # Additionally, A and B's exports must differ — guards against an
        # export() stub that ignores the ref argument.
        export_b = handle.export(sha_b, "gds")
        assert export_b != export_a_after, (
            "MCP-4 / export: export(A) and export(B) must differ "
            "(distinct commits with distinct shape counts)"
        )
    finally:
        _call_invalidate(handle)


def test_diff_shape_and_polygon_count_delta(tmp_path):
    """diff() returns all 6 documented keys; count delta is non-zero."""
    gds = _gds_path(tmp_path)
    handle = repo_mod.init(gds)
    try:
        r1 = handle.checkpoint(_make_layout(1), "c1")
        assert r1.get("ok")
        r2 = handle.checkpoint(_make_layout(5), "c2")  # 4 more shapes
        assert r2.get("ok")

        d = handle.diff(r1["sha"], r2["sha"])
        assert isinstance(d, dict)
        for key in ("added_polygons", "removed_polygons", "moved_polygons",
                    "layer_stats", "bbox_delta", "polygon_count_delta"):
            assert key in d, f"diff() missing key {key!r}: {d}"

        # polygon_count_delta must be non-zero because we added shapes.
        delta = d["polygon_count_delta"]
        assert isinstance(delta, (int, float))
        assert delta != 0, f"polygon_count_delta must reflect added shapes, got {delta}"
    finally:
        _call_invalidate(handle)


# ---------------------------------------------------------------------------
# branch() — list / create / switch / merge (happy + conflict)
# ---------------------------------------------------------------------------


def test_branch_list_contains_default(tmp_path):
    gds = _gds_path(tmp_path)
    handle = repo_mod.init(gds)
    try:
        handle.checkpoint(_make_layout(1), "seed")
        names = handle.branch("list")
        assert isinstance(names, list), f"branch(list) must return list, got {type(names)}"
        assert names, "branch list must be non-empty after a seed commit"
        assert any(isinstance(n, str) and n for n in names), \
            "branch list entries must be non-empty strings"
    finally:
        _call_invalidate(handle)


def test_branch_create_and_switch_roundtrip(tmp_path):
    gds = _gds_path(tmp_path)
    handle = repo_mod.init(gds)
    try:
        handle.checkpoint(_make_layout(1), "seed")

        r_create = handle.branch("create", name="feat/x")
        assert isinstance(r_create, dict)
        assert r_create.get("ok") is True, f"branch(create) failed: {r_create}"

        r_switch = handle.branch("switch", name="feat/x")
        assert isinstance(r_switch, dict)
        assert r_switch.get("ok") is True, f"branch(switch) failed: {r_switch}"

        st = handle.status()
        assert st.get("branch") == "feat/x", \
            f"status().branch must reflect switched branch, got {st.get('branch')!r}"
    finally:
        _call_invalidate(handle)


def test_branch_merge_happy_path(tmp_path):
    """Create branch, checkpoint on it, switch to main, merge — commit appears in history."""
    gds = _gds_path(tmp_path)
    handle = repo_mod.init(gds)
    try:
        handle.checkpoint(_make_layout(1), "seed")
        main_branch = handle.status().get("branch")
        assert isinstance(main_branch, str) and main_branch

        assert handle.branch("create", name="feat/y").get("ok"), "create failed"
        assert handle.branch("switch", name="feat/y").get("ok"), "switch failed"

        r_ckpt = handle.checkpoint(_make_layout(3), "on-feat-y")
        assert r_ckpt.get("ok"), f"checkpoint on branch failed: {r_ckpt}"
        feat_sha = r_ckpt["sha"]

        assert handle.branch("switch", name=main_branch).get("ok"), "switch-back failed"
        r_merge = handle.branch("merge", name="feat/y")
        assert isinstance(r_merge, dict)
        assert r_merge.get("ok") is True, f"happy-path merge must succeed: {r_merge}"

        hist_shas = [c.get("sha") for c in handle.history()]
        assert feat_sha in hist_shas, \
            "merged commit must appear in main's history after merge"
    finally:
        _call_invalidate(handle)


def test_branch_merge_conflict_returns_structured_error(tmp_path):
    """T46 / merge-conflict invariants: conflicting merge leaves ALL state untouched.

    Contract:
      * structured {ok: False, conflicts: [{cell, layer, bbox}, ...]} returned.
      * feat/a and feat/b refs unchanged (pre-existing check).
      * **main branch HEAD unchanged** (T46 NEW): the failed merge must not
        create a half-merged commit or mid-merge state that moves main.
      * **current layout export unchanged** (T46 NEW): exporting HEAD before
        and after the failed merge returns byte-identical GDS.  Guards
        against an implementation that applies partial merge changes to the
        working tree on conflict.
    """
    gds = _gds_path(tmp_path)
    handle = repo_mod.init(gds)
    try:
        # Seed with one polygon.
        base = pya.Layout()
        base.dbu = 0.001
        top = base.create_cell("TOP")
        li = base.layer(1, 0)
        top.shapes(li).insert(pya.Box(0, 0, 1000, 1000))
        r_seed = handle.checkpoint(base, "seed")
        assert r_seed.get("ok"), f"seed failed: {r_seed}"

        if handle.status().get("mode") == "memory":
            repo_mod.migrate_to_disk(handle, gds)
        sidecar = _sidecar(gds)
        main_branch = handle.status().get("branch")

        # Branch A: replace the polygon with a shifted one.
        assert handle.branch("create", name="feat/a").get("ok")
        assert handle.branch("switch", name="feat/a").get("ok")
        variant_a = pya.Layout()
        variant_a.dbu = 0.001
        ta = variant_a.create_cell("TOP")
        la = variant_a.layer(1, 0)
        ta.shapes(la).insert(pya.Box(100, 100, 1100, 1100))
        assert handle.checkpoint(variant_a, "a").get("ok")

        # Branch B: replace the SAME polygon with a differently shifted one.
        assert handle.branch("switch", name=main_branch).get("ok")
        assert handle.branch("create", name="feat/b").get("ok")
        assert handle.branch("switch", name="feat/b").get("ok")
        variant_b = pya.Layout()
        variant_b.dbu = 0.001
        tb = variant_b.create_cell("TOP")
        lb = variant_b.layer(1, 0)
        tb.shapes(lb).insert(pya.Box(-100, -100, 900, 900))
        assert handle.checkpoint(variant_b, "b").get("ok")

        # Record branch SHAs before merge.
        a_sha_before = _git(sidecar, "rev-parse", "feat/a")
        b_sha_before = _git(sidecar, "rev-parse", "feat/b")

        # Switch to main.  Successfully merge feat/a (fast-forward or plain
        # merge — either is fine here, the conflict test is on the SECOND
        # merge below).
        assert handle.branch("switch", name=main_branch).get("ok")
        handle.branch("merge", name="feat/a")  # may succeed fast-forward; ignore result

        # Snapshot main's HEAD sha and the current layout export BEFORE the
        # conflicting merge.  These must be unchanged after the attempt.
        main_head_before = _git(sidecar, "rev-parse", main_branch)
        # Also snapshot the export at main HEAD (byte-level layout snapshot).
        layout_export_before = handle.export(main_head_before, "gds")
        assert isinstance(layout_export_before, (bytes, bytearray)) and layout_export_before, (
            "T46 pre-cond: export(main_HEAD, 'gds') must return non-empty bytes"
        )

        r_conflict = handle.branch("merge", name="feat/b")

        assert isinstance(r_conflict, dict)
        assert r_conflict.get("ok") is False, \
            f"second merge must surface conflict: {r_conflict}"
        conflicts = r_conflict.get("conflicts")
        assert isinstance(conflicts, list) and conflicts, \
            f"conflicts field must be non-empty list: {r_conflict}"
        # Each conflict entry has the documented shape.
        c0 = conflicts[0]
        for key in ("cell", "layer", "bbox"):
            assert key in c0, f"conflict entry missing key {key!r}: {c0}"

        # Neither branch ref moved due to the failed merge attempt.
        a_sha_after = _git(sidecar, "rev-parse", "feat/a")
        b_sha_after = _git(sidecar, "rev-parse", "feat/b")
        assert a_sha_after == a_sha_before, \
            "feat/a must not mutate on failed merge"
        assert b_sha_after == b_sha_before, \
            "feat/b must not mutate on failed merge"

        # T46 NEW: main HEAD must be identical to its pre-merge value — the
        # failed merge must not leave a partial commit on main.
        main_head_after = _git(sidecar, "rev-parse", main_branch)
        assert main_head_after == main_head_before, (
            f"T46: main branch HEAD must not move on failed merge, "
            f"before={main_head_before}, after={main_head_after}"
        )

        # T46(c): export byte-equality is necessary but NOT sufficient — both
        # sides read the same snapshot when HEAD is unchanged, so a failed
        # merge could still leave partial index/worktree state.  Prove the
        # live worktree + index are CLEAN via independent git inspection.
        layout_export_after = handle.export(main_head_after, "gds")
        assert layout_export_after == layout_export_before, (
            "T46: layout at main HEAD changed across a failed merge — "
            "export() bytes differ.  Conflict path should leave state intact."
        )

        # T46(c) LIVE proof (broad but journal-safe): after a failed merge,
        # neither the worktree nor the index may carry ANY tracked-file
        # dirtiness — staged OR unstaged.  We use
        # ``git status --porcelain --untracked-files=no`` which lists both
        # staged and unstaged tracked changes while IGNORING untracked
        # files entirely, so the Executor's legitimate (untracked)
        # ``RECOVERY/journal.json`` cannot false-positive.
        #
        # This catches THREE distinct broken-merge residues that a narrower
        # ``ls-files -u`` probe would miss:
        #   (i)   staged-but-not-unmerged tracked changes,
        #   (ii)  modified-but-not-staged tracked files,
        #   (iii) a merge that cleared MERGE_HEAD yet left partial tracked
        #         edits in the worktree.
        porcelain = _git(sidecar, "status", "--porcelain", "--untracked-files=no")
        assert porcelain == "", (
            "T46(c): after a failed merge, tracked worktree+index must be "
            "clean (no staged, unstaged, or unmerged tracked changes). "
            f"`git status --porcelain --untracked-files=no` returned {porcelain!r}"
        )

        # T46(c) defense-in-depth: the index must also contain NO unmerged
        # stage entries.  Redundant with the porcelain probe above for most
        # conflict shapes, but kept as a belt-and-braces signal that is
        # specific to mid-merge state (stages 1/2/3).
        unmerged = _git(sidecar, "ls-files", "-u")
        assert unmerged == "", (
            "T46(c): after a failed merge, the index must contain NO "
            "unmerged stage-conflict entries (git ls-files -u), "
            f"got {unmerged!r}"
        )

        # T46(c): `.git/MERGE_HEAD` must NOT exist.  Its presence signals
        # that git considers a merge to be in progress — the repo would be
        # in a half-merged state waiting for the user to resolve.
        merge_head_path = os.path.join(sidecar, ".git", "MERGE_HEAD")
        assert not os.path.exists(merge_head_path), (
            f"T46(c): .git/MERGE_HEAD must not exist after a rejected merge "
            f"(got {merge_head_path} present — repo stuck mid-merge)"
        )
    finally:
        _call_invalidate(handle)


# ---------------------------------------------------------------------------
# tag()
# ---------------------------------------------------------------------------


def test_tag_happy_path(tmp_path):
    """MCP-9: after tag('name'), history()[0]['tags'] contains 'name'."""
    gds = _gds_path(tmp_path)
    handle = repo_mod.init(gds)
    try:
        r_ckpt = handle.checkpoint(_make_layout(1), "seed")
        assert r_ckpt.get("ok")
        sha = r_ckpt["sha"]

        r = handle.tag("MPW-candidate")
        assert isinstance(r, dict) and r.get("ok") is True, \
            f"tag create must succeed: {r}"

        # MCP-9: tag must surface in subsequent history() responses.
        hist = handle.history()
        assert isinstance(hist, list) and hist, \
            f"history() must return non-empty list after checkpoint, got {hist!r}"
        # Find the entry for our sha.
        entry = None
        for c in hist:
            if c.get("sha") == sha or (
                isinstance(c.get("sha"), str)
                and isinstance(sha, str)
                and (c["sha"].startswith(sha[:7]) or sha.startswith(c["sha"][:7]))
            ):
                entry = c
                break
        assert entry is not None, (
            f"MCP-9: could not find checkpoint sha {sha!r} in history, got {hist!r}"
        )
        tags = entry.get("tags")
        assert isinstance(tags, list), \
            f"MCP-9: history entry 'tags' must be a list, got {type(tags).__name__}"
        assert "MPW-candidate" in tags, (
            f"MCP-9: new tag must appear in history entry tags, got tags={tags!r}"
        )
    finally:
        _call_invalidate(handle)


def test_tag_duplicate_returns_error(tmp_path):
    """Duplicate tag is rejected AND must not produce a duplicated tag entry in history."""
    gds = _gds_path(tmp_path)
    handle = repo_mod.init(gds)
    try:
        r_ckpt = handle.checkpoint(_make_layout(1), "seed")
        assert r_ckpt.get("ok")
        sha = r_ckpt["sha"]
        assert handle.tag("dup").get("ok") is True

        r = handle.tag("dup")
        _must_be_error_dict(r, reason_re=r"exists|collision|duplicate")

        # MCP-9 invariant: failed duplicate-tag call must NOT add a second
        # entry to history.tags.  Count occurrences of "dup".
        hist = handle.history()
        entry = None
        for c in hist:
            c_sha = c.get("sha", "")
            if c_sha == sha or (
                isinstance(c_sha, str) and isinstance(sha, str)
                and (c_sha.startswith(sha[:7]) or sha.startswith(c_sha[:7]))
            ):
                entry = c
                break
        assert entry is not None, f"history missing the seed commit: {hist!r}"
        tags = entry.get("tags", [])
        assert isinstance(tags, list)
        # Exactly one occurrence — the original successful tag().
        assert tags.count("dup") == 1, (
            f"duplicate tag() must not add a second entry, got tags={tags!r}"
        )
    finally:
        _call_invalidate(handle)


def test_tag_invalid_ref_returns_error(tmp_path):
    gds = _gds_path(tmp_path)
    handle = repo_mod.init(gds)
    try:
        handle.checkpoint(_make_layout(1), "seed")
        r = handle.tag("bad", ref="deadbeef" * 5)
        _must_be_error_dict(r, reason_re=r"invalid|not\s*found|unknown")
    finally:
        _call_invalidate(handle)


# ---------------------------------------------------------------------------
# Additional coverage (PM-7, spec §5.2.2 explicit features)
# ---------------------------------------------------------------------------


def test_checkpoint_with_tags(tmp_path):
    """PM-7 addl. coverage — spec §5.2.2 explicit.

    checkpoint(layout, msg, tags=[...]) attaches tags atomically with the
    commit; they appear on that commit's history entry.  Forces the Executor
    to wire the ``tags`` kwarg through to the repo layer rather than quietly
    dropping it.
    """
    gds = _gds_path(tmp_path)
    handle = repo_mod.init(gds)
    try:
        r = handle.checkpoint(_make_layout(1), "tagged-commit",
                               tags=["foo", "bar"])
        assert isinstance(r, dict) and r.get("ok") is True, \
            f"checkpoint(tags=[...]) must succeed: {r}"
        sha = r["sha"]

        hist = handle.history()
        assert isinstance(hist, list) and hist
        entry = None
        for c in hist:
            c_sha = c.get("sha", "")
            if c_sha == sha or (
                isinstance(c_sha, str) and isinstance(sha, str)
                and (c_sha.startswith(sha[:7]) or sha.startswith(c_sha[:7]))
            ):
                entry = c
                break
        assert entry is not None, \
            f"could not find commit sha {sha!r} in history, got {hist!r}"
        tags = entry.get("tags", [])
        assert isinstance(tags, list), f"history.tags must be list, got {type(tags).__name__}"
        assert "foo" in tags, \
            f"checkpoint tag 'foo' missing from history entry tags: {tags!r}"
        assert "bar" in tags, \
            f"checkpoint tag 'bar' missing from history entry tags: {tags!r}"


    finally:
        _call_invalidate(handle)


def test_history_filter_by_branch(tmp_path):
    """PM-7 addl. coverage — spec §5.2.2 explicit.

    history(branch=...) scopes returned commits to that branch's reachable set.
    Setup:
      * main: 2 commits
      * feat/x: branches off main after main's 2nd commit, adds 2 more
    Expect history(branch='main') to return 2, history(branch='feat/x')
    to return 4 (2 inherited + 2 new) — in both cases strictly on count.
    """
    gds = _gds_path(tmp_path)
    handle = repo_mod.init(gds)
    try:
        main_branch = None

        r1 = handle.checkpoint(_make_layout(1), "m1")
        assert r1.get("ok")
        main_branch = handle.status().get("branch")
        assert isinstance(main_branch, str) and main_branch

        r2 = handle.checkpoint(_make_layout(2), "m2")
        assert r2.get("ok")

        # Create feat/x off main's current HEAD, switch, add two.
        assert handle.branch("create", name="feat/x").get("ok"), "create feat/x failed"
        assert handle.branch("switch", name="feat/x").get("ok"), "switch feat/x failed"
        assert handle.checkpoint(_make_layout(3), "x1").get("ok")
        assert handle.checkpoint(_make_layout(4), "x2").get("ok")

        # Switch back to main and query both histories.
        assert handle.branch("switch", name=main_branch).get("ok")

        hist_main = handle.history(branch=main_branch)
        assert isinstance(hist_main, list), \
            f"history(branch=main) must return list, got {type(hist_main).__name__}"
        assert len(hist_main) == 2, (
            f"history(branch={main_branch!r}) must include exactly the 2 "
            f"commits on main, got {len(hist_main)}"
        )

        hist_feat = handle.history(branch="feat/x")
        assert isinstance(hist_feat, list), \
            f"history(branch=feat/x) must return list, got {type(hist_feat).__name__}"
        assert len(hist_feat) == 4, (
            f"history(branch='feat/x') must include the 2 inherited + 2 new "
            f"commits (4 total), got {len(hist_feat)}"
        )
    finally:
        _call_invalidate(handle)


def test_branch_create_from_ref(tmp_path):
    """PM-7 addl. coverage — spec §5.2.2 explicit.

    branch('create', name='feat/fromA', from_ref=sha_A) creates a branch
    whose HEAD is exactly sha_A, not the current HEAD.  Switching to it then
    shows sha_A at the top of history.
    """
    gds = _gds_path(tmp_path)
    handle = repo_mod.init(gds)
    try:
        r_a = handle.checkpoint(_make_layout(1), "A")
        assert r_a.get("ok"), f"commit A failed: {r_a}"
        sha_a = r_a["sha"]

        r_b = handle.checkpoint(_make_layout(5), "B")
        assert r_b.get("ok"), f"commit B failed: {r_b}"
        sha_b = r_b["sha"]
        assert sha_a != sha_b

        # Create branch from A's sha (not HEAD).
        r_create = handle.branch("create", name="feat/fromA", from_ref=sha_a)
        assert isinstance(r_create, dict) and r_create.get("ok") is True, (
            f"branch(create, from_ref=...) must succeed: {r_create!r}"
        )

        assert handle.branch("switch", name="feat/fromA").get("ok"), \
            "switch to feat/fromA failed"

        hist = handle.history()
        assert isinstance(hist, list) and hist, \
            f"history on feat/fromA must be non-empty, got {hist!r}"
        top = hist[0]
        top_sha = top.get("sha", "")
        # Top of history is A's commit.
        ok = (top_sha == sha_a
              or (isinstance(top_sha, str) and isinstance(sha_a, str)
                  and (top_sha.startswith(sha_a[:7])
                       or sha_a.startswith(top_sha[:7]))))
        assert ok, (
            f"branch(create, from_ref=A) should place HEAD at A. "
            f"expected top sha {sha_a!r}, got top sha {top_sha!r}"
        )
    finally:
        _call_invalidate(handle)


# ---------------------------------------------------------------------------
# export()
# ---------------------------------------------------------------------------


def test_export_gds_returns_bytes(tmp_path):
    """export(sha, 'gds') returns DIFFERENT bytes for DIFFERENT commits.

    Stub-resistance: a trivial implementation returning a constant
    ``b"GDS"`` would pass a single "is bytes and non-empty" check.  By
    asserting that two distinct commits yield distinct bytes, AND that the
    exported bytes reload into the exact shape count that was committed at
    each ref, we force the implementation to actually honour the ``sha``
    argument.
    """
    gds = _gds_path(tmp_path)
    handle = repo_mod.init(gds)
    try:
        # Two distinct commits with distinct shape counts.
        r_a = handle.checkpoint(_make_layout(1), "A")
        assert r_a.get("ok"), f"commit A failed: {r_a}"
        sha_a = r_a["sha"]

        r_b = handle.checkpoint(_make_layout(7), "B")
        assert r_b.get("ok"), f"commit B failed: {r_b}"
        sha_b = r_b["sha"]
        assert sha_a != sha_b, "A and B must have distinct shas"

        payload_a = handle.export(sha_a, "gds")
        payload_b = handle.export(sha_b, "gds")

        # Type / non-empty.
        assert isinstance(payload_a, (bytes, bytearray)), \
            f"export(gds) must return bytes, got {type(payload_a).__name__}"
        assert isinstance(payload_b, (bytes, bytearray)), \
            f"export(gds) must return bytes, got {type(payload_b).__name__}"
        assert payload_a and payload_b, "exported GDS bytes must be non-empty"

        # CONTENT differentiation: different commits -> different bytes.
        assert payload_a != payload_b, (
            "export(sha, 'gds') must honour the sha argument: exports at A "
            "and B returned identical bytes even though content differs"
        )

        # Independent verification: reload the exported GDS and count shapes.
        import io as _io
        out_a = os.path.join(str(tmp_path), "export_a.gds")
        out_b = os.path.join(str(tmp_path), "export_b.gds")
        with open(out_a, "wb") as fh:
            fh.write(bytes(payload_a))
        with open(out_b, "wb") as fh:
            fh.write(bytes(payload_b))

        def _total_shapes(path):
            lay = pya.Layout()
            lay.read(path)
            total = 0
            for cell in lay.each_cell():
                for li in lay.layer_indexes():
                    total += cell.shapes(li).size()
            return total

        # A committed 1 box, B committed 7 boxes.
        assert _total_shapes(out_a) == 1, \
            f"export(A) reload: expected 1 shape, got {_total_shapes(out_a)}"
        assert _total_shapes(out_b) == 7, \
            f"export(B) reload: expected 7 shapes, got {_total_shapes(out_b)}"
    finally:
        _call_invalidate(handle)


def test_export_pya_returns_str(tmp_path):
    """export(sha, 'pya') returns EXECUTABLE code that reconstructs the committed layout.

    Round-2 anti-cheat: a stub like ``f"pya.Layout() # {sha}"`` would pass a
    non-empty-string + contains-'pya' + differs-between-refs check.  We
    defeat it by actually EXECUTING the emitted code in a fresh subprocess
    (via :func:`_exec_pya_code_subprocess`), writing the reconstructed layout
    to GDS, reloading it, and asserting the shape counts match what was
    committed at each ref (1 box for A, 5 boxes for B).  Cross-ref sanity:
    the B-from-subprocess layout must NOT match A's shape count.

    Contract: export(sha, 'pya') must itself honour the DM-3 driver contract
    — the emitted code must leave a module-level ``layout = pya.Layout(...)``
    binding.
    """
    gds = _gds_path(tmp_path)
    handle = repo_mod.init(gds)
    try:
        # A commits 1 box, B commits 5 boxes.  Distinct, verifiable counts.
        r_a = handle.checkpoint(_make_layout(1), "A")
        assert r_a.get("ok"), f"commit A failed: {r_a!r}"
        sha_a = r_a["sha"]

        r_b = handle.checkpoint(_make_layout(5), "B")
        assert r_b.get("ok"), f"commit B failed: {r_b!r}"
        sha_b = r_b["sha"]
        assert sha_a != sha_b

        payload_a = handle.export(sha_a, "pya")
        payload_b = handle.export(sha_b, "pya")

        # Type / non-empty.
        assert isinstance(payload_a, str) and payload_a.strip(), \
            f"export(pya) must return non-empty str, got {type(payload_a).__name__}"
        assert isinstance(payload_b, str) and payload_b.strip(), \
            f"export(pya) must return non-empty str, got {type(payload_b).__name__}"

        # Must look like reconstruction code (per DM-3 contract).
        assert "pya.Layout" in payload_a, (
            f"export(pya) must reference pya.Layout for reconstruction; got start: {payload_a[:200]!r}"
        )
        assert "pya.Layout" in payload_b, (
            f"export(pya) must reference pya.Layout for reconstruction; got start: {payload_b[:200]!r}"
        )

        # CONTENT differentiation at the string level (pre-check).
        assert payload_a != payload_b, (
            "export(sha, 'pya') must honour the sha argument: exports at A "
            "and B returned identical strings even though content differs"
        )

        # ------------------------------------------------------------
        # ROUND-2 ANTI-CHEAT: actually execute both emitted code blocks
        # in fresh subprocesses and verify the RECONSTRUCTED layouts
        # carry the expected shape counts.  A comment-only stub cannot
        # pass this.
        # ------------------------------------------------------------
        out_a = os.path.join(str(tmp_path), "export_pya_a.gds")
        out_b = os.path.join(str(tmp_path), "export_pya_b.gds")
        _exec_pya_code_subprocess(payload_a, out_a)
        _exec_pya_code_subprocess(payload_b, out_b)

        n_a = _total_shapes_in_gds(out_a)
        n_b = _total_shapes_in_gds(out_b)
        assert n_a == 1, (
            f"export(A,'pya') executed must reproduce A's 1-shape layout, "
            f"got {n_a} shapes"
        )
        assert n_b == 5, (
            f"export(B,'pya') executed must reproduce B's 5-shape layout, "
            f"got {n_b} shapes"
        )
        # Cross-ref sanity — B's reconstruction must NOT match A's count.
        assert n_b != n_a, (
            "export(A,'pya') and export(B,'pya') must produce layouts with "
            f"distinct shape counts (got {n_a} for A, {n_b} for B)"
        )
    finally:
        _call_invalidate(handle)


# ---------------------------------------------------------------------------
# Empty-message edge case
# ---------------------------------------------------------------------------


def test_checkpoint_empty_message_does_not_crash(tmp_path):
    """Empty message is either accepted (preferred, per spec note) or a clean error."""
    gds = _gds_path(tmp_path)
    handle = repo_mod.init(gds)
    try:
        r = handle.checkpoint(_make_layout(1), "")
        assert isinstance(r, dict), f"must return dict, got {type(r).__name__}"
        if r.get("ok"):
            assert isinstance(r.get("sha"), str) and r["sha"].strip()
        else:
            _must_be_error_dict(r)
    finally:
        _call_invalidate(handle)
