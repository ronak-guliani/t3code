import { shallow } from "zustand/shallow";

export function reuseShallowEqualSettingsSelection<T>(previous: { value: T } | null, next: T): T {
  return previous && shallow(previous.value, next) ? previous.value : next;
}
