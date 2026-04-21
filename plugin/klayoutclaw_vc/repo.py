"""qlaybot v0.4.4 Phase 4 §5.2.2 — version-control repo backend.

Scaffold; real implementation lands in tasks 4.4 / 4.5 / 4.6.

The module-level ``import subprocess`` is a HARD requirement — T33 in
``tests/test_vc_repo.py`` monkeypatches ``plugin.klayoutclaw_vc.repo.subprocess.run``
to inject OSError into ``git commit``.  Every git invocation that mutates
repository state must go through ``subprocess.run(...)`` (attribute access on
this module-level binding), never ``from subprocess import run``.
"""
from __future__ import annotations

import subprocess  # noqa: F401 — see module docstring (T33 contract)


def init(gds_path):  # pragma: no cover - scaffold
    raise NotImplementedError("init is implemented in task 4.4")


def migrate_to_disk(handle, gds_path):  # pragma: no cover - scaffold
    raise NotImplementedError("migrate_to_disk is implemented in task 4.5")
