import React, { useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { existsSync, readFileSync } from "node:fs";

export type PlanApprovalAction =
  | { action: "approve_execute" }
  | { action: "approve_only" }
  | { action: "reject"; feedback: string }
  | { action: "abandon" };

interface PlanApprovalMenuProps {
  planFilePath: string;
  onAction?: (action: PlanApprovalAction) => void;
}

const AFFIRMATIVE = new Set([
  "yes",
  "y",
  "go",
  "/go",
  "ok",
  "okay",
  "approved",
  "approve",
]);

export function PlanApprovalMenu({
  planFilePath,
  onAction,
}: PlanApprovalMenuProps) {
  const [mode, setMode] = useState<"root" | "reject_feedback">("root");
  const [rootInput, setRootInput] = useState("");
  const [feedbackInput, setFeedbackInput] = useState("");
  const modeRef = useRef<"root" | "reject_feedback">("root");
  const rootInputRef = useRef("");
  const feedbackInputRef = useRef("");

  const planPreview = useMemo(() => {
    if (!existsSync(planFilePath)) return "";
    try {
      return readFileSync(planFilePath, "utf-8").trim();
    } catch {
      return "";
    }
  }, [planFilePath]);

  useInput(
    (input, key) => {
      if (!onAction) return;

      if (modeRef.current === "reject_feedback") {
        if (key.return) {
          onAction({
            action: "reject",
            feedback: feedbackInputRef.current.trim(),
          });
          modeRef.current = "root";
          setMode("root");
          feedbackInputRef.current = "";
          setFeedbackInput("");
          return;
        }
        if (key.backspace || key.delete) {
          feedbackInputRef.current = feedbackInputRef.current.slice(0, -1);
          setFeedbackInput(feedbackInputRef.current);
          return;
        }
        if (!key.ctrl && !key.meta && input) {
          feedbackInputRef.current += input;
          setFeedbackInput(feedbackInputRef.current);
        }
        return;
      }

      if (input === "1") {
        onAction({ action: "approve_execute" });
        return;
      }
      if (input === "2") {
        onAction({ action: "approve_only" });
        return;
      }
      if (input === "3") {
        modeRef.current = "reject_feedback";
        setMode("reject_feedback");
        return;
      }
      if (input === "4") {
        onAction({ action: "abandon" });
        return;
      }
      if (key.return) {
        const trimmed = rootInputRef.current.trim();
        if (trimmed.length === 0 || AFFIRMATIVE.has(trimmed.toLowerCase())) {
          onAction({ action: "approve_execute" });
        } else {
          onAction({ action: "reject", feedback: rootInputRef.current });
        }
        rootInputRef.current = "";
        setRootInput("");
        return;
      }
      if (key.backspace || key.delete) {
        rootInputRef.current = rootInputRef.current.slice(0, -1);
        setRootInput(rootInputRef.current);
        return;
      }
      if (!key.ctrl && !key.meta && input) {
        rootInputRef.current += input;
        setRootInput(rootInputRef.current);
      }
    },
    { isActive: !!onAction },
  );

  return (
    <Box flexDirection="column" marginY={0} paddingLeft={2}>
      <Text>{`Plan ready for approval\nPlan file: ${planFilePath}`}</Text>
      {planPreview ? <Text>{planPreview}</Text> : null}
      <Text> </Text>
      <Text>{`  1  Approve & execute`}</Text>
      <Text>{`  2  Approve draft-only`}</Text>
      <Text>{`  3  Reject with feedback`}</Text>
      <Text>{`  4  Abandon`}</Text>
      <Text> </Text>
      {mode === "reject_feedback" ? (
        <Text>{`Feedback: ${feedbackInput}`}</Text>
      ) : (
        <Text>{`Reply, press Enter, or choose 1-4: ${rootInput}`}</Text>
      )}
    </Box>
  );
}
