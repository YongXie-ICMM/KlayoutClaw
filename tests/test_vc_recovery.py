#!/usr/bin/env python
"""Tests for crash-recovery journal (qlaybot v0.4.4 Phase 4, §5.2.2, DM-5).

Covers §9.2 T15: after every successful checkpoint, ``<repo>/RECOVERY/journal.json``
is written with ``{last_good_sha, ts}``; when ``init()`` detects a dangling
journal (working tree differs from ``last_good_sha``), ``status()`` surfaces
``recovery_offered: True``.

Memory-mode and pre-save states are explicitly out of scope (no on-disk
repo -> no journal), so recovery is only tested on the disk-mode path.

Contract notes for the Executor
--------------------------------
* After every successful ``checkpoint(...)`` against a disk-mode repo, a file at
  ``<sidecar>/RECOVERY/journal.json`` MUST exist and contain a JSON object with
  at minimum::

      {"last_good_sha": "<40-char-lowercase-hex>", "ts": "<ISO-8601 timestamp>"}

  Strict requirements:
    - ``last_good_sha`` matches ``^[0-9a-f]{40}$`` — the full git sha1, not a
      7-char or 8-char prefix.
    - ``ts`` is parseable by ``datetime.datetime.fromisoformat(...)`` (Python's
      ISO-8601 parser).  A trailing 'Z' (UTC designator) is also accepted;
      any other decorator string will fail.
* On ``init(gds_path)``, if ``<sidecar>/RECOVERY/journal.json`` exists AND the
  working tree (or HEAD) differs from ``last_good_sha``, the returned handle's
  ``status()`` MUST include ``recovery_offered: True`` plus
  ``last_good_sha == <that sha>``.  If the tree is clean at ``last_good_sha``,
  ``recovery_offered`` is False (or absent).
"""
from __future__ import annotations

import datetime
import json
import os
import re
import subprocess as _real_subprocess
import sys

import pytest

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

repo_mod = pytest.importorskip("plugin.klayoutclaw_vc.repo")

