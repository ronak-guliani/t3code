import { Duration, Effect } from "effect";
import { RpcClientError, RpcClientDefect } from "effect/unstable/rpc/RpcClientError";

export function withRpcDeadlines<Client extends object>(
  client: Client,
  timeout: Duration.Input = "30 seconds",
): Client {
  const methods = new Map<PropertyKey, unknown>();
  return new Proxy(client, {
    get(target, key, receiver) {
      const member: unknown = Reflect.get(target, key, receiver);
      if (typeof member !== "function") return member;
      if (methods.has(key)) return methods.get(key);
      const call = (...args: unknown[]) => {
        const result: unknown = Reflect.apply(member, target, args);
        // Streaming RPCs own their lifetime; only unary responses have a deadline.
        return Effect.isEffect(result)
          ? result.pipe(
              Effect.timeoutOrElse({
                duration: timeout,
                orElse: () =>
                  new RpcClientError({
                    reason: new RpcClientDefect({
                      message:
                        `CLI_RPC_TIMEOUT: RPC '${String(key)}' did not respond within ${Duration.toSeconds(Duration.fromInputUnsafe(timeout))}s. ` +
                        "The outcome is unknown; inspect state before retrying a mutation.",
                      cause: "CLI_RPC_TIMEOUT",
                    }),
                  }),
              }),
            )
          : result;
      };
      methods.set(key, call);
      return call;
    },
  });
}
