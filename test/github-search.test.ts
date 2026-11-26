// Issue search finds items by id, then reads them in batches: full cards for
// 50 busy pull requests in one request take GitHub past its time limit.

import type { Request } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { searchGitHub } from "../src/server/forges/github-search.ts";
import { gate } from "../src/server/forges/rateLimit.ts";
import { FakeGitHub, type FakeUser } from "./fake-github.ts";

const ALICE: FakeUser = { id: 501, login: "alice", name: "Alice", avatar_url: "" };

describe("searching GitHub's issues", () => {
	let github: FakeGitHub;
	let token: string;

	beforeEach(() => {
		github = new FakeGitHub();
		github.addRepo(1, "acme/widgets", { collaborators: ["alice"] });
		for (let n = 1; n <= 45; n++) {
			github.setItem(1, {
				number: n,
				kind: n % 2 ? "issue" : "pull",
				title: `Item ${n}`,
				updatedAt: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(),
			});
		}
		token = github.userTokenFor(ALICE);
		vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
			github.fetch(new globalThis.Request(input, init) as unknown as Request),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		gate.clear();
	});

	it("reads what it found in batches, in the search's order", async () => {
		const found = await searchGitHub(
			{ kind: "search", host: "github.com", q: "repo:acme/widgets" },
			{} as Env,
			{ token },
		);
		if (found.kind !== "search") throw new Error(JSON.stringify(found));
		expect(found.items.map((card) => card.item)).toEqual(
			Array.from({ length: 45 }, (_, i) => `#${45 - i}`),
		);
		expect(found.items.every((card) => card.visibility === "public")).toBe(true);
		const reads = github.requests.filter((r) => r.operation === "TackSearchItems");
		expect(reads.map((r) => (r.variables?.ids as string[] | undefined)?.length)).toEqual([
			20, 20, 5,
		]);
	});

	it("says so when GitHub gives up on a read", async () => {
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new globalThis.Request(input, init);
			const body = (await request.clone().json()) as { operationName?: string };
			if (body.operationName === "TackSearchItems") return new Response("", { status: 504 });
			return github.fetch(request as unknown as Request);
		});
		expect(
			await searchGitHub(
				{ kind: "search", host: "github.com", q: "repo:acme/widgets" },
				{} as Env,
				{
					token,
				},
			),
		).toMatchObject({ kind: "error", reason: "error", message: "GitHub answered 504." });
	});
});
