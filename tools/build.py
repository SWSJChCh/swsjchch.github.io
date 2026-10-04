#!/usr/bin/env python3
"""Validate the source data; build its browser script and an optional single-file preview.

Python 3.9+; no packages required. Run from any directory:
    python tools/build.py
    python tools/build.py --preview preview.html
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]


def validate(data: dict) -> None:
    people_list = data["people"]
    people = {p["id"]: p for p in people_list}
    if not people or len(people) != len(people_list):
        raise ValueError("People must have unique identifiers.")
    sources = data["sources"]
    if data["meta"]["root"] not in people:
        raise ValueError("The starting person is missing.")
    if not set(data["meta"]["recent"]).issubset(people):
        raise ValueError("The close-family view includes an unknown person.")
    for source in sources.values():
        parsed = urlparse(source["url"])
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ValueError("Each source needs a valid HTTP(S) URL.")
    for person in people.values():
        for key in ("name", "label", "year", "institution", "qualification"):
            if not isinstance(person.get(key), str) or not person[key].strip():
                raise ValueError(f"Missing {key} for {person['id']}.")
        for key in ("x", "y"):
            if not isinstance(person.get(key), (float, int)):
                raise ValueError(f"Missing numeric {key} for {person['id']}.")
        if not set(person["advisors"]).issubset(people):
            raise ValueError(f"Unknown advisor for {person['id']}.")
        if not person["sources"] or not set(person["sources"]).issubset(sources):
            raise ValueError(f"Invalid sources for {person['id']}.")
    edges = set()
    for link in data["links"]:
        edge = link["advisor"], link["student"]
        if edge in edges or not set(edge).issubset(people):
            raise ValueError("Duplicate connection or missing endpoint.")
        if link["evidence"] not in ("record", "archive", "reference"):
            raise ValueError("Unknown connection source category.")
        if not link["sources"] or not set(link["sources"]).issubset(sources):
            raise ValueError("Every connection must have valid sources.")
        edges.add(edge)
    expected = {(advisor, p["id"]) for p in people.values() for advisor in p["advisors"]}
    if edges != expected:
        raise ValueError("The advisors lists and the connections do not agree.")
    done, active = set(), set()
    def visit(person_id: str) -> None:
        if person_id in active:
            raise ValueError("The genealogy contains a cycle.")
        if person_id in done:
            return
        active.add(person_id)
        for advisor in people[person_id]["advisors"]:
            visit(advisor)
        active.remove(person_id)
        done.add(person_id)
    visit(data["meta"]["root"])
    if done != set(people):
        raise ValueError("Every included person must connect to the starting person.")

    views = {"recent": set(data["meta"]["recent"]),
             "highlights": set(data["meta"]["highlights"]), "all": set(people)}
    for view, wanted in views.items():
        layout = data["layouts"][view]
        if set(layout["nodes"]) != wanted:
            raise ValueError(f"Stale {view} layout. Run tools/layout.py after structural edits.")
        for position in layout["nodes"].values():
            if not all(isinstance(position[k], (int, float)) and math.isfinite(position[k]) for k in ("x", "y")):
                raise ValueError("Invalid layout position.")
        projected = set()
        for edge in layout["edges"]:
            endpoints = (edge["advisor"], edge["student"])
            if endpoints in projected or not set(endpoints).issubset(wanted):
                raise ValueError("Duplicate or unknown projected connection.")
            projected.add(endpoints)
            counts = []
            for path in edge["paths"]:
                if len(path) < 2 or (path[0], path[-1]) != endpoints:
                    raise ValueError("A collapsed path has incorrect endpoints.")
                if any(p in wanted for p in path[1:-1]):
                    raise ValueError("A collapsed path skips a visible person.")
                if any((a, b) not in edges for a, b in zip(path, path[1:])):
                    raise ValueError("A collapsed path invents a genealogy link.")
                counts.append(len(path) - 2)
            if not counts or min(counts) != edge["hiddenMin"] or max(counts) != edge["hiddenMax"]:
                raise ValueError("Incorrect hidden-person count.")
            if bool(any(counts)) != edge["collapsed"]:
                raise ValueError("Incorrect collapsed/direct connection label.")
        if view == "all" and projected != edges:
            raise ValueError("The expanded layout omits recorded connections.")


def make_preview(root: Path) -> str:
    html = (root / "genealogy.html").read_text(encoding="utf-8")
    css = (root / "assets/genealogy.css").read_text(encoding="utf-8")
    html = html.replace('<link rel="stylesheet" href="assets/genealogy.css">', '<style>\n' + css + '\n</style>')
    scripts = []
    for filename in ("genealogy-data.js", "genealogy.js"):
        html = html.replace(f'<script src="assets/{filename}" defer></script>', "")
        js = (root / "assets" / filename).read_text(encoding="utf-8")
        # Prevent literal HTML closing tags inside JavaScript strings from terminating a script.
        js = js.replace("</script", "<\\/script").replace("</SCRIPT", "<\\/SCRIPT")
        scripts.append("<script>\n" + js + "\n</script>")
    # In a standalone preview, the homepage is not present beside this file.
    html = html.replace('href="index.html"', 'href="https://www.samjohnsonmaths.com/"')
    html = html.replace('href="genealogy.html"', 'href="#explorer"')
    # Inline scripts must run after the markup: defer only applies to external scripts.
    return html.replace("</body>", "\n".join(scripts) + "\n</body>")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preview", type=Path, help="Also create a self-contained HTML preview.")
    args = parser.parse_args()
    try:
        data = json.loads((ROOT / "assets/genealogy-data.json").read_text(encoding="utf-8"))
        validate(data)
        text = json.dumps(data, indent=2, ensure_ascii=False, allow_nan=False)
        # Escaping '<' also makes arbitrary names and notes safe in an inline preview script.
        browser_json = text.replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
        (ROOT / "assets/genealogy-data.js").write_text(
            "// Generated from genealogy-data.json by tools/build.py.\nwindow.GENEALOGY_DATA = " + browser_json + ";\n", encoding="utf-8")
        if args.preview:
            args.preview.parent.mkdir(parents=True, exist_ok=True)
            args.preview.write_text(make_preview(ROOT), encoding="utf-8")
        print(f"Validated {len(data['people'])} people and {len(data['links'])} connections.")
        return 0
    except (OSError, KeyError, TypeError, ValueError) as error:
        print(f"Build failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
