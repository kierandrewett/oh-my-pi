import { describe, expect, it } from "bun:test";
import {
	type BuildHost,
	fetchBuild,
	isMuslLinuxForTest,
	parseBuildAnswer,
	resolveBuildHost,
} from "@oh-my-pi/pi-coding-agent/cli/build-service";
import { VERSION } from "@oh-my-pi/pi-utils";

const fileName = "omp-darwin-arm64";
const sha = (text: string) => Bun.SHA256.hash(text, "hex");

/** A well-formed `latest` answer, with `overrides` merged over the top level. */
function answer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		build: { id: "20261011-120000-abcdef0", version: "18.8.9", channel: "stable" },
		file: { name: fileName, platform: "macos", arch: "arm64", kind: "binary", size: 205_765_664, sha256: sha("new") },
		download: "https://r2.test/omp/18.8.9/omp-darwin-arm64?X-Amz-Signature=x",
		patch: {
			format: "file",
			from: "20261001-120000-1234567",
			from_sha256: sha("old"),
			size: 6_700_636,
			sha256: sha("patch"),
			url: "https://r2.test/patches/p?X-Amz-Signature=y",
		},
		...overrides,
	};
}

describe("build service answers", () => {
	it("keeps a complete file patch and the version the check named as installed", () => {
		const parsed = parseBuildAnswer(answer(), fileName, "18.8.8");

		expect(parsed).toEqual({
			version: "18.8.9",
			file: { name: fileName, size: 205_765_664, sha256: sha("new") },
			download: "https://r2.test/omp/18.8.9/omp-darwin-arm64?X-Amz-Signature=x",
			patch: {
				fromSha256: sha("old"),
				fromVersion: "18.8.8",
				size: 6_700_636,
				sha256: sha("patch"),
				url: "https://r2.test/patches/p?X-Amz-Signature=y",
			},
		});
	});

	it("rejects answers that cannot be installed safely", () => {
		const file = (fields: Record<string, unknown>) => ({ file: { ...(answer().file as object), ...fields } });
		expect(() => parseBuildAnswer(answer(file({ sha256: sha("new").toUpperCase() })), fileName)).toThrow(
			"invalid sha256",
		);
		expect(() => parseBuildAnswer(answer(file({ sha256: "abc" })), fileName)).toThrow("invalid sha256");
		expect(() => parseBuildAnswer(answer(file({ size: 0 })), fileName)).toThrow("invalid size");
		expect(() => parseBuildAnswer(answer(file({ name: "omp-darwin-x64" })), fileName)).toThrow(
			"omp-darwin-x64 is not omp-darwin-arm64",
		);
		expect(() => parseBuildAnswer(answer({ download: "http://r2.test/omp" }), fileName)).toThrow("no HTTPS download");
		expect(() => parseBuildAnswer(answer({ build: { version: "latest" } }), fileName)).toThrow("no valid version");
	});

	it("installs the whole file when the patch is incomplete or not a file patch", () => {
		const { url: _url, ...withoutUrl } = answer().patch as Record<string, unknown>;
		expect(parseBuildAnswer(answer({ patch: withoutUrl }), fileName).patch).toBeUndefined();
		expect(
			parseBuildAnswer(answer({ patch: { ...(answer().patch as object), format: "tree" } }), fileName).patch,
		).toBeUndefined();
		expect(
			parseBuildAnswer(answer({ patch: { ...(answer().patch as object), url: "http://r2.test/p" } }), fileName)
				.patch,
		).toBeUndefined();
	});
});

describe("build service targets", () => {
	it("maps platform, architecture, and libc to the service target and release file name", () => {
		expect(resolveBuildHost("darwin", "arm64", false)).toEqual({
			target: "macos-arm64",
			fileName: "omp-darwin-arm64",
		});
		expect(resolveBuildHost("linux", "x64", true)).toEqual({
			target: "linux-musl-x86_64",
			fileName: "omp-linux-musl-x64",
		});
		expect(resolveBuildHost("linux", "arm64", false)).toEqual({
			target: "linux-arm64",
			fileName: "omp-linux-arm64",
		});
		expect(resolveBuildHost("win32", "x64", false)).toEqual({
			target: "windows-x86_64",
			fileName: "omp-windows-x64.exe",
		});
	});

	it("does not mistake an installed musl loader for a glibc host", () => {
		expect(
			isMuslLinuxForTest({
				platform: "linux",
				alpineRelease: false,
				lddOutput: "ldd (Ubuntu GLIBC 2.39-0ubuntu8.7) 2.39",
			}),
		).toBe(false);
	});

	it("recognizes a musl host from ldd output", () => {
		expect(
			isMuslLinuxForTest({
				platform: "linux",
				alpineRelease: false,
				lddOutput: "musl libc (x86_64)",
			}),
		).toBe(true);
	});
});