import klayout.db as pya  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers (kept local to avoid cross-test-file imports in ways the Executor
# doesn't need to worry about).
# ---------------------------------------------------------------------------


def _make_layout(n: int = 1) -> pya.Layout:
    layout = pya.Layout()
    layout.dbu = 0.001
    top = layout.create_cell("TOP")
    li = layout.layer(1, 0)
    for i in range(n):
        top.shapes(li).insert(pya.Box(i * 100, 0, i * 100 + 50, 50))
    return layout


def _gds_path(tmp_path) -> str:
    path = os.path.join(str(tmp_path), "design.gds")
    _make_layout(1).write(path)
    return path


def _sidecar(gds_path: str) -> str:
    return gds_path + ".vc"


def _call_invalidate(handle):
    for attr in ("invalidate", "close"):
        fn = getattr(handle, attr, None)
        if callable(fn):
            fn()
            return
    pytest.fail("RepoHandle must expose invalidate() or close()")


def _force_to_disk(handle, gds_path):
    """If handle is in memory mode, migrate so we have a sidecar to inspect."""
    if handle.status().get("mode") == "memory":
        repo_mod.migrate_to_disk(handle, gds_path)


def _init_disk_mode_repo(gds_path):
    """Round-4 DM-5 scope fix: return a fresh handle ALREADY in disk mode.

    DM-5 specifies that the recovery journal is a disk-backed artifact;
    memory-mode checkpoints are explicitly out of scope ("a crash before
    the first save_layout leaves no durable state").  A spec-compliant
    implementation may therefore write the journal ONLY on the first
    disk-mode checkpoint, not retroactively on migration of an earlier
    memory-mode checkpoint.

    All T15 / DM-5 tests must therefore force disk mode BEFORE the first
    checkpoint so that checkpoint is itself a disk-mode op and the
    journal-writing contract applies.
    """
    handle = repo_mod.init(gds_path)
    _force_to_disk(handle, gds_path)
    # Post-condition: handle must be in disk mode now.
    mode = handle.status().get("mode")
    assert mode == "disk", (
        f"pre-condition: _init_disk_mode_repo must yield a disk-mode handle, "
        f"got mode={mode!r}"
    )
    return handle


# Strict validators for DM-5 journal shape (round-2 + round-3 anti-cheat).

_SHA40_RE = re.compile(r"^[0-9a-f]{40}$")


def _assert_valid_sha40(sha: object) -> None:
    """Assert ``sha`` is a full 40-char lowercase hex git sha."""
    assert isinstance(sha, str), \
        f"DM-5: sha must be a string, got {type(sha).__name__}"
    assert _SHA40_RE.match(sha), (
        f"DM-5: sha must be 40-char lowercase hex, got {sha!r} "
        f"(len={len(sha)})"
    )


def _assert_valid_iso8601(ts: object) -> None:
    """Assert ``ts`` is parseable as an ISO-8601 timestamp.

    Accepts trailing 'Z' (UTC designator).  Python's
    ``datetime.fromisoformat`` handles offsets and fractional seconds.
    A trailing 'Z' is only directly parseable on Python 3.11+, so we
    normalise it to '+00:00' first for broader compatibility.
    """
    assert isinstance(ts, str) and ts.strip(), \
        f"DM-5: ts must be non-empty string, got {ts!r}"
    s = ts[:-1] + "+00:00" if ts.endswith("Z") else ts
    try:
        datetime.datetime.fromisoformat(s)
    except (TypeError, ValueError) as e:
        raise AssertionError(
            f"DM-5: journal.ts {ts!r} is not a valid ISO-8601 timestamp: {e}"
        )


def _assert_sha_is_real_commit(sidecar: str, sha: str) -> None:
    """Round-3 anti-cheat: prove ``sha`` is a real commit object in ``sidecar``.

    Runs ``git -C <sidecar> cat-file -e <sha>^{commit}`` via
    ``_real_subprocess``.  ``cat-file -e`` exits zero iff the named object
    exists AND the ``^{commit}`` peeling resolves to a commit (i.e. the
    object is a commit, or a tag/ref pointing at a commit).  Exits non-zero
    otherwise.  Defeats a synchronised-fake impl where ``checkpoint()``
    fabricates a plausible-looking sha, drops it into journal.json, and
    echoes it from ``status()``.
    """
    proc = _real_subprocess.run(
        ["git", "-C", sidecar, "cat-file", "-e", f"{sha}^{{commit}}"],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, (
        f"DM-5 anti-cheat: sha {sha!r} is NOT a real commit object in the "
        f"git repo at {sidecar!r}. "
        f"`git cat-file -e {sha}^{{commit}}` exited {proc.returncode} "
        f"(stderr={proc.stderr.strip()!r}). "
        "Journal appears to reference a fabricated sha."
    )


# ---------------------------------------------------------------------------
# DM-5 — journal is written on successful checkpoint
# ---------------------------------------------------------------------------


def test_journal_written_after_successful_checkpoint(tmp_path):
    """DM-5: successful DISK-MODE checkpoint creates RECOVERY/journal.json with last_good_sha.

    Round-4 scope fix: DM-5 is disk-backed-only — we force disk mode BEFORE
    the first checkpoint so that checkpoint is itself a disk-mode operation
    and the journal-writing contract applies.  A spec-compliant impl that
    writes the journal only on disk-mode checkpoints would otherwise
    reasonably skip a memory-mode seed commit.
    """
    gds = _gds_path(tmp_path)
    # Force disk mode BEFORE first checkpoint (round-4 DM-5 scope fix).
    handle = _init_disk_mode_repo(gds)
    try:
        r = handle.checkpoint(_make_layout(1), "c1")
        assert r.get("ok") is True, f"disk-mode seed checkpoint failed: {r}"

        # Follow-up disk-mode checkpoint.  The journal must reflect the
        # most recent commit either way — we use c2's sha as the reference
        # for the strict equality check below.
        r2 = handle.checkpoint(_make_layout(2), "c2")
        assert r2.get("ok") is True, f"follow-up checkpoint failed: {r2}"

        journal_path = os.path.join(_sidecar(gds), "RECOVERY", "journal.json")
        assert os.path.exists(journal_path), \
            f"DM-5 violated: journal not found at {journal_path}"

        data = json.loads(open(journal_path).read())
        assert isinstance(data, dict)

        # STRICT: last_good_sha is a full 40-char lowercase-hex git sha.
        lgs = data.get("last_good_sha")
        _assert_valid_sha40(lgs)

        # STRICT: last_good_sha references the most recent successful
        # checkpoint.  Since we now require a full sha, demand exact equality
        # — prefix matching would allow a stub returning a hashed timestamp.
        assert lgs == r2["sha"], (
            "DM-5: journal.last_good_sha must equal the most recent "
            f"checkpoint sha, got {lgs!r} vs checkpoint sha {r2['sha']!r}"
        )

        # ROUND-3 anti-cheat: prove lgs is a real commit object in the
        # sidecar git repo.  A synchronised-fake impl that fabricates a sha
        # in checkpoint() and echoes it from status() / journal fails here.
        sidecar = _sidecar(gds)
        _assert_sha_is_real_commit(sidecar, lgs)

        # ROUND-3 anchor: HEAD at the moment the journal was written must
        # equal last_good_sha.  The journal is written inside checkpoint(),
        # and right now (immediately after the checkpoint returned) HEAD
        # should still be sitting on that commit — no intervening ops.
        head_proc = _real_subprocess.run(
            ["git", "-C", sidecar, "rev-parse", "HEAD"],
            capture_output=True, text=True,
        )
        assert head_proc.returncode == 0, (
            f"DM-5 anti-cheat: `git rev-parse HEAD` failed in {sidecar!r} "
            f"(rc={head_proc.returncode}, stderr={head_proc.stderr.strip()!r})"
        )
        head_sha = head_proc.stdout.strip()
        assert head_sha == lgs, (
            "DM-5: immediately after a successful checkpoint, git HEAD must "
            f"equal journal.last_good_sha.  got HEAD={head_sha!r}, "
            f"journal.last_good_sha={lgs!r}"
        )

        # STRICT: ts parses as ISO-8601.
        _assert_valid_iso8601(data.get("ts"))
    finally:
        _call_invalidate(handle)


# ---------------------------------------------------------------------------
# T15 — dangling journal on init surfaces recovery_offered
# ---------------------------------------------------------------------------


def test_init_surfaces_recovery_when_worktree_dirty_vs_journal(tmp_path):
    """T15: dirty worktree + journal referring to a different sha -> recovery_offered=True.

    Round-4 scope fix: force disk mode BEFORE the first checkpoint so the
    journal-writing contract (DM-5 disk-backed-only) definitely applies.
    """
    gds = _gds_path(tmp_path)

    # Step 1: create DISK-MODE repo, then checkpoint A (round-4 fix).
    handle = _init_disk_mode_repo(gds)
    r_a = handle.checkpoint(_make_layout(1), "A")
    assert r_a.get("ok"), f"disk-mode checkpoint A failed: {r_a}"
    a_sha = r_a["sha"]
    sidecar = _sidecar(gds)

    # ROUND-3 anti-cheat: before doing anything else, confirm a_sha is a
    # real commit object in the sidecar repo.  If checkpoint() fabricated
    # the sha, the rest of this test is meaningless.
    _assert_sha_is_real_commit(sidecar, a_sha)

    journal_path = os.path.join(sidecar, "RECOVERY", "journal.json")
    assert os.path.exists(journal_path), \
        "pre-condition: journal must exist after successful disk-mode checkpoint A"

    # Step 2: simulate an uncheckpointed edit (dirty working tree).  We do this
    # by dropping a file into the sidecar working tree that git will see as
    # untracked.  Any untracked/modified state qualifies as "working tree
    # differs from last_good_sha".
    stray = os.path.join(_sidecar(gds), "uncheckpointed.txt")
    with open(stray, "w") as fh:
        fh.write("simulated crash: uncommitted edit\n")

    # Step 3: discard the handle WITHOUT committing.
    _call_invalidate(handle)

    # Step 4: re-init on the same GDS path.
    handle2 = repo_mod.init(gds)
    try:
        st = handle2.status()
        assert isinstance(st, dict)

        assert st.get("recovery_offered") is True, \
            ("T15 violated: expected status.recovery_offered=True after "
             f"dangling-journal detection, got {st.get('recovery_offered')!r} "
             f"(full status={st})")

        # Optionally, last_good_sha is surfaced.  Accept either top-level
        # 'last_good_sha' OR a nested 'recovery' dict.
        lgs = st.get("last_good_sha")
        if lgs is None:
            rec = st.get("recovery") or {}
            lgs = rec.get("last_good_sha") if isinstance(rec, dict) else None
        # STRICT: full 40-char sha.
        _assert_valid_sha40(lgs)
        # STRICT: exact match with the committed sha.
        assert lgs == a_sha, (
            f"T15: last_good_sha must equal the journal's sha, "
            f"journal committed sha={a_sha!r}, status surfaced={lgs!r}"
        )
        # ROUND-3 anti-cheat: the surfaced sha must also be a real commit
        # in the sidecar repo.  (``a_sha`` was already checked before the
        # crash simulation; this confirms the post-crash ``status()`` surfaces
        # a real-commit reference, not a fabricated one.)
        _assert_sha_is_real_commit(sidecar, lgs)
    finally:
        _call_invalidate(handle2)


def test_init_clean_tree_does_not_flag_recovery(tmp_path):
    """Counter-check: when worktree matches last_good_sha, recovery is NOT offered.

    Round-4 scope fix: force disk mode BEFORE the first checkpoint so the
    journal exists per DM-5's disk-backed-only contract.
    """
    gds = _gds_path(tmp_path)
    # Force disk mode first (round-4 DM-5 scope fix).
    handle = _init_disk_mode_repo(gds)
    r = handle.checkpoint(_make_layout(1), "A")
    assert r.get("ok"), f"disk-mode checkpoint A failed: {r}"
    _call_invalidate(handle)

    handle2 = repo_mod.init(gds)
    try:
        st = handle2.status()
        # Spec says recovery_offered is True ONLY when worktree differs.
        # Clean tree -> absent or False.
        ro = st.get("recovery_offered", False)
        assert ro is False, \
            f"clean worktree must not flag recovery_offered, got status={st}"
    finally:
        _call_invalidate(handle2)


def test_memory_mode_has_no_journal(tmp_path):
    """DM-5 scope guard: memory-mode (pre-save) has no on-disk journal."""
    gds = _gds_path(tmp_path)
    handle = repo_mod.init(gds)
    try:
        # Stay in memory mode: checkpoint, but do NOT migrate.
        r = handle.checkpoint(_make_layout(1), "mem-c1")
        assert r.get("ok"), f"memory checkpoint failed: {r}"
        assert handle.status().get("mode") == "memory"

        # The sidecar must NOT exist on disk (T28b reprise).
        assert not os.path.exists(_sidecar(gds)), \
            "memory mode must not create the on-disk sidecar"
        # Therefore no RECOVERY journal on disk either.
        journal_path = os.path.join(_sidecar(gds), "RECOVERY", "journal.json")
        assert not os.path.exists(journal_path), \
            "memory-mode recovery journal must not live at the disk sidecar path"
    finally:
        _call_invalidate(handle)
