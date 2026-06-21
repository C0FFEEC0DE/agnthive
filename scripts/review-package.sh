#!/usr/bin/env bash
# review-package — write a review package (commit list + diffstat + full diff)
# for BASE..HEAD to a uniquely named file and print the path. The reviewer
# reads one file instead of re-deriving the branch diff with git commands, so
# the diff never enters the controller's context.
#
# Usage: review-package BASE HEAD
#   BASE, HEAD are commit-ish. BASE may be the literal token MERGE_BASE, which
#   resolves to git merge-base of the default branch and HEAD (use for the
#   final whole-branch review).
#
# Output dir: $CLAUDE_CREW_REVIEW_DIR, else .claude-crew/reviews/ under the git
# toplevel (or cwd). That path is gitignored (see .gitignore).

set -euo pipefail

if [ $# -ne 2 ]; then
    echo "Usage: $(basename "$0") BASE HEAD" >&2
    echo "  BASE may be MERGE_BASE to resolve git merge-base of the default branch and HEAD" >&2
    exit 2
fi

base_arg="$1"
head_arg="$2"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "review-package: not inside a git work tree" >&2
    exit 2
fi

resolve_base() {
    if [ "$base_arg" = "MERGE_BASE" ]; then
        local default_branch=""
        default_branch="$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null \
            | sed 's|refs/remotes/origin/||' || true)"
        if [ -n "$default_branch" ]; then
            # origin/HEAD points at refs/remotes/origin/<name>; use the
            # remote-tracking ref as the commit-ish (local <name> may be absent).
            default_branch="origin/$default_branch"
        else
            for candidate in origin/main origin/master main master; do
                if git rev-parse --verify "$candidate" >/dev/null 2>&1; then
                    default_branch="$candidate"
                    break
                fi
            done
            if [ -z "$default_branch" ]; then
                echo "review-package: cannot determine default branch for MERGE_BASE" >&2
                exit 2
            fi
        fi
        git merge-base "$default_branch" "$head_arg"
    else
        git rev-parse --verify "${base_arg}^{commit}"
    fi
}

base_sha="$(resolve_base)"
head_sha="$(git rev-parse --verify "${head_arg}^{commit}")"
base7="${base_sha:0:7}"
head7="${head_sha:0:7}"

review_dir="${CLAUDE_CREW_REVIEW_DIR:-}"
if [ -z "$review_dir" ]; then
    toplevel="$(git rev-parse --show-toplevel 2>/dev/null || true)"
    if [ -n "$toplevel" ]; then
        review_dir="$toplevel/.claude-crew/reviews"
    else
        review_dir="${PWD}/.claude-crew/reviews"
    fi
fi
mkdir -p "$review_dir"

review_file="$review_dir/${base7}..${head7}-review.md"

{
    printf '# Review package: %s..%s\n\n' "$base7" "$head7"
    printf '## Commits\n\n```\n'
    git log --oneline "${base_sha}..${head_sha}"
    printf '\n```\n\n## Diffstat\n\n```\n'
    git diff --stat "${base_sha}..${head_sha}"
    printf '\n```\n\n## Full diff (-U10)\n\n```diff\n'
    git diff -U10 "${base_sha}..${head_sha}"
    printf '\n```\n'
} > "$review_file"

printf '%s\n' "$review_file"