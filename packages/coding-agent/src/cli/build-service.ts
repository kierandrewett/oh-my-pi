/** Fork release discovery and shared build metadata types for the updater. */
import * as fs from "node:fs";
import { $env, APP_NAME, isRecord, VERSION } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import {
	isTimeoutError,
	isUnsupportedProxyError,
	unsupportedProxyMessage,
	withTimeoutSignal,
} from "../utils/fetch-timeout";

export type UpdateChannel = "stable" | "canary";

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Build service origin used when `PI_BUILD_URL` is unset. */
export const DEFAULT_BUILD_URL = "https://build.stencil.so";

/** The product omp's builds are published under. */
const FORK_REPOSITORY = "kierandrewett/oh-my-pi";

const BUILD_CHECK_TIMEOUT_MS = 30_000;

/** Build service origin: `PI_BUILD_URL` without trailing slashes, else {@link DEFAULT_BUILD_URL}. */
export function buildServiceUrl(): string {
	const configured = ($env.PI_BUILD_URL ?? "").trim().replace(/\/+$/, "");
	return configured || DEFAULT_BUILD_URL;
}

/** Where this host's builds live on the build service. */
export interface BuildHost {
	/** Build service target, e.g. `macos-arm64` or `linux-musl-x86_64`. */
	target: string;
	/** Name of the target's file, the release asset name (e.g. `omp-darwin-arm64`). */
	fileName: string;
}

/** The build service target and file name for a platform, architecture, and libc. */
export function resolveBuildHost(platform: NodeJS.Platform, arch: string, musl: boolean): BuildHost {
	let targetOs: string;
	let fileOs: string;
	switch (platform) {
		case "darwin":
			targetOs = "macos";
			fileOs = "darwin";
			break;
		case "linux":
			targetOs = musl ? "linux-musl" : "linux";
			fileOs = targetOs;
			break;
		case "win32":
			targetOs = "windows";
			fileOs = "windows";
			break;
		default:
			throw new Error(`Unsupported platform: ${platform}`);
	}
	let targetArch: string;
	switch (arch) {
		case "x64":
			targetArch = "x86_64";
			break;
		case "arm64":
			targetArch = "arm64";
			break;
		default:
			throw new Error(`Unsupported architecture: ${arch}`);
	}
	return {
		target: `${targetOs}-${targetArch}`,
		fileName: `${APP_NAME}-${fileOs}-${arch}${platform === "win32" ? ".exe" : ""}`,
	};
}

/**
 * Detect a musl-libc Linux host (Alpine, Void-musl) so self-update replaces a
 * musl binary with the musl build instead of the glibc one, which would fail
 * to start on the next run. The loader file alone is not sufficient: glibc
 * hosts may have musl installed for cross-compilation.
 */
interface MuslDetectionOptions {
	platform: NodeJS.Platform;
	alpineRelease: boolean;
	lddOutput: string;
}

function isMuslLinux(options: MuslDetectionOptions): boolean {
	if (options.platform !== "linux") return false;
	return options.alpineRelease || /\bmusl\b/i.test(options.lddOutput);
}

/** Test seam for libc detection. */
export function isMuslLinuxForTest(options: MuslDetectionOptions): boolean {
	return isMuslLinux(options);
}

async function detectLddOutput(): Promise<string> {
	try {
		const result = await $`ldd --version`.quiet().nothrow();
		return `${result.stdout.toString("utf-8")}\n${result.stderr.toString("utf-8")}`;
	} catch {
		return "";
	}
}

let currentHost: Promise<BuildHost> | undefined;

/** This host's {@link BuildHost}, detected once per process. */
export function currentBuildHost(): Promise<BuildHost> {
	currentHost ??= (async () => {
		const platform = process.platform;
		const musl =
			platform === "linux" &&
			isMuslLinux({
				platform,
				alpineRelease: fs.existsSync("/etc/alpine-release"),
				lddOutput: await detectLddOutput(),
			});
		return resolveBuildHost(platform, process.arch, musl);
	})();
	return currentHost;
}

/** The answered build's file for this host. */
export interface BuildFile {
	name: string;
	size: number;
	/** Lowercase hex SHA-256. */
	sha256: string;
}

/** HDiffPatch single-stream patch (`HDIFFSF20`) from an installed file to {@link BuildFile}. */
export interface BuildPatch {
	/** Lowercase hex SHA-256 of the file the patch applies to. */
	fromSha256: string;
	/** Version the check named as installed (`from_version`), for progress output. */
	fromVersion?: string;
	size: number;
	/** Lowercase hex SHA-256 of the patch itself. */
	sha256: string;
	/** Presigned HTTPS URL of the patch. */
	url: string;
}

