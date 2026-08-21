import { type DpopVerificationResult, verifyDpopProof } from "@t3tools/shared/dpop";

const DPOP_PROOF_MAX_AGE_SECONDS = 300;
const MAX_CONSUMED_DPOP_PROOFS = 10_000;

const consumedProofs = new Map<string, number>();

function pruneConsumedProofs(nowEpochSeconds: number): void {
  for (const [key, expiresAt] of consumedProofs) {
    if (expiresAt < nowEpochSeconds) {
      consumedProofs.delete(key);
    }
  }
}

export function verifyAndConsumeDpopProof(
  input: Omit<Parameters<typeof verifyDpopProof>[0], "maxAgeSeconds">,
): DpopVerificationResult {
  const verification = verifyDpopProof({
    ...input,
    maxAgeSeconds: DPOP_PROOF_MAX_AGE_SECONDS,
  });
  if (!verification.ok) return verification;

  pruneConsumedProofs(input.nowEpochSeconds);
  const replayKey = `${verification.thumbprint.length}:${verification.thumbprint}${verification.jti}`;
  if (consumedProofs.has(replayKey)) {
    return { ok: false, reason: "DPoP proof has already been used." };
  }
  if (consumedProofs.size >= MAX_CONSUMED_DPOP_PROOFS) {
    return { ok: false, reason: "DPoP replay guard capacity exceeded." };
  }

  consumedProofs.set(replayKey, verification.iat + DPOP_PROOF_MAX_AGE_SECONDS);
  return verification;
}