describe("fetchBuild fork releases", () => {
	const host: BuildHost = { target: "macos-arm64", fileName };
	const api = "https://api.github.com/repos/kierandrewett/oh-my-pi/releases";
	const tag = "v18.8.9-fork.2";
	const download = `https://github.com/kierandrewett/oh-my-pi/releases/download/${tag}`;
	const release = {
		tag_name: tag,
		draft: false,
		prerelease: false,
		assets: [{ name: fileName, size: 42 }, { name: "SHA256SUMS.txt" }],
	};
	const checksum = `${sha("new").toUpperCase()}  ${fileName}\n`;

	it("uses the stable GitHub release and checksum to offer the host binary", async () => {
		const requests: Array<{ url: string; accept: string | null; userAgent: string | null; signal: AbortSignal | null | undefined }> = [];
		const build = await fetchBuild({ channel: "stable" }, {
			host,
			fromVersion: "18.8.8",
			fetchImpl: async (input, init) => {
				const url = String(input);
				requests.push({ url, accept: new Headers(init?.headers).get("Accept"), userAgent: new Headers(init?.headers).get("User-Agent"), signal: init?.signal });
				return url === `${api}/latest` ? Response.json(release) : new Response(checksum);
			},
		});
		expect(requests.map(request => [request.url, request.accept])).toEqual([
			[`${api}/latest`, "application/vnd.github+json"],
			[`${download}/SHA256SUMS.txt`, "text/plain"],
		]);
		for (const request of requests) {
			expect(request.userAgent).toBe(`omp/${VERSION}`);
			expect(request.signal).toBeInstanceOf(AbortSignal);
		}
		expect(build).toEqual({
			version: "18.8.9-fork.2",
			file: { name: fileName, size: 42, sha256: sha("new") },
			download: `${download}/${fileName}`,
		});
	});

	it("requests an exact fork version and rejects a different returned tag", async () => {
		const urls: string[] = [];
		const fetchImpl = async (input: string | URL | Request) => {
			const url = String(input);
			urls.push(url);
			return url.startsWith(api) ? Response.json(release) : new Response(checksum);
		};
		await fetchBuild({ version: "18.8.9-fork.2" }, { host, fetchImpl });
		expect(urls[0]).toBe(`${api}/tags/${tag}`);
		await expect(fetchBuild({ version: "18.8.9-fork.1" }, { host, fetchImpl })).rejects.toThrow("version mismatch");
	});

	it("rejects canary rather than offering an unrelated stable release", async () => {
		await expect(fetchBuild({ channel: "canary" }, { host })).rejects.toThrow("stable releases only");
	});

	it("rejects draft, prerelease, and malformed fork release metadata", async () => {
		for (const body of [null, { ...release, draft: true }, { ...release, prerelease: true },
			{ ...release, tag_name: "v18.8.9" }, { ...release, tag_name: "v18.8.9-fork.0" },
			{ ...release, assets: null }]) {
			await expect(fetchBuild({ channel: "stable" }, { host, fetchImpl: async () => Response.json(body) }))
				.rejects.toThrow("Invalid stable fork release metadata");
		}
	});

	it("rejects missing, duplicate, or invalid platform assets before downloading", async () => {
		for (const assets of [
			[{ name: "omp-darwin-x64", size: 42 }, { name: "SHA256SUMS.txt" }],
			[{ name: fileName, size: 42 }],
			[{ name: fileName, size: 42 }, { name: fileName, size: 42 }, { name: "SHA256SUMS.txt" }],
			[{ name: fileName, size: 0 }, { name: "SHA256SUMS.txt" }],
		]) {
			await expect(fetchBuild({ channel: "stable" }, { host, fetchImpl: async () => Response.json({ ...release, assets }) }))
				.rejects.toThrow(`Fork release does not contain exactly one ${fileName}`);
		}
	});

	it("rejects missing or ambiguous checksums instead of installing unverifiable bytes", async () => {
		for (const sums of [`${sha("new")}  omp-darwin-x64\n`, `${checksum}${checksum}`, `not-a-hash  ${fileName}\n`]) {
			await expect(fetchBuild({ channel: "stable" }, {
				host,
				fetchImpl: async input => String(input).startsWith(api) ? Response.json(release) : new Response(sums),
			})).rejects.toThrow(`Missing or ambiguous SHA-256 for ${fileName}`);
		}
	});

	it("surfaces GitHub release request failures", async () => {
		await expect(fetchBuild({ channel: "stable" }, {
			host, fetchImpl: async () => new Response(null, { status: 404 }),
		})).rejects.toThrow("GitHub release request failed: 404");
	});
});
