import type { LocalEnvironment } from "@t3tools/shared/localEnvironment";

export function assertDesktopCanOwnEnvironment(environment: LocalEnvironment | null): void {
  if (!environment || environment.status === "offline") return;
  if (environment.status === "unavailable") {
    throw new Error(environment.error ?? "Cannot safely start the selected environment.");
  }
  // A public descriptor and a live PID do not authenticate a listener. Never load
  // another process's HTML into the renderer that holds the desktop bridge.
  throw new Error(
    "The selected environment is already running. Automatic desktop attachment is disabled because the listener cannot be authenticated. Stop that server before letting desktop start it, or launch desktop with a separate T3CODE_HOME and add the running environment through Settings > Connections. No pairing credential was issued and the existing server was not stopped.",
  );
}
