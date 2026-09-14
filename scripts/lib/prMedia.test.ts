import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prMediaSection,
  publishPrMedia,
  replacePrMediaSection,
  verifyPrMedia,
  verifyPrMediaPublication,
  type PrMediaAsset,
  type PrMediaPublication,
} from "./prMedia.ts";

const bytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWP4DwQACfsD/c8LaHIAAAAASUVORK5CYII=",
  "base64",
);
const media: PrMediaAsset & { url: string } = {
  file: "image.png",
  contentType: "image/png",
  sizeBytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  url: "https://github.com/user-attachments/assets/test",
};
const publication: PrMediaPublication = {
  headSha: "upload-head",
  media: [media, { ...media, file: "second.png", url: `${media.url}-second` }],
  pullRequestUrl: "https://github.com/owner/repo/pull/1",
};

describe("feature capture publication without a test manifest", () => {
  const snapshot = {
    head: { sha: publication.headSha },
    body: replacePrMediaSection("Human testing notes", prMediaSection(publication)),
  };
  it("does not claim that an upload establishes feature correctness or a tested revision", () => {
    const section = prMediaSection(publication);
    expect(section).toContain("PR head at upload:");
    expect(section).toContain("uploading media is not a test result");
    expect(section).not.toContain("passed");
    expect(section).not.toContain("Tested commit");
  });
  it("updates only its managed section and preserves testing notes", () => {
    const updated = replacePrMediaSection(snapshot.body, "new captures");
    expect(updated).toContain("Human testing notes");
    expect(updated).not.toContain(media.url);
    expect(replacePrMediaSection(updated, "new captures")).toBe(updated);
    expect(() => replacePrMediaSection("Notes <!-- t3-pr-media:start -->", "new")).toThrow(
      "ambiguous",
    );
  });
  it("checks the PR before and after downloads", async () => {
    const calls: string[] = [];
    const read = vi.fn(async () => {
      calls.push("read");
      return snapshot;
    });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
      calls.push("download");
      return new Response(bytes);
    });
    await verifyPrMediaPublication(publication, read, fetchImpl);
    expect(calls).toEqual(["read", "download", "download", "read"]);
  });
  it.each([
    { changed: { ...snapshot, head: { sha: "new-head" } }, error: "PR head changed" },
    { changed: { ...snapshot, body: media.url }, error: "missing from the PR" },
  ])("rejects $error during media downloads", async ({ changed, error }) => {
    const read = vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValueOnce(changed);
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(bytes));
    await expect(verifyPrMediaPublication(publication, read, fetchImpl)).rejects.toThrow(error);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("does not download media when the initial PR head is stale", async () => {
    const read = vi.fn().mockResolvedValue({ ...snapshot, head: { sha: "new-head" } });
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(verifyPrMediaPublication(publication, read, fetchImpl)).rejects.toThrow("stale");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("restartable publication", () => {
  const initial: PrMediaPublication = {
    ...publication,
    media: publication.media.map(({ url: _url, ...asset }) => asset),
  };
  it("retains a completed upload when the next fails, then reuses it on retry", async () => {
    let receipt = initial;
    let body = "Human testing notes";
    const save = vi.fn(async (value: PrMediaPublication) => {
      receipt = value;
    });
    const readPullRequest = vi.fn(async () => ({ head: { sha: initial.headSha }, body }));
    const updateBody = vi.fn(async (value: string) => {
      body = value;
    });
    const firstUpload = vi.fn(async (_asset: PrMediaAsset, index: number) => {
      if (index === 1) throw new Error("upload unavailable");
      return media.url;
    });
    await expect(
      publishPrMedia(initial, { upload: firstUpload, save, readPullRequest, updateBody }),
    ).rejects.toThrow("upload unavailable");
    expect(receipt.media[0]!.url).toBe(media.url);
    expect(receipt.media[1]!.url).toBeUndefined();
    expect(updateBody).not.toHaveBeenCalled();

    const resumedUpload = vi.fn(async (_asset: PrMediaAsset, index: number) => {
      expect(index).toBe(1);
      return `${media.url}-second`;
    });
    await publishPrMedia(receipt, {
      upload: resumedUpload,
      save,
      readPullRequest,
      updateBody,
      fetch: vi.fn<typeof fetch>().mockImplementation(async () => new Response(bytes)),
    });
    expect(resumedUpload).toHaveBeenCalledTimes(1);
    expect(body).toContain("Human testing notes");
    expect(body).toContain(media.url);
    expect(body).toContain(`${media.url}-second`);
  });
  it("does not attach captures when the head changes during upload", async () => {
    const updateBody = vi.fn();
    await expect(
      publishPrMedia(initial, {
        upload: async () => media.url,
        save: async () => {},
        readPullRequest: async () => ({ head: { sha: "new-head" }, body: "" }),
        updateBody,
      }),
    ).rejects.toThrow("PR head changed");
    expect(updateBody).not.toHaveBeenCalled();
  });
  it("retains receipts and propagates failed byte verification after attachment", async () => {
    const save = vi.fn();
    let body = "";
    await expect(
      publishPrMedia(initial, {
        upload: async () => media.url,
        save,
        readPullRequest: async () => ({ head: { sha: initial.headSha }, body }),
        updateBody: async (value) => {
          body = value;
        },
        fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response("altered")),
      }),
    ).rejects.toThrow("differs from the supplied media");
    expect(save).toHaveBeenCalledTimes(3);
    expect(body).toContain(media.url);
  });
});

describe("uploaded byte verification", () => {
  afterEach(() => vi.useRealTimers());
  it("uses GET because signed attachment redirects reject HEAD", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes));
    await verifyPrMedia(media, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(media.url, expect.objectContaining({ method: "GET" }));
  });
  it("fails when an attachment remains unavailable", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("not found", { status: 404 }));
    const assertion = expect(verifyPrMedia(media, fetchImpl)).rejects.toThrow(
      "could not be downloaded (404)",
    );
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });
  it("retries propagation without reuploading or skipping byte verification", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(new Response(bytes));
    const verification = verifyPrMedia(media, fetchImpl);
    await vi.runAllTimersAsync();
    await verification;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("does not retry authorization failures", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 403 }));
    await expect(verifyPrMedia(media, fetchImpl)).rejects.toThrow("could not be downloaded (403)");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("rejects HTML responses and altered bytes", async () => {
    for (const body of ["<html>login</html>", "wrong"]) {
      await expect(
        verifyPrMedia(media, vi.fn<typeof fetch>().mockResolvedValue(new Response(body))),
      ).rejects.toThrow(/supplied/);
    }
  });
  it("does not fetch arbitrary receipt URLs", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      verifyPrMedia({ ...media, url: "http://localhost/private" }, fetchImpl),
    ).rejects.toThrow("GitHub attachment");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
import { createHash } from "node:crypto";
