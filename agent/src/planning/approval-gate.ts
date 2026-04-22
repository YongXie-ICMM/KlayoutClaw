import type { PlanApprovalAction } from "../tui/components/PlanApprovalMenu.js";

interface PendingApproval {
  promise: Promise<PlanApprovalAction>;
  resolve: (action: PlanApprovalAction) => void;
  reject: (error: Error) => void;
}

const pendingApprovals = new WeakMap<object, PendingApproval>();

export function waitForPlanApproval(session: object): Promise<PlanApprovalAction> {
  const existing = pendingApprovals.get(session);
  if (existing) return existing.promise;

  let resolveApproval!: (action: PlanApprovalAction) => void;
  let rejectApproval!: (error: Error) => void;
  const promise = new Promise<PlanApprovalAction>((resolve, reject) => {
    resolveApproval = resolve;
    rejectApproval = reject;
  });

  pendingApprovals.set(session, {
    promise,
    resolve: (action) => {
      pendingApprovals.delete(session);
      resolveApproval(action);
    },
    reject: (error) => {
      pendingApprovals.delete(session);
      rejectApproval(error);
    },
  });

  return promise;
}

export function resolvePlanApproval(
  session: object,
  action: PlanApprovalAction,
): void {
  pendingApprovals.get(session)?.resolve(action);
}

export function rejectPlanApproval(
  session: object,
  reason: string,
): void {
  pendingApprovals.get(session)?.reject(new Error(reason));
}
