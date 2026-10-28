# @oh-my-pi/pi-coding-agent

Core implementation package for the `omp` coding agent in the `omp` monorepo.

For installation, setup, provider configuration, model roles, slash commands, and full CLI reference, see:
- [Monorepo README (local)](../../README.md)
- [Monorepo README (GitHub)](https://github.com/can1357/oh-my-pi#readme)

Package-specific references:
- [CHANGELOG](./CHANGELOG.md)
- [MCP configuration guide](../../docs/mcp-config.md)
- [MCP runtime lifecycle](../../docs/mcp-runtime-lifecycle.md)
- [MCP server/tool authoring](../../docs/mcp-server-tool-authoring.md)
- [DEVELOPMENT](./DEVELOPMENT.md)

## Fork releases and updates

This fork publishes standalone binaries at [kierandrewett/oh-my-pi releases](https://github.com/kierandrewett/oh-my-pi/releases). `omp update` and startup checks use the latest stable fork release, not the upstream npm registry or build service. Releases are named `v<upstream-version>-fork.<revision>`; the embedded version has the same suffix. The updater verifies the release asset's SHA-256 and size before replacing the binary, and restores the previous binary if version verification fails. Canary releases are not provided; use `omp update --stable` if the stored channel is canary. A platform without a matching release asset fails rather than falling back to an upstream binary.

The fork does not publish npm packages, a Homebrew formula, or a mise package. The fork updater will not upgrade or overwrite an npm, bun, Homebrew, mise, or Nix-managed installation; `omp update --check` checks the fork release and a normal update reports that an explicit migration is required. **An already-installed upstream executable still has its original updater**; do not run it to migrate.

To migrate a Linux glibc x64 install explicitly, install the fork binary separately, leaving the managed installation intact. For example, with the GitHub CLI and `sha256sum` installed:

```sh
mkdir -p ~/.local/bin
workdir=$(mktemp -d)
gh release download --repo kierandrewett/oh-my-pi --dir "$workdir" --pattern omp-linux-x64 --pattern SHA256SUMS.txt
(cd "$workdir" && grep '  omp-linux-x64$' SHA256SUMS.txt | sha256sum -c -) && install -m 755 "$workdir/omp-linux-x64" ~/.local/bin/omp
```

Check the checksum command succeeds before installing, and ensure `~/.local/bin` precedes the old manager's bin directory in `PATH`. The `install` command replaces any existing `~/.local/bin/omp`; back it up first if necessary. Verify the selected executable with `command -v omp` and `omp --version`. Roll back by restoring that backup or removing the separately installed fork binary and selecting the original managed launcher on `PATH`. Do not uninstall the old package until you no longer need that rollback path; package-manager cleanup may remove manager-owned launchers. Configuration and credentials are unchanged. Release checksums detect corrupted downloads but are not independent signatures.

## Memory backends

The agent supports three mutually-exclusive memory backends, selected via the `memory.backend` setting (Settings → Memory tab, or `~/.omp/config.yml`):

- `off` (default) — no memory subsystem runs.
- `local` — existing rollout-summarisation pipeline; writes `memory_summary.md` and consolidated artifacts under the agent dir.
- `hindsight` — talks to a [Hindsight](https://hindsight.vectorize.io) server (Cloud or self-hosted Docker), retains transcripts every Nth user turn, recalls memories on the first turn of a session, and exposes `retain`, `recall`, and `reflect`.

### Hindsight quickstart

1. Run a Hindsight server (Cloud or `docker run -p 8888:8888 ghcr.io/vectorize-io/hindsight:latest`).
2. Set `memory.backend = "hindsight"` and `hindsight.apiUrl = "http://localhost:8888"` (or your Cloud URL).
3. Optional environment overrides (env wins over settings):
   - `HINDSIGHT_API_URL`, `HINDSIGHT_API_TOKEN` — connection
   - `HINDSIGHT_BANK_ID`, `HINDSIGHT_DYNAMIC_BANK_ID`, `HINDSIGHT_AGENT_NAME` — bank addressing
   - `HINDSIGHT_AUTO_RECALL`, `HINDSIGHT_AUTO_RETAIN`, `HINDSIGHT_RETAIN_MODE` — lifecycle
   - `HINDSIGHT_RECALL_BUDGET`, `HINDSIGHT_RECALL_MAX_TOKENS` — recall sizing
   - `HINDSIGHT_BANK_MISSION`, `HINDSIGHT_DEBUG`

Switching backends mid-session immediately replaces the live backend, memory tools, listeners, and system-prompt context. Existing users with `memories.enabled = true|false` are migrated to `memory.backend = "local"|"off"` exactly once on first launch; afterward, `memory.backend` is the sole runtime selector.
