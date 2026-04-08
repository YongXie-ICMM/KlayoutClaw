#!/usr/bin/env python
"""Static analysis tests for stdout/stderr capture in execute_script (#13).

Feature: _tool_execute_script must capture print() output via io.StringIO
redirect before exec(), restore after, and include stdout/stderr in result.

Tests parse the .lym XML, extract the Python AST, and verify
the capture logic is present and correctly structured.

Tests FAIL against the current code (no capture) and PASS once fixed.
"""
import ast
import os
import xml.etree.ElementTree as ET

import pytest

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LYM_PATH = os.path.join(PROJECT_ROOT, "plugin", "klayoutclaw_server.lym")


@pytest.fixture(scope="module")
def server_ast():
    """Parse klayoutclaw_server.lym and return the AST of its Python source."""
    tree = ET.parse(LYM_PATH)
    root = tree.getroot()
    text_elem = root.find("text")
    assert text_elem is not None
    source = text_elem.text
    assert source and len(source.strip()) > 0
    return ast.parse(source, filename="klayoutclaw_server.lym")


def _find_function(module_ast, name):
    """Find a FunctionDef with the given name anywhere in the AST."""
    for node in ast.walk(module_ast):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    return None


def _get_function_source_names(func_node):
    """Get all Name and Attribute references in a function body."""
    names = set()
    for node in ast.walk(func_node):
        if isinstance(node, ast.Name):
            names.add(node.id)
        elif isinstance(node, ast.Attribute):
            names.add(node.attr)
    return names


def _find_call_positions(func_node, call_name):
    """Find line numbers of all calls to a given function/method name."""
    positions = []
    for node in ast.walk(func_node):
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id == call_name:
                positions.append(node.lineno)
            elif isinstance(node.func, ast.Attribute) and node.func.attr == call_name:
                positions.append(node.lineno)
    return positions


def _get_string_constants(node):
    """Get all string constants in an AST subtree."""
    strings = []
    for n in ast.walk(node):
        if isinstance(n, ast.Constant) and isinstance(n.value, str):
            strings.append(n.value)
    return strings


class TestStdoutCaptureExists:
    """_tool_execute_script must redirect stdout/stderr via io.StringIO."""

    def test_references_stringio(self, server_ast):
        """Must reference io.StringIO for output capture."""
        func = _find_function(server_ast, "_tool_execute_script")
        assert func is not None
        names = _get_function_source_names(func)
        assert "StringIO" in names, (
            "_tool_execute_script must reference io.StringIO for output capture"
        )

    def test_references_sys_stdout(self, server_ast):
        """Must reference sys.stdout for redirection."""
        func = _find_function(server_ast, "_tool_execute_script")
        assert func is not None
        names = _get_function_source_names(func)
        assert "stdout" in names, (
            "_tool_execute_script must reference sys.stdout"
        )

    def test_references_sys_stderr(self, server_ast):
        """Must reference sys.stderr for redirection."""
        func = _find_function(server_ast, "_tool_execute_script")
        assert func is not None
        names = _get_function_source_names(func)
        assert "stderr" in names, (
            "_tool_execute_script must reference sys.stderr"
        )


class TestStdoutCaptureOrder:
    """StringIO redirect must happen before exec, restore after."""

    def test_stringio_created_before_exec(self, server_ast):
        """io.StringIO must be instantiated before exec()."""
        func = _find_function(server_ast, "_tool_execute_script")
        assert func is not None
        stringio_lines = _find_call_positions(func, "StringIO")
        exec_lines = _find_call_positions(func, "exec")
        assert stringio_lines, "No io.StringIO call found"
        assert exec_lines, "No exec call found"
        assert min(stringio_lines) < min(exec_lines), (
            "io.StringIO (line {}) must be created before exec (line {})".format(
                min(stringio_lines), min(exec_lines)
            )
        )


class TestStdoutCaptureRestore:
    """stdout/stderr must be restored after exec (in try/finally)."""

    def test_uses_try_finally_for_restore(self, server_ast):
        """Must use try/finally to ensure stdout/stderr are restored."""
        func = _find_function(server_ast, "_tool_execute_script")
        assert func is not None
        # Walk the function body for Try nodes with finalbody
        has_finally = False
        for node in ast.walk(func):
            if isinstance(node, ast.Try) and node.finalbody:
                # The finally block must reference stdout (restore)
                finally_names = set()
                for n in ast.walk(node):
                    if isinstance(n, ast.Name):
                        finally_names.add(n.id)
                    elif isinstance(n, ast.Attribute):
                        finally_names.add(n.attr)
                if "stdout" in finally_names:
                    has_finally = True
        assert has_finally, (
            "_tool_execute_script must use try/finally to restore sys.stdout"
        )


class TestStdoutInResult:
    """Captured stdout/stderr must be included in the result."""

    def test_result_includes_stdout_key(self, server_ast):
        """Result dict must include 'stdout' key."""
        func = _find_function(server_ast, "_tool_execute_script")
        assert func is not None
        strings = _get_string_constants(func)
        assert "stdout" in strings, (
            "Result must include 'stdout' key in returned data"
        )

    def test_result_includes_stderr_key(self, server_ast):
        """Result dict must include 'stderr' key."""
        func = _find_function(server_ast, "_tool_execute_script")
        assert func is not None
        strings = _get_string_constants(func)
        assert "stderr" in strings, (
            "Result must include 'stderr' key in returned data"
        )

    def test_getvalue_called_on_captured_output(self, server_ast):
        """Must call getvalue() on StringIO to retrieve captured output."""
        func = _find_function(server_ast, "_tool_execute_script")
        assert func is not None
        names = _get_function_source_names(func)
        assert "getvalue" in names, (
            "Must call getvalue() on StringIO to retrieve captured output"
        )


class TestStdoutOnErrorPath:
    """Captured output must also be available on the exception path."""

    def test_getvalue_called_in_except_block(self, server_ast):
        """getvalue() must be called inside the except block to capture output before re-raise."""
        func = _find_function(server_ast, "_tool_execute_script")
        assert func is not None
        # Find Try nodes with except handlers
        for node in ast.walk(func):
            if isinstance(node, ast.Try) and node.handlers:
                # Check that getvalue is called inside the except handler
                for handler in node.handlers:
                    handler_names = set()
                    for n in ast.walk(handler):
                        if isinstance(n, ast.Attribute):
                            handler_names.add(n.attr)
                    if "getvalue" in handler_names:
                        return  # Found it
        pytest.fail(
            "getvalue() must be called inside except block to capture output on error path"
        )

    def test_error_message_includes_stdout_on_failure(self, server_ast):
        """Error message must reference captured stdout for failed scripts."""
        func = _find_function(server_ast, "_tool_execute_script")
        assert func is not None
        # Find the except handler and check it references stdout in the error message
        for node in ast.walk(func):
            if isinstance(node, ast.Try) and node.handlers:
                for handler in node.handlers:
                    strings = _get_string_constants(handler)
                    if any("stdout" in s for s in strings):
                        return
        pytest.fail(
            "Error message in except block must include 'stdout' label"
        )
