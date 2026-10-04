#!/usr/bin/env python3
"""Add the genealogy page and a homepage button to a local copy of Samuel's website.

Preview changes (default): python tools/install.py /path/to/swsjchch.github.io
Apply changes:             python tools/install.py /path/to/swsjchch.github.io --apply

This script does not use Git, contact GitHub, commit, or publish anything.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
import shutil
import sys

SOURCE = Path(__file__).resolve().parents[1]
FILES = ("genealogy.html", "assets/genealogy.css", "assets/genealogy.js",
         "assets/genealogy-data.js", "assets/genealogy-data.json")
LINK = '<a href="genealogy.html" class="btn">Academic genealogy</a>'


class HeroLinks(HTMLParser):
    """Locate the existing hero button group without reserialising the page."""
    def __init__(self, text: str) -> None:
        super().__init__(convert_charrefs=True)
        self.offsets = [0]
        for line in text.splitlines(keepends=True):
            self.offsets.append(self.offsets[-1] + len(line))
        self.depth = 0
        self.seen = False
        self.end = None
        self.already_linked = False
        self.feed(text)
        self.close()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "a" and attrs.get("href", "").split("#")[0].lstrip("./") == "genealogy.html":
            self.already_linked = True
        if tag != "div":
            return
        if self.depth:
            self.depth += 1
        elif not self.seen and "hero-links" in attrs.get("class", "").split():
            self.seen = True
            self.depth = 1

    def handle_endtag(self, tag):
        if tag != "div" or not self.depth:
            return
        self.depth -= 1
        if not self.depth:
            line, column = self.getpos()
            self.end = self.offsets[line - 1] + column


def add_homepage_link(text: str) -> tuple[str, bool]:
    parser = HeroLinks(text)
    if parser.already_linked:
        return text, False
    if parser.end is None:
        raise ValueError('No complete <div class="hero-links"> group was found. '
                         'No files were changed. Use the manual instructions in README.md.')
    newline = "\r\n" if "\r\n" in text else "\n"
    line_start = text.rfind("\n", 0, parser.end) + 1
    prefix = text[line_start:parser.end]
    if not prefix.strip():
        # Insert an indented line immediately before the existing closing tag.
        result = text[:line_start] + prefix + "  " + LINK + newline + text[line_start:]
    else:
        result = text[:parser.end] + newline + "  " + LINK + newline + text[parser.end:]
    return result, True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repository", type=Path, help="Local folder containing your existing index.html.")
    parser.add_argument("--apply", action="store_true", help="Write the changes; otherwise only preview them.")
    parser.add_argument("--overwrite", action="store_true", help="Replace existing, different genealogy files. Does not replace your homepage.")
    args = parser.parse_args()
    try:
        target = args.repository.expanduser().resolve()
        if target == SOURCE:
            raise ValueError("Choose your website repository, not this package's folder.")
        index = target / "index.html"
        original_bytes = index.read_bytes()
        original = original_bytes.decode("utf-8")
        updated, changed = add_homepage_link(original)
        plan = []
        for name in FILES:
            source, destination = SOURCE / name, target / name
            if not source.is_file():
                raise ValueError(f"Package file is missing: {name}")
            if destination.exists():
                if not destination.is_file():
                    raise ValueError(f"Destination is not a file: {destination}")
                if source.read_bytes() == destination.read_bytes():
                    continue
                if not args.overwrite:
                    raise ValueError(f"Refusing to overwrite {name}. Review it first, then use --overwrite.")
            plan.append((source, destination))
        print("Apply changes:" if args.apply else "Preview only (add --apply to write):")
        for source, destination in plan:
            print(f"  Copy {destination.relative_to(target)}")
        print("  Add Academic genealogy button to index.html" if changed else "  Homepage already links to genealogy.html")
        if not args.apply:
            print("No files were changed.")
            return 0
        # All predictable validation happens above, before any writes.
        if changed:
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
            backup = target / f"index.html.before-genealogy-{stamp}.bak"
            with backup.open("xb") as output:
                output.write(original_bytes)
            print(f"  Homepage backup: {backup.name} (keep locally; do not commit it)")
        for source, destination in plan:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
        if changed:
            index.write_bytes(updated.encode("utf-8"))
        print("Finished. Review the changes and publish through your normal Git workflow.")
        return 0
    except (OSError, UnicodeError, ValueError) as error:
        print(f"Installation stopped: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
