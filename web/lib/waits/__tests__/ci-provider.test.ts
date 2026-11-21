import { expect, it } from "vitest";

import { readProviderCi } from "../ci-provider";
import { evaluateCiObservation } from "../ci-evidence";
import { waitConditionSchema } from "../manifest";

const sha = "1".repeat(40);
const target = {
  headSha: sha,
  ref: "refs/heads/run/1",
  issuer: "github-actions",
  checks: ["build"],
};

it("B02 reads GitHub check and status pages and retains the current pending check", async () => {
  const paths: string[] = [];
  const request: typeof fetch = async (input) => {
    const url = new URL(String(input));

    paths.push(url.pathname + url.search);
    if (url.pathname.endsWith("/statuses")) return Response.json([]);
    const first = url.searchParams.get("page") === "1";

    return Response.json(
      {
        check_runs: [
          {
            id: first ? 1 : 2,
            name: "build",
            head_sha: sha,
            status: first ? "completed" : "queued",
            conclusion: first ? "success" : null,
            app: { slug: "github-actions" },
          },
        ],
      },
      {
        headers: first
          ? { link: '<https://opaque.example/api>; rel="next"' }
          : {},
      },
    );
  };
  const observation = await readProviderCi(
    {
      provider: "github",
      apiBase: "https://api.github.com",
      repository: "org/repo",
      headSha: sha,
      ref: target.ref,
    },
    request,
  );

  expect(observation.complete).toBe(true);
  expect(paths).toHaveLength(3);
  expect(paths.every((path) => path.includes(sha))).toBe(true);
  expect(evaluateCiObservation(target, observation)).toBeNull();
});

it.each([
  [
    "gitlab",
    "https://gitlab.example.test/api/v4",
    [
      {
        id: 2,
        name: "Build pipeline",
        sha,
        ref: "run/1",
        source: "push",
        status: "success",
      },
    ],
    "push",
  ],
  [
    "gitea",
    "https://gitea.example.test/api/v1",
    [
      {
        id: 2,
        context: "build / integration",
        status: "success",
        creator: { login: "robot" },
      },
    ],
    "robot",
  ],
] as const)(
  "B02 scopes %s to its exact revision and authenticated issuer",
  async (provider, apiBase, response, issuer) => {
    const label =
      "name" in response[0] ? response[0].name : response[0].context;
    const condition = waitConditionSchema.parse({
      kind: "ci",
      transport: "pull",
      publication: "publish",
      issuer,
      checks: [label],
    });

    if (condition.kind !== "ci") throw new Error("Expected CI condition");
    const observation = await readProviderCi(
      {
        provider,
        apiBase,
        repository: "org/repo",
        headSha: sha,
        ref: target.ref,
      },
      async () => Response.json(response),
    );

    expect(
      evaluateCiObservation(
        { ...target, issuer, checks: condition.checks },
        observation,
      ),
    ).toMatchObject({ outcome: "success" });
  },
);
