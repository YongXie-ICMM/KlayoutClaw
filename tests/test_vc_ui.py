#!/usr/bin/env python
"""Phase 6 UI tests for plugin.klayoutclaw_vc.ui.

These tests run the real Qt code inside a scripted KLayout subprocess and
assert on structured JSON emitted by the script.  The host pytest process
stays in plain Python so the test suite remains runnable from the normal
conda environment.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

import pytest

import klayout.db as pya

from plugin.klayoutclaw_vc import repo as vc_repo


REPO_ROOT = Path(__file__).resolve().parents[1]
KLAYOUT_BIN = Path("/Applications/klayout.app/Contents/MacOS/klayout")


def _make_layout(*, extra_box: bool = False) -> pya.Layout:
    layout = pya.Layout()
    layout.dbu = 0.001
    top = layout.create_cell("TOP")
    li = layout.layer(1, 0)
    top.shapes(li).insert(pya.Box(0, 0, 1000, 1000))
    if extra_box:
        top.shapes(li).insert(pya.Box(1500, 0, 2200, 900))
    return layout


def _create_disk_backed_repo(tmp_path: Path) -> Path:
    gds_path = tmp_path / "design.gds"
    layout = _make_layout()
    layout.write(str(gds_path))
    handle = vc_repo.init(str(gds_path))
    result = handle.checkpoint(layout, "baseline")
    assert result.get("ok") is True, result
    vc_repo.migrate_to_disk(handle, str(gds_path))
    handle.invalidate()
    return gds_path


def _append_checkpoint(gds_path: Path, message: str, *, extra_box: bool = False) -> None:
    layout = _make_layout(extra_box=extra_box)
    handle = vc_repo.init(str(gds_path))
    result = handle.checkpoint(layout, message)
    assert result.get("ok") is True, result
    handle.invalidate()


def _run_klayout_script(body: str) -> dict:
    if not KLAYOUT_BIN.exists():
        pytest.skip(f"KLayout binary not found at {KLAYOUT_BIN}")

    script = textwrap.dedent(
        f"""
        import json
        import os
        import re
        import sys

        sys.path.insert(0, {str(REPO_ROOT)!r})

        import pya

        _SCRIPT_OK = False
        try:
        {textwrap.indent(textwrap.dedent(body), '            ')}
            _SCRIPT_OK = True
        finally:
            _controller = globals().get("controller")
            if _controller is not None:
                try:
                    _controller.shutdown()
                    pya.QApplication.processEvents()
                except Exception:
                    pass
            if _SCRIPT_OK:
                try:
                    sys.stdout.flush()
                    sys.stderr.flush()
                finally:
                    os._exit(0)
        """
    )

    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as fh:
        fh.write(script)
        script_path = fh.name

    env = dict(os.environ)
    env["PYTHONPATH"] = (
        str(REPO_ROOT)
        + os.pathsep
        + env.get("PYTHONPATH", "")
    )

    try:
        result = subprocess.run(
            [
                str(KLAYOUT_BIN),
                "-z",
                "-nc",
                "-rx",
                "-r",
                script_path,
            ],
            capture_output=True,
            text=True,
            env=env,
            timeout=120,
        )
    finally:
        try:
            os.unlink(script_path)
        except OSError:
            pass

    if result.returncode != 0:
        raise AssertionError(
            "KLayout script failed.\n"
            f"stdout:\n{result.stdout}\n"
            f"stderr:\n{result.stderr}"
        )

    marker = "RESULT_JSON="
    payload = None
    for line in result.stdout.splitlines():
        if line.startswith(marker):
            payload = line[len(marker):]
    if payload is None:
        raise AssertionError(
            "KLayout script did not emit RESULT_JSON.\n"
            f"stdout:\n{result.stdout}\n"
            f"stderr:\n{result.stderr}"
        )
    return json.loads(payload)


def test_status_chip_tracks_dirty_and_checkpoint_state(tmp_path):
    gds_path = _create_disk_backed_repo(tmp_path)

    result = _run_klayout_script(
        f"""
        from plugin.klayoutclaw_vc import ui as vc_ui
        import tools.vc_mcp_handlers as vc_handlers

        mw = pya.Application.instance().main_window()
        controller = vc_ui.install_ui(main_window=mw, poll_interval_ms=25)
        mw.load_layout({str(gds_path)!r}, pya.LoadLayoutOptions(), "", 1)
        pya.QApplication.processEvents()
        controller.refresh()

        view = mw.current_view()
        layout = view.active_cellview().layout()
        li = layout.layer(1, 0)
        top = layout.top_cell()

        initial_text = controller.status_chip.text()
        registry_entry = vc_handlers.REGISTRY.get(id(layout))
        registry_mode = getattr(registry_entry["handle"], "_mode", None) if registry_entry else None

        top.shapes(li).insert(pya.Box(3000, 0, 3600, 600))
        pya.QApplication.processEvents()
        controller.refresh()
        dirty_text = controller.status_chip.text()

        checkpoint_result = vc_handlers.vc_checkpoint(
            {{"message": "after edit", "tags": []}},
            layout=layout,
            gds_path_hint={str(gds_path)!r},
        )
        pya.QApplication.processEvents()
        controller.refresh()
        clean_text = controller.status_chip.text()

        print("RESULT_JSON=" + json.dumps({{
            "initial_text": initial_text,
            "dirty_text": dirty_text,
            "clean_text": clean_text,
            "checkpoint_result": checkpoint_result,
            "registry_mode": registry_mode,
        }}))
        """
    )

    assert re.match(r"^\S+ • (clean|⬤dirty) • last: \d+ min ago$", result["initial_text"])
    assert "⬤dirty" in result["dirty_text"]
    assert "clean" in result["clean_text"]
    assert result["checkpoint_result"]["ok"] is True
    assert result["registry_mode"] == "disk"


def test_checkpoint_dialog_hotkey_parses_tags_and_submits(tmp_path):
    gds_path = _create_disk_backed_repo(tmp_path)

    result = _run_klayout_script(
        f"""
        from plugin.klayoutclaw_vc import ui as vc_ui
        import tools.vc_mcp_handlers as vc_handlers

        mw = pya.Application.instance().main_window()
        controller = vc_ui.install_ui(main_window=mw, poll_interval_ms=25)
        mw.load_layout({str(gds_path)!r}, pya.LoadLayoutOptions(), "", 1)
        pya.QApplication.processEvents()
        controller.refresh()

        view = mw.current_view()
        layout = view.active_cellview().layout()

        controller.checkpoint_shortcut.emit_activated()
        pya.QApplication.processEvents()
        dialog = controller.checkpoint_dialog

        opened = dialog.is_open()
        dialog.message_edit.setText("")
        dialog.tags_edit.setText("alpha, beta , , gamma")
        dialog.submit()
        pya.QApplication.processEvents()
        blank_error = dialog.error_text()
        still_open_after_blank = dialog.is_open()

        dialog.message_edit.setText("checkpoint from dialog")
        dialog.submit()
        pya.QApplication.processEvents()

        history = vc_handlers.vc_history(
            {{}},
            layout=layout,
            gds_path_hint={str(gds_path)!r},
        )

        print("RESULT_JSON=" + json.dumps({{
            "opened": opened,
            "blank_error": blank_error,
            "still_open_after_blank": still_open_after_blank,
            "closed_after_submit": not dialog.is_open(),
            "latest_commit": history["commits"][0],
            "chip_text": controller.status_chip.text(),
        }}))
        """
    )

    assert result["opened"] is True
    assert "required" in result["blank_error"].lower()
    assert result["still_open_after_blank"] is True
    assert result["closed_after_submit"] is True
    assert result["latest_commit"]["message"] == "checkpoint from dialog"
    assert result["latest_commit"]["tags"] == ["alpha", "beta", "gamma"]
    assert "clean" in result["chip_text"]


def test_history_dock_hotkey_populates_rows_and_defers_older_thumbnails(tmp_path):
    gds_path = _create_disk_backed_repo(tmp_path)
    _append_checkpoint(gds_path, "older checkpoint", extra_box=True)

    result = _run_klayout_script(
        f"""
        from plugin.klayoutclaw_vc import ui as vc_ui

        mw = pya.Application.instance().main_window()
        controller = vc_ui.install_ui(main_window=mw, poll_interval_ms=25)
        mw.load_layout({str(gds_path)!r}, pya.LoadLayoutOptions(), "", 1)
        pya.QApplication.processEvents()
        controller.refresh()

        controller.checkpoint_shortcut.emit_activated()
        pya.QApplication.processEvents()
        controller.checkpoint_dialog.message_edit.setText("panel commit")
        controller.checkpoint_dialog.tags_edit.setText("ui, latest")
        controller.checkpoint_dialog.submit()
        pya.QApplication.processEvents()

        controller.history_shortcut.emit_activated()
        pya.QApplication.processEvents()
        panel = controller.history_dock

        top_row = panel.row_data(0)
        older_before = panel.row_data(1)
        panel.ensure_thumbnail_for_row(1)
        pya.QApplication.processEvents()
        older_after = panel.row_data(1)

        print("RESULT_JSON=" + json.dumps({{
            "visible": panel.is_visible(),
            "row_count": panel.row_count(),
            "top_row": top_row,
            "older_before": older_before,
            "older_after": older_after,
        }}))
        """
    )

    assert result["visible"] is True
    assert result["row_count"] >= 3
    assert result["top_row"]["message"] == "panel commit"
    assert sorted(result["top_row"]["tags"]) == ["latest", "ui"]
    assert result["top_row"]["thumbnail_loaded"] is True
    assert result["older_before"]["thumbnail_loaded"] is False
    assert result["older_after"]["thumbnail_loaded"] is True
