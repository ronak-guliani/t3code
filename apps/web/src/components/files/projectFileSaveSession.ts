import type { EnvironmentId } from "@t3tools/contracts";

import { ensureEnvironmentApi } from "~/environmentApi";

import { FileSaveCoordinator } from "./fileSaveCoordinator";
import { confirmProjectFileQueryData, setProjectFileQueryData } from "./projectFilesQueryState";

interface SaveState {
  readonly pending: boolean;
  readonly error: string | null;
}

const sessions = new Map<string, ProjectFileSaveSession>();

class ProjectFileSaveSession {
  private state: SaveState = { pending: false, error: null };
  private readonly listeners = new Set<() => void>();
  private readonly coordinator: FileSaveCoordinator;

  constructor(
    private readonly key: string,
    private readonly environmentId: EnvironmentId,
    private readonly cwd: string,
    private readonly relativePath: string,
  ) {
    this.coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist: async (contents) => {
        await ensureEnvironmentApi(environmentId).projects.writeFile({
          cwd,
          relativePath,
          contents,
        });
      },
      onConfirmed: (contents) => {
        confirmProjectFileQueryData(environmentId, cwd, relativePath, contents);
      },
      onPendingChange: (pending) => this.update({ ...this.state, pending }),
      onError: (cause) =>
        this.update({
          ...this.state,
          error:
            cause === null ? null : cause instanceof Error ? cause.message : "Unable to save file.",
        }),
    });
  }

  getSnapshot = (): SaveState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    sessions.set(this.key, this);
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.coordinator.flush();
        this.releaseIfSettled();
      }
    };
  };

  change(contents: string): void {
    setProjectFileQueryData(this.environmentId, this.cwd, this.relativePath, contents);
    this.coordinator.change(contents);
  }

  retry = (): void => this.coordinator.retry();

  private update(state: SaveState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
    this.releaseIfSettled();
  }

  private releaseIfSettled(): void {
    if (!this.state.pending && this.listeners.size === 0 && sessions.get(this.key) === this) {
      sessions.delete(this.key);
    }
  }
}

export function getProjectFileSaveSession(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): ProjectFileSaveSession {
  const key = JSON.stringify([environmentId, cwd, relativePath]);
  const existing = sessions.get(key);
  if (existing) return existing;
  const session = new ProjectFileSaveSession(key, environmentId, cwd, relativePath);
  sessions.set(key, session);
  return session;
}
