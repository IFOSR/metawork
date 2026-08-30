import type { Dispatcher } from "undici";
import { describe, expect, it, vi } from "vitest";
import { createPlannerWebTools } from "../src/anyfusion/planner-web-tools.ts";

describe("AnyFusion Planner Web tools", () => {
	it("fetches bounded public HTML through validated redirects", async () => {
		const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			expect(init).toMatchObject({ method: "GET", redirect: "manual" });
			if (url === "https://example.com/start") {
				return new Response(null, {
					status: 302,
					headers: { location: "/final" },
				});
			}
			return new Response(
				"<html><head><title>Live &amp; Current</title><script>secret()</script></head>" +
					"<body><h1>Hello</h1><p>Fresh public information.</p></body></html>",
				{ status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
			);
		});
		const resolveHostname = vi.fn(async () => ["93.184.216.34"]);
		const [tool] = createPlannerWebTools({ fetch, resolveHostname });

		const result = await tool!.execute(
			"fetch-1",
			{ url: "https://example.com/start" },
			undefined,
			undefined,
			{} as never,
		);
		const payload = JSON.parse(result.content[0]!.type === "text" ? result.content[0].text : "{}");

		expect(payload).toMatchObject({
			url: "https://example.com/final",
			status: 200,
			contentType: "text/html; charset=utf-8",
			truncated: false,
		});
		expect(payload.text).toContain("Live & Current");
		expect(payload.text).toContain("Fresh public information.");
		expect(payload.text).not.toContain("secret()");
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(resolveHostname).toHaveBeenCalledTimes(2);
	});

	it("rejects URLs that contain credentials", async () => {
		const [tool] = createPlannerWebTools({
			fetch: vi.fn(),
			resolveHostname: vi.fn(async () => ["93.184.216.34"]),
		});

		await expect(
			tool!.execute(
				"fetch-credentials",
				{ url: "https://user:password@example.com/private" },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("credentials");
	});

	it("rejects literal and DNS-resolved private targets", async () => {
		const [literalTool] = createPlannerWebTools({
			fetch: vi.fn(),
			resolveHostname: vi.fn(async () => ["93.184.216.34"]),
		});
		await expect(
			literalTool!.execute("fetch-loopback", { url: "http://127.0.0.1/admin" }, undefined, undefined, {} as never),
		).rejects.toThrow("public");

		const [resolvedTool] = createPlannerWebTools({
			fetch: vi.fn(),
			resolveHostname: vi.fn(async () => ["10.0.0.8"]),
		});
		await expect(
			resolvedTool!.execute(
				"fetch-private-dns",
				{ url: "https://internal.example/data" },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("public");
	});

	it("rejects a redirect whose newly resolved target is private", async () => {
		const fetch = vi.fn(
			async () =>
				new Response(null, {
					status: 302,
					headers: { location: "http://private.example/admin" },
				}),
		);
		const resolveHostname = vi.fn(async (hostname: string) =>
			hostname === "public.example" ? ["93.184.216.34"] : ["10.0.0.8"],
		);
		const [tool] = createPlannerWebTools({ fetch, resolveHostname });

		await expect(
			tool!.execute(
				"fetch-private-redirect",
				{ url: "https://public.example/start" },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("public");
		expect(fetch).toHaveBeenCalledOnce();
		expect(resolveHostname).toHaveBeenCalledTimes(2);
	});

	it("pins validated addresses to an explicit dispatcher instead of the global proxy dispatcher", async () => {
		const close = vi.fn(async () => undefined);
		const dispatcher = { close } as unknown as Dispatcher;
		const createDispatcher = vi.fn(() => dispatcher);
		const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit & { dispatcher?: Dispatcher }) => {
			expect(init?.dispatcher).toBe(dispatcher);
			return new Response("public", {
				status: 200,
				headers: { "content-type": "text/plain" },
			});
		});
		const resolveHostname = vi.fn(async () => ["93.184.216.34"]);
		const [tool] = createPlannerWebTools({ fetch, resolveHostname, createDispatcher });

		await tool!.execute("fetch-pinned", { url: "https://example.com/data" }, undefined, undefined, {} as never);

		expect(createDispatcher).toHaveBeenCalledWith("example.com", ["93.184.216.34"]);
		expect(close).toHaveBeenCalledOnce();
	});

	it("applies one request deadline while resolving DNS", async () => {
		const [tool] = createPlannerWebTools({
			fetch: vi.fn(
				async () =>
					new Response("too late", {
						status: 200,
						headers: { "content-type": "text/plain" },
					}),
			),
			resolveHostname: vi.fn(async () => {
				await new Promise((resolve) => setTimeout(resolve, 40));
				return ["93.184.216.34"];
			}),
			timeoutMs: 10,
		});

		await expect(
			tool!.execute("fetch-slow-dns", { url: "https://example.com/data" }, undefined, undefined, {} as never),
		).rejects.toThrow("timed out after 10ms");
	});

	it("applies the same request deadline while reading the response body", async () => {
		let closeTimer: ReturnType<typeof setTimeout> | undefined;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("partial"));
				closeTimer = setTimeout(() => controller.close(), 40);
			},
			cancel() {
				if (closeTimer) clearTimeout(closeTimer);
			},
		});
		const [tool] = createPlannerWebTools({
			fetch: vi.fn(
				async () =>
					new Response(body, {
						status: 200,
						headers: { "content-type": "text/plain" },
					}),
			),
			resolveHostname: vi.fn(async () => ["93.184.216.34"]),
			timeoutMs: 10,
		});

		await expect(
			tool!.execute("fetch-slow-body", { url: "https://example.com/data" }, undefined, undefined, {} as never),
		).rejects.toThrow("timed out after 10ms");
	});

	it("rejects IPv4-mapped IPv6 private targets", async () => {
		const [tool] = createPlannerWebTools({
			fetch: vi.fn(),
			resolveHostname: vi.fn(async () => ["93.184.216.34"]),
		});

		await expect(
			tool!.execute(
				"fetch-mapped-loopback",
				{ url: "http://[::ffff:7f00:1]/admin" },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("public");
	});

	it("rejects non-global and private-mapping IPv6 targets", async () => {
		const fetch = vi.fn(
			async () =>
				new Response("unexpected", {
					status: 200,
					headers: { "content-type": "text/plain" },
				}),
		);
		const [tool] = createPlannerWebTools({
			fetch,
			resolveHostname: vi.fn(async () => ["93.184.216.34"]),
		});

		for (const url of [
			"http://[64:ff9b::a00:1]/admin",
			"http://[2002:0a00:0001::]/admin",
			"http://[fec0::1]/admin",
		]) {
			await expect(tool!.execute("fetch-special-ipv6", { url }, undefined, undefined, {} as never)).rejects.toThrow(
				"public",
			);
		}
		expect(fetch).not.toHaveBeenCalled();
	});

	it("truncates oversized public responses", async () => {
		const [tool] = createPlannerWebTools({
			fetch: vi.fn(
				async () =>
					new Response("abcdefghijklmnopqrstuvwxyz", {
						status: 200,
						headers: { "content-type": "text/plain" },
					}),
			),
			resolveHostname: vi.fn(async () => ["93.184.216.34"]),
			maxResponseBytes: 12,
			maxOutputChars: 8,
		});

		const result = await tool!.execute(
			"fetch-truncated",
			{ url: "https://example.com/large" },
			undefined,
			undefined,
			{} as never,
		);
		const payload = JSON.parse(result.content[0]!.type === "text" ? result.content[0].text : "{}");

		expect(payload.truncated).toBe(true);
		expect(payload.text).toHaveLength(8);
	});

	it("searches the fixed public endpoint and returns source metadata", async () => {
		const fetch = vi.fn(
			async () =>
				new Response(
					'<ol id="b_results">' +
						'<li class="b_algo"><h2><a href="https://example.com/news">' +
						"Example <strong>&amp;</strong>-News</a></h2>" +
						'<div class="b_caption"><p>Fresh&ensp;&#0183;&ensp;<b>public</b> result.</p></div></li>' +
						"</ol>",
					{ status: 200, headers: { "content-type": "text/html" } },
				),
		);
		const [, tool] = createPlannerWebTools({
			fetch,
			resolveHostname: vi.fn(async () => ["204.79.197.200"]),
		});

		const result = await tool!.execute(
			"search-1",
			{ query: "current example news", limit: 3 },
			undefined,
			undefined,
			{} as never,
		);
		const payload = JSON.parse(result.content[0]!.type === "text" ? result.content[0].text : "{}");

		expect(payload.query).toBe("current example news");
		expect(payload.results).toEqual([
			{
				title: "Example &-News",
				url: "https://example.com/news",
				snippet: "Fresh · public result.",
			},
		]);
		expect(String(fetch.mock.calls[0]?.[0])).toContain("www.bing.com/search");
	});
});
