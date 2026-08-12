#!/usr/bin/env python3
"""
Pick the godot_openxr_vendors release asset matching the Godot version in use.

Kept out of the workflow YAML because a heredoc'd Python block inside a
`run:` step has to satisfy both YAML block indentation and Python's own,
which is a reliable source of "worked until someone reindented it".

The plugin's major version tracks Godot's minor: 3.x targets Godot 4.3.
Prereleases are skipped, and the chosen tag plus the full candidate list are
printed to stderr so a wrong pick is visible in the log rather than
producing a mysteriously non-VR APK.
"""
import json
import re
import sys

WANTED_MAJOR = "3"   # godot_openxr_vendors 3.x -> Godot 4.3


def main() -> int:
    releases = json.load(open(sys.argv[1]))
    tags = [r["tag_name"] for r in releases]
    print(f"available tags: {tags[:12]}", file=sys.stderr)

    stable = [r for r in releases if not r.get("prerelease")]
    matching = [r for r in stable
                if re.match(rf"^v?{WANTED_MAJOR}\.", r["tag_name"])]

    if matching:
        chosen = matching[0]
    elif stable:
        chosen = stable[0]
        print(f"WARNING: no {WANTED_MAJOR}.x release found; falling back to "
              f"{chosen['tag_name']}, which may not match this Godot version.",
              file=sys.stderr)
    else:
        print("no stable releases found", file=sys.stderr)
        return 1

    zips = [a for a in chosen.get("assets", []) if a["name"].endswith(".zip")]
    if not zips:
        print(f"release {chosen['tag_name']} has no .zip asset: "
              f"{[a['name'] for a in chosen.get('assets', [])]}", file=sys.stderr)
        return 1

    print(f"chosen: {chosen['tag_name']} -> {zips[0]['name']}", file=sys.stderr)
    print(zips[0]["browser_download_url"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
