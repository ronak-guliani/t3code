import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

/** Absolute path to the helper shipped with this desktop instance. */
export const LinuxBrowserSecretPath = Context.Reference<string | undefined>(
  "@t3tools/desktop/preview/BrowserImport/LinuxBrowserSecretPath",
  { defaultValue: () => undefined },
);

export const layer = Layer.effect(
  LinuxBrowserSecretPath,
  Effect.gen(function* () {
    if (process.platform !== "linux") return undefined;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const relative = path.join("browser-secret", "t3-browser-secret");
    const candidates = [
      path.join(process.resourcesPath ?? "", relative),
      path.join(
        process.cwd(),
        "native",
        "browser-secret",
        "build",
        process.arch,
        "t3-browser-secret",
      ),
    ];
    for (const candidate of candidates) {
      if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false)))
        return candidate;
    }
    return undefined;
  }),
);
