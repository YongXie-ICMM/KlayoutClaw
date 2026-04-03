#!/usr/bin/env python3
"""LLM Judge — calls gpt-5-mini via api.physcai.com to evaluate test assertions."""

import json
import os
import urllib.request
import urllib.error
from dataclasses import dataclass

API_BASE = os.environ.get("LLM_JUDGE_API_BASE", "http://api.physcai.com")
API_KEY = os.environ.get("LLM_JUDGE_API_KEY", "sk-R3ZLYerVohnBrAqYEf6f30B5C447414c90B6936b67A42dBb")
MODEL = os.environ.get("LLM_JUDGE_MODEL", "gpt-5-mini")

SYSTEM_PROMPT = """\
You are a strict but fair test judge for an automated E2E test harness.
You will receive:
  1. The output of a CLI command (may be JSON, text, or error output)
  2. A natural-language assertion describing what the output should satisfy
  3. Optional context about the command that produced the output

Your job: determine if the output satisfies the assertion.
Return ONLY valid JSON (no markdown fences, no extra text):
{
  "passed": true/false,
  "reasoning": "brief explanation of your verdict",
  "confidence": 0.0-1.0
}

Rules:
- Be strict: partial matches or near-misses should fail
- Be fair: minor formatting differences are OK if the substance matches
- If the output is an error or empty, the assertion almost certainly fails
- Confidence should reflect how certain you are (0.9+ for clear cases)
"""


@dataclass
class JudgeVerdict:
    passed: bool
    reasoning: str
    confidence: float


def judge(response_text: str, assertion: str, context: str = "") -> JudgeVerdict:
    """Send output + assertion to the LLM judge and return a structured verdict."""
    user_content = f"## Output\n{response_text}\n\n## Assertion\n{assertion}"
    if context:
        user_content += f"\n\n## Context\n{context}"

    payload = json.dumps({
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ],
        "max_completion_tokens": 2048,
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{API_BASE}/v1/chat/completions",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {API_KEY}",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.URLError as e:
        return JudgeVerdict(
            passed=False,
            reasoning=f"Judge API call failed: {e}",
            confidence=0.0,
        )
    except Exception as e:
        return JudgeVerdict(
            passed=False,
            reasoning=f"Unexpected error calling judge: {e}",
            confidence=0.0,
        )

    # Parse LLM response
    raw = body["choices"][0]["message"]["content"].strip()
    # Strip markdown code fences if present
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
        if raw.endswith("```"):
            raw = raw[:-3]
        raw = raw.strip()

    try:
        verdict = json.loads(raw)
        return JudgeVerdict(
            passed=bool(verdict.get("passed", False)),
            reasoning=str(verdict.get("reasoning", "No reasoning provided")),
            confidence=float(verdict.get("confidence", 0.0)),
        )
    except (json.JSONDecodeError, KeyError, TypeError) as e:
        return JudgeVerdict(
            passed=False,
            reasoning=f"Failed to parse judge response: {e}\nRaw: {raw[:500]}",
            confidence=0.0,
        )


if __name__ == "__main__":
    # Quick smoke test of the judge itself
    v = judge(
        '{"papers": [{"title": "Quantum Error Correction", "arxiv_id": "2301.01234"}]}',
        "returns 1 or more papers, each with a title and arxiv_id",
        context="Command: search 'quantum error correction' --max-results 5",
    )
    print(f"Passed: {v.passed}")
    print(f"Confidence: {v.confidence:.2f}")
    print(f"Reasoning: {v.reasoning}")