/** A checked build service answer. */
export interface BuildAnswer {
	version: string;
	file: BuildFile;
	/** Presigned HTTPS URL of the whole file, valid for minutes. */
	download: string;
	patch?: BuildPatch;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function isSize(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSha256(value: unknown): value is string {
	return typeof value === "string" && SHA256_HEX.test(value);
}

function isHttpsUrl(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		return new URL(value).protocol === "https:";
	} catch {
		return false;
	}
}

/** The answer's patch when it is a complete `file` patch; anything else installs the whole file. */
function parseBuildPatch(patch: unknown, fromVersion: string | undefined): BuildPatch | undefined {
	if (!isRecord(patch) || patch.format !== "file") return undefined;
	if (!isSha256(patch.from_sha256) || !isSize(patch.size) || !isSha256(patch.sha256) || !isHttpsUrl(patch.url)) {
		return undefined;
	}
	return { fromSha256: patch.from_sha256, fromVersion, size: patch.size, sha256: patch.sha256, url: patch.url };
}

/**
 * Check a build service answer for the file named `fileName`.
 *
 * Throws when the answer cannot be installed safely: a version that is not
 * semver, a file other than `fileName`, a size or SHA-256 that is not exact,
 * or a download that is not HTTPS. A `patch` is kept only when it is a
 * complete `format: "file"` patch; any other patch is dropped, not an error.
 * `fromVersion` is the `from_version` the check sent.
 */
export function parseBuildAnswer(body: unknown, fileName: string, fromVersion?: string): BuildAnswer {
	if (!isRecord(body) || !isRecord(body.build)) throw new Error("answer has no build");
	const version = body.build.version;
	if (typeof version !== "string" || !SEMVER.test(version)) throw new Error("build has no valid version");
	const file = body.file;
	if (!isRecord(file)) throw new Error("answer has no file");
	if (file.name !== fileName) throw new Error(`answered file ${String(file.name)} is not ${fileName}`);
	if (!isSize(file.size)) throw new Error(`${fileName} has an invalid size`);
	if (!isSha256(file.sha256)) throw new Error(`${fileName} has an invalid sha256`);
	if (!isHttpsUrl(body.download)) throw new Error(`${fileName} has no HTTPS download`);
	return {
		version,
		file: { name: fileName, size: file.size, sha256: file.sha256 },
		download: body.download,
		patch: parseBuildPatch(body.patch, fromVersion),
	};
}

/** Which build to ask for: the newest on a channel, or one exact version. */
export type BuildSelector = { channel: UpdateChannel } | { version: string };

export interface FetchBuildOptions {
	/** Installed version to ask a patch from (`from_version`). */
	fromVersion?: string;
	timeoutMs?: number;
	fetchImpl?: Fetch;
	/** Defaults to {@link currentBuildHost}. */
	host?: BuildHost;
}

/** Fetch a stable fork release and verify its platform-specific checksum metadata. */
export async function fetchBuild(selector: BuildSelector, options: FetchBuildOptions = {}): Promise<BuildAnswer> {
	if ("channel" in selector && selector.channel !== "stable") {
		throw new Error("The fork publishes stable releases only; use --stable.");
	}
	const host = options.host ?? (await currentBuildHost());
	const timeoutMs = options.timeoutMs ?? BUILD_CHECK_TIMEOUT_MS;
	const fetchImpl = options.fetchImpl ?? fetch;
	const api = `https://api.github.com/repos/${FORK_REPOSITORY}/releases`;
	const route = "version" in selector ? `/tags/${encodeURIComponent(`v${selector.version}`)}` : "/latest";
	const request = async (url: string, accept: string): Promise<Response> => {
		try {
			const response = await fetchImpl(url, {
				headers: { Accept: accept, "User-Agent": `${APP_NAME}/${VERSION}` },
				signal: withTimeoutSignal(timeoutMs),
			});
			if (!response.ok) throw new Error(`GitHub release request failed: ${response.status} ${response.statusText}`);
			return response;
		} catch (err) {
			if (isTimeoutError(err)) throw new Error("Timed out fetching fork release metadata", { cause: err });
			if (isUnsupportedProxyError(err)) throw new Error(unsupportedProxyMessage(), { cause: err });
			throw err;
		}
	};
	const release: unknown = await (await request(`${api}${route}`, "application/vnd.github+json")).json();
	if (!isRecord(release) || release.draft !== false || release.prerelease !== false ||
		typeof release.tag_name !== "string" || !/^v\d+\.\d+\.\d+-fork\.[1-9]\d*$/.test(release.tag_name) ||
		!Array.isArray(release.assets)) {
		throw new Error("Invalid stable fork release metadata");
	}
	const version = release.tag_name.slice(1);
	if ("version" in selector && selector.version !== version) throw new Error("Fork release version mismatch");
	const asset = release.assets.filter((entry: unknown) => isRecord(entry) && entry.name === host.fileName);
	const sums = release.assets.filter((entry: unknown) => isRecord(entry) && entry.name === "SHA256SUMS.txt");
	if (asset.length !== 1 || sums.length !== 1 || !isRecord(asset[0]) || !isSize(asset[0].size)) {
		throw new Error(`Fork release does not contain exactly one ${host.fileName} and SHA256SUMS.txt`);
	}
	const base = `https://github.com/${FORK_REPOSITORY}/releases/download/${encodeURIComponent(release.tag_name)}`;
	const checksumText = await (await request(`${base}/SHA256SUMS.txt`, "text/plain")).text();
	const matches = checksumText.split(/\r?\n/).map(line => /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line))
		.filter(match => match?.[2] === host.fileName);
	if (matches.length !== 1 || !matches[0]) throw new Error(`Missing or ambiguous SHA-256 for ${host.fileName}`);
	return {
		version,
		file: { name: host.fileName, size: asset[0].size, sha256: matches[0][1].toLowerCase() },
		download: `${base}/${encodeURIComponent(host.fileName)}`,
	};
}
