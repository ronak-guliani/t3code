import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Deferred, Effect, Fiber, FileSystem, Layer, Option } from "effect";
import { CheckoutCoordinator, CheckoutCoordinatorLive } from "./CheckoutCoordinator.ts";
import { runProcess } from "../processRunner.ts";

const TestLayer = CheckoutCoordinatorLive.pipe(Layer.provideMerge(NodeServices.layer));

it.effect("shares aliases, skips busy automatic work, and leaves other worktrees independent", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "checkout-coordinator-" });
    yield* fs.makeDirectory(`${root}/checkout`);
    yield* Effect.promise(() => runProcess("git", ["init", `${root}/checkout`]));
    yield* fs.makeDirectory(`${root}/checkout/nested`);
    yield* fs.symlink(`${root}/checkout`, `${root}/alias`);
    const coordinator = yield* CheckoutCoordinator;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const holder = yield* coordinator
      .withCheckout(
        `${root}/checkout`,
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      )
      .pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    assert.isTrue(Option.isNone(yield* coordinator.tryWithCheckout(`${root}/alias`, Effect.void)));
    assert.isTrue(
      Option.isNone(yield* coordinator.tryWithCheckout(`${root}/checkout/nested`, Effect.void)),
    );
    assert.isTrue(Option.isSome(yield* coordinator.tryWithCheckout(`${root}/other`, Effect.void)));
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holder);
    assert.isTrue(Option.isSome(yield* coordinator.tryWithCheckout(`${root}/alias`, Effect.void)));
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("releases interrupted holders and cancelled waiters without losing the reservation", () =>
  Effect.gen(function* () {
    const coordinator = yield* CheckoutCoordinator;
    const entered = yield* Deferred.make<void>();
    const holder = yield* coordinator
      .withCheckout(
        process.cwd(),
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      )
      .pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    const waiter = yield* coordinator
      .withCheckout(process.cwd(), Effect.never)
      .pipe(Effect.forkScoped);
    yield* Fiber.interrupt(waiter);
    assert.isTrue(Option.isNone(yield* coordinator.tryWithCheckout(process.cwd(), Effect.void)));
    yield* Fiber.interrupt(holder);
    assert.isTrue(Option.isSome(yield* coordinator.tryWithCheckout(process.cwd(), Effect.void)));
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("keeps overlapping finalizations excluded without holding the operation mutex", () =>
  Effect.gen(function* () {
    const coordinator = yield* CheckoutCoordinator;
    yield* coordinator.beginFinalization("first", process.cwd());
    yield* coordinator.beginFinalization("second", process.cwd());
    assert.isTrue(yield* coordinator.isFinalizing(process.cwd()));
    assert.isTrue(Option.isSome(yield* coordinator.tryWithCheckout(process.cwd(), Effect.void)));
    yield* coordinator.endFinalization("first");
    assert.isTrue(yield* coordinator.isFinalizing(process.cwd()));
    yield* coordinator.endFinalization("second");
    assert.isFalse(yield* coordinator.isFinalizing(process.cwd()));
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("does not carry process-local exclusions into a rebuilt runtime", () =>
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const coordinator = yield* CheckoutCoordinator;
      yield* coordinator.beginFinalization("orphaned-completion", process.cwd());
    }).pipe(Effect.provide(CheckoutCoordinatorLive));
    yield* Effect.gen(function* () {
      const coordinator = yield* CheckoutCoordinator;
      assert.isFalse(yield* coordinator.isFinalizing(process.cwd()));
      assert.isTrue(Option.isSome(yield* coordinator.tryWithCheckout(process.cwd(), Effect.void)));
    }).pipe(Effect.provide(CheckoutCoordinatorLive));
  }),
);
