"""qlaybot v0.4.4 Phase 6 §5.2.3 — KLayout VC UI.

The module stays importable in plain Python, but the concrete Qt widgets are
only usable inside KLayout's embedded Python where ``pya`` exposes Qt.
"""
from __future__ import annotations

import datetime
import os
import sys
import types
from typing import Any, Optional

try:  # KLayout runtime
    import pya  # type: ignore
except ImportError:  # pragma: no cover - plain Python import path
    import klayout.db as pya  # type: ignore


_STATE_MODULE = "_klayoutclaw"
_DIRTY_TEXT = "⬤dirty"
_BULLET = "•"


def _require_qt() -> None:
    if not hasattr(pya, "Application") or not hasattr(pya, "QLabel"):
        raise RuntimeError("plugin.klayoutclaw_vc.ui requires KLayout's Qt-enabled pya")


def _session_state():
    state = sys.modules.get(_STATE_MODULE)
    if state is None:
        state = types.ModuleType(_STATE_MODULE)
        sys.modules[_STATE_MODULE] = state
    settings = getattr(state, "settings", None)
    if not isinstance(settings, dict):
        state.settings = {"autoCheckpointOnSave": True}
    elif "autoCheckpointOnSave" not in settings:
        settings["autoCheckpointOnSave"] = True
    return state


def _callable_or_value(obj, attr: str):
    value = getattr(obj, attr)
    return value() if callable(value) else value


def _current_view(main_window):
    try:
        return main_window.current_view()
    except Exception:
        return None


def _active_cellview(view):
    try:
        return view.active_cellview()
    except Exception:
        return None


def _layout_for_view(view):
    cellview = _active_cellview(view)
    if cellview is None:
        return None
    try:
        return cellview.layout()
    except Exception:
        return None


def _gds_path_for_view(view) -> Optional[str]:
    cellview = _active_cellview(view)
    if cellview is None:
        return None
    try:
        filename = _callable_or_value(cellview, "filename")
    except Exception:
        return None
    if not filename:
        return None
    return os.path.abspath(str(filename))


def _ensure_vc_handle_for_view(view):
    layout = _layout_for_view(view)
    gds_path = _gds_path_for_view(view)
    if layout is None or not gds_path:
        return None

    from plugin.klayoutclaw_vc import repo as vc_repo
    import tools.vc_mcp_handlers as vc_handlers

    entry = vc_handlers.REGISTRY.get(id(layout))
    if entry is not None and entry.get("gds_path") == gds_path:
        handle = entry.get("handle")
        if handle is not None and not getattr(handle, "_invalidated", False):
            return entry

    handle = vc_repo.init(gds_path)
    entry = {"handle": handle, "gds_path": gds_path}
    vc_handlers.REGISTRY[id(layout)] = entry
    return entry


