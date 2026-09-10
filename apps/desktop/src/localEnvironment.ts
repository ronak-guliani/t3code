import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Schema } from "effect";
import { inspectLocalEnvironment, type LocalEnvironment } from "@t3tools/shared/localEnvironment";
import { verifyLocalEnvironmentOwnership } from "./localEnvironmentOwnership.ts";

const Pairing = Schema.Struct({ credential: Schema.String });
const decodePairing = Schema.decodeUnknownSync(Schema.fromJsonString(Pairing));

export async function prepareLocalAttachment(input: {
  environment: LocalEnvironment;
  cliEntry: string;
  appVersion: string;
}): Promise<{ origin: string; credential: string }> {
  const current = await inspectLocalEnvironment(input.environment.baseDir);
  if (
    !current ||
    current.status !== "online" ||
    !current.origin ||
    current.environmentId !== input.environment.environmentId
  ) {
    throw new Error(
      "The selected local environment changed or is no longer reachable. No other environment was started.",
    );
  }
  if (current.serverVersion !== input.appVersion) {
    throw new Error(
      "The local server and desktop versions differ. Update them to the same version, or use explicit remote pairing.",
    );
  }
  await verifyLocalEnvironmentOwnership(current.baseDir);
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      input.cliEntry,
      "auth",
      "pairing",
      "create",
      "--base-dir",
      current.baseDir,
      "--ttl",
      "2 minutes",
      "--label",
      "Local desktop",
      "--json",
    ],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    },
  ).catch(() => {
    // execFile errors contain stdout (and potentially a credential).
    throw new Error(
      "Could not authorize the local desktop. Check CLI compatibility and data-directory permissions.",
    );
  });
  let pairing: typeof Pairing.Type;
  try {
    pairing = decodePairing(stdout);
  } catch {
    throw new Error("The bundled CLI returned an invalid pairing response.");
  }
  const verified = await inspectLocalEnvironment(current.baseDir);
  if (
    verified?.status !== "online" ||
    verified.environmentId !== current.environmentId ||
    verified.pid !== current.pid ||
    verified.startedAt !== current.startedAt ||
    verified.origin !== current.origin
  ) {
    throw new Error("The local server changed during authorization. Restart the desktop to retry.");
  }
  return { origin: current.origin, credential: pairing.credential };
}
