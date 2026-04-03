#!/usr/bin/env python3
"""Shared utilities and stateful context for agentic E2E tests."""

import json
import time
from dataclasses import dataclass, field
from typing import Any, Optional


class TestState:
    """Shared mutable state that flows between tests."""

    def __init__(self):
        self._store: dict[str, Any] = {}

    def set(self, key: str, value: Any):
        self._store[key] = value

    def get(self, key: str, default: Any = None) -> Any:
        return self._store.get(key, default)

    def has(self, key: str) -> bool:
        return key in self._store

    def dump(self) -> dict:
        return dict(self._store)


# ---------------------------------------------------------------------------
# Agentic test case and result
# ---------------------------------------------------------------------------

@dataclass
class AgenticTestCase:
    """A single agentic E2E test — gives a natural-language task to the agent."""
    id: str                    # e.g. "T0.1"
    group: str                 # e.g. "recon"
    name: str                  # Human-readable name
    task_prompt: str           # Natural-language task for the agent
    assertion: str             # What the LLM judge should check
    verify_fn: str             # Function name in verifier.py
    verify_args: dict = field(default_factory=dict)
    depends_on: list[str] = field(default_factory=list)
    timeout: int = 120         # Agent timeout in seconds
    max_transcript_chars: int = 4000
    reset_layout: bool = False


@dataclass
class AgenticTestResult:
    """Result of running a single agentic test."""
    test_id: str
    test_name: str
    group: str
    passed: bool
    confidence: float
    reasoning: str
    duration: float
    transcript_excerpt: str = ""
    verification_passed: bool = False
    verification_summary: str = ""
    skipped: bool = False
    skip_reason: str = ""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def truncate(text: str, max_chars: int) -> str:
    """Truncate text to max_chars, appending indicator if truncated."""
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + f"\n... [truncated, {len(text)} total chars]"


def format_results(results: list[AgenticTestResult]) -> str:
    """Pretty-print agentic test results."""
    lines = []
    lines.append("")
    lines.append("=" * 72)
    lines.append("  Agentic E2E Test Results")
    lines.append("=" * 72)

    passed = sum(1 for r in results if r.passed and not r.skipped)
    failed = sum(1 for r in results if not r.passed and not r.skipped)
    skipped = sum(1 for r in results if r.skipped)

    groups: dict[str, list[AgenticTestResult]] = {}
    for r in results:
        groups.setdefault(r.group, []).append(r)

    for group_name, group_results in groups.items():
        lines.append(f"\n  Group: {group_name}")
        lines.append("  " + "-" * 40)
        for r in group_results:
            if r.skipped:
                icon = "SKIP"
                detail = r.skip_reason
            elif r.passed:
                icon = "PASS"
                detail = f"conf={r.confidence:.2f} | verify={'OK' if r.verification_passed else 'FAIL'}"
            else:
                icon = "FAIL"
                detail = r.reasoning[:60]
            lines.append(f"  [{icon}] {r.test_id} {r.test_name}")
            lines.append(f"         {detail}")
            if not r.skipped:
                lines.append(f"         ({r.duration:.1f}s)")

    lines.append("")
    lines.append("=" * 72)
    lines.append(f"  Total: {passed} passed, {failed} failed, {skipped} skipped")
    lines.append("=" * 72)
    lines.append("")

    return "\n".join(lines)


def results_to_json(results: list[AgenticTestResult]) -> str:
    """Serialize results to JSON."""
    return json.dumps(
        [
            {
                "test_id": r.test_id,
                "test_name": r.test_name,
                "group": r.group,
                "passed": r.passed,
                "confidence": r.confidence,
                "reasoning": r.reasoning,
                "duration": r.duration,
                "verification_passed": r.verification_passed,
                "verification_summary": r.verification_summary,
                "skipped": r.skipped,
                "skip_reason": r.skip_reason,
            }
            for r in results
        ],
        indent=2,
    )
