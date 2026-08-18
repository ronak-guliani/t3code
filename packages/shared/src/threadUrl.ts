import {
  type EnvironmentId,
  type ThreadId,
  ThreadUrl,
  type ThreadUrl as ThreadUrlType,
} from "@t3tools/contracts";

export function buildThreadUrl(input: {
  readonly appOrigin: string | URL;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}): ThreadUrlType {
  const url = new URL(input.appOrigin);
  url.pathname = `/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`;
  url.search = "";
  url.hash = "";
  return ThreadUrl.make(url.toString());
}