def _minutes_ago(ts_text: Optional[str]) -> Optional[int]:
    if not ts_text:
        return None
    try:
        when = datetime.datetime.fromisoformat(ts_text)
    except Exception:
        return None
    if when.tzinfo is None:
        now = datetime.datetime.now()
    else:
        now = datetime.datetime.now(when.tzinfo)
    delta = now - when
    minutes = int(max(0, delta.total_seconds()) // 60)
    return minutes


def _format_status(status: dict) -> tuple[str, str]:
    mode = status.get("mode", "unknown")
    branch = status.get("branch")
    minutes = _minutes_ago(status.get("last_checkpoint_ts"))
    if branch and minutes is not None:
        cleanliness = _DIRTY_TEXT if status.get("dirty") else "clean"
        return (
            f"{branch} {_BULLET} {cleanliness} {_BULLET} last: {minutes} min ago",
            f"mode: {mode}",
        )
    return (f"VC: mode: {mode}", f"mode: {mode}")


class VCStatusChip:
    """Status-bar label that reflects the active layout's VC status."""

    def __init__(self, main_window, *, poll_interval_ms: int = 5000):
        _require_qt()
        self._main_window = main_window
        self._label = pya.QLabel("VC: not initialized")
        self._label.setObjectName("klayoutclaw-vc-status-chip")
        self._label.setStyleSheet(
            "QLabel#klayoutclaw-vc-status-chip { padding: 0 8px; color: #555555; }"
        )
        self._label.setToolTip("mode: unknown")
        self._poll_timer = pya.QTimer()
        self._poll_timer.timeout(self.refresh)
        self._poll_timer.start(max(50, int(poll_interval_ms)))
        self._attach_to_status_bar()

    @property
    def widget(self):
        return self._label

    def text(self) -> str:
        return str(_callable_or_value(self._label, "text"))

    def refresh(self) -> dict:
        from tools import vc_mcp_handlers as vc_handlers

        view = _current_view(self._main_window)
        if view is None:
            self._show_not_initialized()
            return {"ok": False, "reason": "no current view"}

        entry = _ensure_vc_handle_for_view(view)
        if entry is None:
            self._show_not_initialized()
            return {"ok": False, "reason": "vc not initialized"}

        layout = _layout_for_view(view)
        gds_path = _gds_path_for_view(view)
        status = vc_handlers.vc_status({}, layout=layout, gds_path_hint=gds_path)
        if not isinstance(status, dict) or status.get("ok") is False:
            self._show_not_initialized()
            return status if isinstance(status, dict) else {"ok": False}

        text, tooltip = _format_status(status)
        self._label.setText(text)
        self._label.setToolTip(tooltip)
        color = "#a61d24" if status.get("dirty") else "#1d6b36"
        self._label.setStyleSheet(
            "QLabel#klayoutclaw-vc-status-chip { padding: 0 8px; color: "
            + color
            + "; }"
        )
        return status

    def _attach_to_status_bar(self) -> None:
        status_bar = self._main_window.statusBar
        try:
            status_bar.addPermanentWidget(self._label)
        except Exception:
            status_bar.addWidget(self._label)

    def _show_not_initialized(self) -> None:
        self._label.setText("VC: not initialized")
        self._label.setToolTip("mode: unavailable")
        self._label.setStyleSheet(
            "QLabel#klayoutclaw-vc-status-chip { padding: 0 8px; color: #555555; }"
        )


class CheckpointDialog:
    """Task 6.2 implementation lands later; placeholder for composition."""

    def __init__(self, controller):
        self.controller = controller


class HistoryDockPanel:
    """Task 6.3 implementation lands later; placeholder for composition."""

    def __init__(self, controller):
        self.controller = controller


class ContextMenus:
    """Task 6.5 implementation lands later; placeholder for composition."""

    def __init__(self, controller):
        self.controller = controller


class SaveIntegration:
    """Task 6.4 implementation lands later; placeholder for composition."""

    def __init__(self, controller):
        self.controller = controller


class VCUIController:
    """Composes the Phase 6 VC UI pieces for a KLayout main window."""

    def __init__(self, main_window, *, poll_interval_ms: int = 5000):
        _require_qt()
        self.main_window = main_window
        self.status_chip = VCStatusChip(
            main_window, poll_interval_ms=poll_interval_ms,
        )
        self.checkpoint_dialog = CheckpointDialog(self)
        self.history_dock = HistoryDockPanel(self)
        self.context_menus = ContextMenus(self)
        self.save_integration = SaveIntegration(self)
        self._connected_views: set[int] = set()
        self._connect_main_window()
        self._attach_current_view()
        self.refresh()

    def refresh(self):
        return self.status_chip.refresh()

    def _connect_main_window(self) -> None:
        try:
            self.main_window.on_view_created(self._on_view_created)
        except Exception:
            pass
        try:
            self.main_window.on_current_view_changed(self._on_current_view_changed)
        except Exception:
            pass

    def _attach_current_view(self) -> None:
        view = _current_view(self.main_window)
        if view is None:
            return
        view_id = id(view)
        if view_id in self._connected_views:
            return
        self._connected_views.add(view_id)
        try:
            view.on_file_open(lambda: self._handle_view_event(view))
        except Exception:
            pass
        try:
            view.on_cellview_changed(lambda: self._handle_view_event(view))
        except Exception:
            pass
        try:
            view.on_active_cellview_changed(lambda: self._handle_view_event(view))
        except Exception:
            pass
        self._handle_view_event(view)

    def _handle_view_event(self, view) -> None:
        _ensure_vc_handle_for_view(view)
        self.refresh()

    def _on_view_created(self) -> None:
        self._attach_current_view()

    def _on_current_view_changed(self) -> None:
        self._attach_current_view()
        self.refresh()


def install_ui(*, main_window=None, poll_interval_ms: int = 5000) -> VCUIController:
    """Install or return the singleton VC UI controller for the session."""
    _require_qt()
    state = _session_state()
    if main_window is None:
        app = pya.Application.instance()
        if app is None:
            raise RuntimeError("KLayout application instance unavailable")
        main_window = app.main_window()
    if main_window is None:
        raise RuntimeError("KLayout main window unavailable")

    controller = getattr(state, "vc_ui_controller", None)
    if isinstance(controller, VCUIController) and controller.main_window is main_window:
        controller.refresh()
        return controller

    controller = VCUIController(main_window, poll_interval_ms=poll_interval_ms)
    state.vc_ui_controller = controller
    return controller
