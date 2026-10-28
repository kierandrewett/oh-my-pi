#!/usr/bin/env bash
set -euo pipefail
tracker=$1
source_dir=$2
patch_dir="$tracker/scripts/fork/patches"
series="$patch_dir/series"
[ -f "$series" ] || { echo "Missing patch series: $series" >&2; exit 1; }
count=0
declare -A seen=()
declare -a order=()
while IFS= read -r patch || [ -n "$patch" ]; do
  [[ -z "$patch" || "$patch" == \#* ]] && continue
  [[ "$patch" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*\.patch$ ]] || { echo "Invalid patch name: $patch" >&2; exit 1; }
  [[ ! ${seen[$patch]+yes} ]] || { echo "Duplicate patch: $patch" >&2; exit 1; }
  seen[$patch]=1
  order+=("$patch")
  [ -s "$patch_dir/$patch" ] || { echo "Missing or empty patch: $patch" >&2; exit 1; }
  echo "Applying $patch"
  git -C "$source_dir" apply --index --whitespace=nowarn "$patch_dir/$patch"
  count=$((count + 1))
done < "$series"
[ "$count" -gt 0 ] || { echo 'Patch series is empty; refusing to publish upstream binaries' >&2; exit 1; }
for required in 0001-task-model-selection.patch 0002-fork-updater.patch; do
  [[ ${seen[$required]+yes} ]] || { echo "Required patch absent from series: $required" >&2; exit 1; }
done
[[ "${order[0]}" == 0001-task-model-selection.patch && "${order[1]}" == 0002-fork-updater.patch ]] || {
  echo 'The task model selection and fork updater patches must be first, in that order' >&2
  exit 1
}
