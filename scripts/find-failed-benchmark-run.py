#!/usr/bin/env python3
"""Find the last failed benchmark run for a given workflow.

Used by auto_resume mode to automatically retry only failed tasks.
"""

import argparse
import os
import subprocess
import sys
import json
from datetime import datetime, timezone, timedelta


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Find the last failed benchmark run"
    )
    parser.add_argument(
        "--workflow",
        required=True,
        help="Workflow name or ID to search",
    )
    parser.add_argument(
        "--branch",
        default=None,
        help="Filter by branch (default: current branch)",
    )
    parser.add_argument(
        "--max-age-hours",
        type=int,
        default=72,
        help="Maximum age of run to consider in hours (default: 72)",
    )
    parser.add_argument(
        "--status",
        default="failed",
        choices=["failed", "unresolved"],
        help="Run status to find: 'failed' (conclusion=failed) or 'unresolved' (has unresolved tasks)",
    )
    parser.add_argument(
        "--repo",
        default=None,
        help="Repository (owner/repo format)",
    )
    parser.add_argument(
        "--output-file",
        default=None,
        help="Output file for run info (default: stdout)",
    )
    return parser.parse_args()


def run_gh(args: list[str], check: bool = True) -> dict | None:
    """Run gh CLI command and return JSON output."""
    cmd = ["gh"] + args
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        if not check:
            return None
        print(f"gh command failed: {' '.join(cmd)}", file=sys.stderr)
        print(f"stderr: {result.stderr}", file=sys.stderr)
        sys.exit(1)
    return json.loads(result.stdout)


def find_failed_run(
    workflow: str,
    branch: str | None,
    max_age_hours: int,
    status: str,
    repo: str | None,
) -> dict | None:
    """Find the last failed benchmark run."""

    # Build gh run list command
    cmd_args = [
        "run", "list",
        "--workflow", workflow,
        "--limit", "50",
        "--json", "databaseId,status,conclusion,createdAt,headBranch,displayTitle",
    ]
    if branch:
        cmd_args.extend(["--branch", branch])
    if repo:
        cmd_args.extend(["--repo", repo])

    runs = run_gh(cmd_args, check=False)
    if not runs:
        return None

    cutoff = datetime.now(timezone.utc)
    cutoff = cutoff - timedelta(hours=max_age_hours)

    for run in runs:
        # Parse created date
        created_str = run.get("createdAt", "")
        if not created_str:
            continue
        try:
            created = datetime.fromisoformat(created_str.replace("Z", "+00:00"))
        except ValueError:
            continue

        # Skip runs older than cutoff
        if created < cutoff:
            continue

        run_status = run.get("status", "")
        conclusion = run.get("conclusion", "")

        # Only consider completed runs
        if run_status != "completed":
            continue

        if status == "failed":
            # Find runs that concluded with failure
            if conclusion == "failure":
                return run
        elif status == "unresolved":
            # Find runs that might have unresolved tasks
            # This requires downloading the summary artifact
            # For now, treat failure the same as unresolved
            if conclusion == "failure":
                return run

    return None


def main() -> None:
    args = parse_args()

    # Get current branch if not specified
    branch = args.branch
    if not branch:
        result = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            branch = result.stdout.strip()

    run_info = find_failed_run(
        workflow=args.workflow,
        branch=branch,
        max_age_hours=args.max_age_hours,
        status=args.status,
        repo=args.repo,
    )

    output_path = args.output_file or os.environ.get("GITHUB_OUTPUT")

    if run_info:
        run_id = run_info.get("databaseId", "")
        display_title = run_info.get("displayTitle", "")
        created = run_info.get("createdAt", "")

        if output_path:
            with open(output_path, "a", encoding="utf-8") as handle:
                handle.write("found=true\n")
                handle.write(f"run_id={run_id}\n")
                handle.write(f"display_title={display_title}\n")
                handle.write(f"created_at={created}\n")
        else:
            output = {
                "found": True,
                "run_id": str(run_id),
                "display_title": display_title,
                "created_at": created,
            }
            print(json.dumps(output, indent=2))
    else:
        if output_path:
            with open(output_path, "a", encoding="utf-8") as handle:
                handle.write("found=false\n")
        else:
            output = {
                "found": False,
                "run_id": "",
                "display_title": "",
                "created_at": "",
            }
            print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()