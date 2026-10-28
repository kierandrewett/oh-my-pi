# Fork release tracker

The scheduled workflow and manual dispatch run from the fork's default branch.
They query the latest **stable GitHub release** of `can1357/oh-my-pi`, check out
that tag in a separate directory, and apply every patch named in
`patches/series` in order with `git apply --index`. Missing, empty, duplicate,
or conflicting patches fail the run; upstream artifacts are never substituted.
The tracker branch itself is not fast-forwarded or replaced by upstream.

## Maintaining the patch series

`patches/series` contains one filename per line, relative to `patches/`;
blank lines and lines beginning with `#` are ignored. The required initial
entries are `0001-task-model-selection.patch` and `0002-fork-updater.patch`.
Generate ordinary `git diff --binary` patches against the upstream tag, with
the second patch based on the tree *after* the first. Include source, tests,
and documentation changes needed for each feature; do not include the tracker
files themselves. Commit both patch files and the series on the fork default
branch. If a newer upstream release conflicts, the Actions run fails visibly:
rebase the patches against that release and commit the refreshed series.
Never remove a patch just to make a release pass.

`scripts/fork/revision` is a positive integer. Tags and embedded CLI versions
are `v<upstream-version>-fork.<revision>` and `<upstream-version>-fork.<revision>`.
Increment the revision when shipping changed fork patches for an upstream
version already released. Existing published versions are immutable and skipped;
no assets are overwritten. A failed draft is left for inspection and must be
removed manually before retrying. Old releases remain available for rollback.

The workflow builds the Linux glibc x64 baseline executable and both native
addon variants from the patched upstream source using its Bazel and release
binary scripts. It publishes raw `omp-linux-x64` and `SHA256SUMS.txt` (standard
`sha256sum` format). No npm, Homebrew, or upstream build-service publication is
performed. Other platforms are not currently shipped. Updaters must treat
`-fork.N` as a fork revision and permit migration from the corresponding upstream
version, rather than treating this SemVer prerelease as an older build.

GitHub Actions must be enabled on the fork with permission to create releases.
The workflow uses only the automatically provided `GITHUB_TOKEN`. Review build
logs and the release's tracker commit when diagnosing failures. To roll back,
install a previously published binary and verify it against that release's
checksum; publishing or deleting releases does not alter an installed binary.
