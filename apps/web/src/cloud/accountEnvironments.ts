import {
  RelayListEnvironmentsResponse,
  RelayOkResponse,
  RelayProtectedError,
} from "@t3tools/contracts/relay";
import type { EnvironmentId } from "@t3tools/contracts";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import { decodeRelayJwt } from "@t3tools/shared/relayJwt";
import { Schema, Option } from "effect";

const decodeRelayError = Schema.decodeUnknownOption(RelayProtectedError);
const decodeEnvironmentList = Schema.decodeUnknownOption(RelayListEnvironmentsResponse);
const decodeDeregistration = Schema.decodeUnknownOption(RelayOkResponse);

export interface AccountRequest {
  readonly accountId: string;
  readonly relayUrl: string;
  readonly token: string;
  readonly signal: AbortSignal;
}

async function request(
  input: AccountRequest,
  path: string,
  method: "GET" | "DELETE",
): Promise<unknown> {
  input.signal.throwIfAborted();
  const relayUrl = normalizeSecureRelayUrl(input.relayUrl);
  if (!relayUrl) throw new Error("T3 Connect requires a secure relay URL.");
  let subject: string | undefined;
  try {
    subject = decodeRelayJwt(input.token).sub;
  } catch {
    throw new Error("T3 Connect sign-in is invalid. Sign in again.");
  }
  if (subject !== input.accountId)
    throw new Error("The T3 Connect account changed. Refresh and confirm the action again.");
  const response = await fetch(new URL(path, `${relayUrl}/`), {
    method,
    headers: { authorization: `Bearer ${input.token}` },
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]),
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const relayError = decodeRelayError(body);
    throw new Error(
      Option.isSome(relayError)
        ? `${relayError.value.message} (Trace ID: ${relayError.value.traceId})`
        : `T3 Connect request failed (${response.status}). Retry or sign in again.`,
    );
  }
  return response.json();
}

export async function listAccountEnvironments(input: AccountRequest) {
  const decoded = decodeEnvironmentList(await request(input, "/v1/environments", "GET"));
  if (Option.isNone(decoded))
    throw new Error(
      "The relay returned an incompatible environment list. Update the app or contact the relay operator.",
    );
  return decoded.value.environments;
}

export async function deregisterAccountEnvironment(
  input: AccountRequest & { readonly environmentId: EnvironmentId },
) {
  const result = decodeDeregistration(
    await request(
      input,
      `/v1/client/environment-links/${encodeURIComponent(input.environmentId)}`,
      "DELETE",
    ),
  );
  if (Option.isNone(result) || !result.value.ok)
    throw new Error(
      "The relay did not confirm deregistration. Refresh the account list before retrying.",
    );
}
