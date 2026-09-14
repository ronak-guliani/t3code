import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";

const resolveDeviceHubAccess = vi.fn(async (_hubBasePath: string) => {
  const ticket = `ticket-${resolveDeviceHubAccess.mock.calls.length}`;
  return {
    httpBase: "http://test/api/device-hub",
    wsBase: "ws://test/api/device-hub",
    query: { hostId: "local" },
    credentials: false,
    tickets: { video: ticket, input: ticket, prime: ticket, mjpeg: ticket },
  };
});

vi.mock("~/environments/runtime", () => ({
  readEnvironmentConnection: () => ({ resolveDeviceHubAccess }),
}));

import { useDeviceHubAccess } from "./device";

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  resolveDeviceHubAccess.mockClear();
});

it("mints fresh stream tickets after a hidden device tab is reactivated", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const observed: string[] = [];
  const Probe = ({ visible }: { readonly visible: boolean }) => {
    const { access } = useDeviceHubAccess(
      EnvironmentId.make("test"),
      "local",
      visible,
      "/custom-device-proxy",
    );
    const ticket = access?.tickets?.video;
    if (ticket && observed.at(-1) !== ticket) observed.push(ticket);
    return null;
  };

  await act(async () => {
    renderer = create(<Probe visible />);
  });
  await act(async () => renderer!.update(<Probe visible={false} />));
  await act(async () => renderer!.update(<Probe visible />));

  expect(resolveDeviceHubAccess).toHaveBeenCalledTimes(2);
  expect(resolveDeviceHubAccess).toHaveBeenNthCalledWith(1, "/custom-device-proxy", "local");
  expect(observed).toEqual(["ticket-1", "ticket-2"]);
});
