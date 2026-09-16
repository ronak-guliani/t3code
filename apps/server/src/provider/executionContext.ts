import type { ProviderSendTurnInput } from "@t3tools/contracts";

export function t3ExecutionContext(
  input: Pick<ProviderSendTurnInput, "delegationAssignmentId" | "delegationDispatchId">,
  originTurnId?: string,
): string | null {
  if (!input.delegationAssignmentId || !input.delegationDispatchId) return null;
  const originInstruction = originTurnId
    ? `originTurnId="${originTurnId}" exactly, `
    : "the current provider turn ID as originTurnId, ";
  return `T3 execution context: when calling report_to_parent during this turn, pass ${originInstruction}dispatchId="${input.delegationDispatchId}" exactly, and assignmentId="${input.delegationAssignmentId}" exactly. These values identify this execution and must not be replaced with values from a later turn.`;
}

export function appendT3ExecutionContext(
  text: string | undefined,
  input: Pick<ProviderSendTurnInput, "delegationAssignmentId" | "delegationDispatchId">,
  originTurnId?: string,
): string | undefined {
  const context = t3ExecutionContext(input, originTurnId);
  const trimmed = text?.trim();
  if (!context) return trimmed || undefined;
  return trimmed ? `${trimmed}\n\n${context}` : context;
}
