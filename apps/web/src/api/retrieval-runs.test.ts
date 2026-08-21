import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "./client";

describe("retrieval run developer API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses developer-only list, detail, and replay GET endpoints", async () => {
    const requestedUrls: string[] = [];
    const requestedMethods: Array<string | undefined> = [];
    const fetchMock = vi.fn(
      (input: string, init?: RequestInit): Promise<Response> => {
        requestedUrls.push(input);
        requestedMethods.push(init?.method);
        const payload = input.endsWith("/replay")
          ? {
              runId: "run/one",
              input: {},
              result: {},
              matchesRecordedResult: true,
            }
          : input.includes("?limit=")
            ? { runs: [] }
            : { run: { id: "run/one" } };
        return Promise.resolve(
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      api.developer.retrievalRuns("agent / one", 25),
    ).resolves.toEqual({ runs: [] });
    await expect(api.developer.retrievalRun("run/one")).resolves.toMatchObject({
      run: { id: "run/one" },
    });
    await expect(
      api.developer.replayRetrievalRun("run/one"),
    ).resolves.toMatchObject({
      runId: "run/one",
      matchesRecordedResult: true,
    });

    expect(requestedUrls).toEqual([
      "/api/developer/agents/agent%20%2F%20one/retrieval-runs?limit=25",
      "/api/developer/retrieval-runs/run%2Fone",
      "/api/developer/retrieval-runs/run%2Fone/replay",
    ]);
    expect(requestedMethods).toEqual([undefined, undefined, undefined]);
  });
});
