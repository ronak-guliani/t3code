import { Layer } from "effect";
import { RpcSerialization } from "effect/unstable/rpc";

type JsonObject = Record<string, unknown>;

const asJsonObject = (value: unknown): JsonObject | undefined =>
  typeof value === "object" && value !== null ? (value as JsonObject) : undefined;

export const crossVersionRpcSerializationLayer = Layer.succeed(
  RpcSerialization.RpcSerialization,
  RpcSerialization.RpcSerialization.of({
    ...RpcSerialization.json,
    makeUnsafe: () => {
      const parser = RpcSerialization.json.makeUnsafe();
      const wireRequestIds = new Map<string, string | number>();

      return {
        decode: (data: Uint8Array | string): ReadonlyArray<unknown> =>
          parser.decode(data).map((message) => {
            const record = asJsonObject(message);
            if (record === undefined) return message;

            if (record._tag === "Request") {
              const id = record.id;
              if (typeof id === "string") {
                wireRequestIds.set(id, id);
              } else if (typeof id === "number" && Number.isSafeInteger(id) && id >= 0) {
                const normalizedId = String(id);
                wireRequestIds.set(normalizedId, id);
                return { ...record, id: normalizedId };
              }
              return message;
            }

            if (
              (record._tag === "Ack" || record._tag === "Interrupt") &&
              typeof record.requestId === "number" &&
              Number.isSafeInteger(record.requestId) &&
              record.requestId >= 0
            ) {
              return { ...record, requestId: String(record.requestId) };
            }

            return message;
          }),
        encode: (message: unknown): Uint8Array | string | undefined => {
          const record = asJsonObject(message);
          const requestId =
            record !== undefined && typeof record.requestId === "string"
              ? record.requestId
              : undefined;
          const wireRequestId = requestId === undefined ? undefined : wireRequestIds.get(requestId);
          const encoded = parser.encode(
            record === undefined || wireRequestId === undefined
              ? message
              : { ...record, requestId: wireRequestId },
          );

          if (record?._tag === "Exit" && requestId !== undefined) {
            wireRequestIds.delete(requestId);
          }
          return encoded;
        },
      };
    },
  }),
);
