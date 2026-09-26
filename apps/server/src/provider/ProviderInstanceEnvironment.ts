import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import { delimiter } from "node:path";

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!environment || environment.length === 0) {
    return baseEnv;
  }

  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment) {
    next[variable.name] = variable.value;
  }
  if (baseEnv.T3CODE_AGENT_CLI_DIR) {
    next.PATH = [baseEnv.T3CODE_AGENT_CLI_DIR, next.PATH].filter(Boolean).join(delimiter);
    next.T3CODE_AGENT_CLI_DIR = baseEnv.T3CODE_AGENT_CLI_DIR;
    next.T3CODE_HOME = baseEnv.T3CODE_HOME;
  }
  return next;
}
