#!/usr/bin/env python3
"""Check the local preview in Chromium. Requires Python Playwright and Chromium.

Run: python tools/build.py --preview preview.html && python tools/test.py
All network requests are blocked, so these checks use local font fallbacks.
"""
from __future__ import annotations

import importlib.util
import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
results: list[dict] = []

def check(name: str, condition: bool, detail: str = "") -> None:
    results.append({"name": name, "passed": bool(condition), "detail": detail})
    if not condition:
        raise AssertionError(name + (": " + detail if detail else ""))


def run() -> None:
    spec = importlib.util.spec_from_file_location("genealogy_build", ROOT / "tools/build.py")
    build = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(build)
    data = json.loads((ROOT / "assets/genealogy-data.json").read_text())
    build.validate(data)
    check("Structural validator: sources, original links, connectivity, cycles and projected paths", True)
    check("48 people and 54 original connections retained", len(data["people"]) == 48 and len(data["links"]) == 54)
    check("16 highlights and four close-family members retained", len(data["meta"]["highlights"]) == 16 and len(data["meta"]["recent"]) == 4)
    check("Schnell is not a graph node", not any("schnell" in p["name"].lower() for p in data["people"]))
    html = (ROOT / "preview.html").read_text()
    split = (ROOT / "genealogy.html").read_text()
    check("Standalone preview matches current split assets", html == build.make_preview(ROOT))
    check("Legacy hero, return button and adviser-sidebar label removed", all(s not in split for s in ["page-header", "Back to Samuel", "reset-view", "edition-badge"]) and "Advisers / teachers shown" not in (ROOT / "assets/genealogy.js").read_text())
    for asset in ("genealogy.css", "genealogy.js", "genealogy-data.js", "genealogy-data.json"):
        check("Split asset exists: " + asset, (ROOT / "assets" / asset).is_file())

    from playwright.sync_api import sync_playwright
    browser_errors: list[str] = []
    with sync_playwright() as p:
        executable = shutil.which("chromium") or shutil.which("chromium-browser")
        options = {"headless": True, "args": ["--no-sandbox", "--disable-dev-shm-usage"]}
        if executable:
            options["executable_path"] = executable
        browser = p.chromium.launch(**options)
        page = browser.new_page(viewport={"width": 1500, "height": 1080})
        page.route("**/*", lambda route: route.abort())
        page.on("pageerror", lambda error: browser_errors.append(str(error)))
        page.set_content(html, wait_until="load")
        page.wait_for_timeout(150)
        check("Default view renders all 16 highlights", page.locator(".node").count() == 16)
        check("Initial biography is Murray", page.locator("#biography-title").inner_text() == "James Dickson Murray")
        heading = page.locator(".section-header").bounding_box()
        check("Compact heading height at desktop", heading["height"] <= 40)
        check("Exactly one semantic main heading", page.locator("h1").count() == 1)
        check("No return button in rendered DOM", page.locator("#reset-view").count() == 0)
        check("No large title, subtitle, or edition badge", page.locator(".page-header,.intro,.edition-badge").count() == 0)
        check("Name is the first sidebar element", page.locator(".biography-heading > :first-child").get_attribute("id") == "biography-title")

        page.locator('[data-view="all"]').click()
        check("All view still renders 48 nodes and 54 edges", page.locator(".node").count() == 48 and page.locator(".graph-edge").count() == 54)
        forbidden = ".detail-kicker,.person-dates,.connection-facts,.detail-disclosure,.relation-list,.boundary-note,.trace-button,h3,details"
        for person in data["people"]:
            node = page.locator(f'.node[data-id="{person["id"]}"]')
            node.focus()
            page.keyboard.press("Enter")
            details = page.locator("#person-panel")
            expected_links = len(person.get("reading", []))
            ok = (page.locator("#biography-title").inner_text() == person["name"]
                  and details.locator(".person-description").count() == 1
                  and details.locator(".person-description").inner_text() == person["description"]
                  and details.locator(".reading-links a").count() == expected_links
                  and details.locator(forbidden).count() == 0)
            check("Biography-only panel: " + person["id"], ok)
        check("Biography links use safe external-link attributes", page.locator(".reading-links a").evaluate_all("els => els.every(e => e.target === '_blank' && e.rel.includes('noopener') && e.rel.includes('noreferrer'))"))

        page.locator('[data-view="highlights"]').click()
        page.locator('.node[data-id="jacobi"]').focus()
        page.keyboard.press("Enter")
        initial_bio = page.locator("#person-panel").inner_text()
        page.locator("#route-toggle").click()
        check("Route highlighting moved to map controls", page.locator("#route-toggle").get_attribute("aria-pressed") == "true" and page.locator(".graph-edge.active").count() > 0)
        check("Route toggle does not clutter the biography", page.locator("#person-panel").inner_text() == initial_bio)
        page.keyboard.press("Escape")
        check("Escape clears route highlighting", page.locator("#route-toggle").get_attribute("aria-pressed") == "false")

        edge = next(e for e in data["layouts"]["highlights"]["edges"] if len(e["paths"]) > 1)
        page.locator(f'.graph-edge[data-edge="{edge["key"]}"]').focus()
        page.keyboard.press("Enter")
        check("Collapsed connection opens a separate dialog", page.locator("#connection-dialog").evaluate("e=>e.open"))
        check("Opening a connection leaves the biography unchanged", page.locator("#person-panel").inner_text() == initial_bio)
        check("Complete original path appears in the dialog", page.locator("#connection-details .chain li").count() == len(edge["paths"][0]))
        check("Connection sources retained in dialog", page.locator("#connection-details .detail-source").count() > 0)
        page.get_by_role("button", name="Next included path", exact=True).click()
        check("Alternate collapsed paths remain available", page.locator(".path-switch span").inner_text().startswith("Path 2") and page.locator("#connection-details .chain li").count() == len(edge["paths"][1]))
        name = page.locator("#connection-details .chain button").nth(1).inner_text()
        person = next(x for x in data["people"] if x["label"] == name)
        page.locator("#connection-details .chain button").nth(1).click()
        check("Selecting a chain member opens their biography and closes the dialog", not page.locator("#connection-dialog").evaluate("e=>e.open") and page.locator("#biography-title").inner_text() == person["name"])

        page.locator('[data-view="highlights"]').click()
        page.locator(".graph-edge.collapsed").first.focus()
        page.keyboard.press("Enter")
        page.locator("#connection-details .primary-button").click()
        check("Dialog expansion shows all connections", page.locator(".node").count() == 48 and not page.locator("#connection-dialog").evaluate("e=>e.open"))

        search = page.locator("#person-search")
        search.fill("mobius")
        check("Search remains accent-insensitive", page.locator("#result-mobius").is_visible())
        search.press("ArrowDown")
        search.press("Enter")
        check("Keyboard search opens a biography", page.locator("#biography-title").inner_text() == "August Ferdinand Möbius")
        search.fill("nonexistent-xyz")
        check("Empty search results handled", page.locator(".no-results").is_visible())
        search.press("Escape")
        search.fill("")

        page.locator('[data-view="recent"]').click()
        check("Close family still contains four people", page.locator(".node").count() == 4)
        page.locator('.node[data-id="samuel"]').focus()
        page.keyboard.press("Enter")
        check("Route button disabled at the starting person", page.locator("#route-toggle").is_disabled())
        page.locator("#zoom-in").click()
        before = page.locator("#zoom-level").inner_text()
        page.locator("#zoom-out").click()
        check("Zoom controls work", page.locator("#zoom-level").inner_text() != before)
        before = page.locator("#graph-world").get_attribute("transform")
        page.locator("#genealogy-map").focus()
        page.keyboard.press("ArrowLeft")
        check("Keyboard panning works", page.locator("#graph-world").get_attribute("transform") != before)
        page.locator("#fit-view").click()
        check("Fit keeps the four-person view", page.locator(".node").count() == 4)
        page.locator("#list-toggle").click()
        check("Alternative list view works", page.locator("#people-list tr").count() == 4 and page.locator("#list-shell").is_visible())
        page.locator("#people-list tr[data-id='baker'] button").click()
        check("List selection opens the simplified biography", page.locator("#biography-title").inner_text() == "Ruth Elizabeth Baker" and page.locator("#person-panel h3").count() == 0)
        page.locator("#list-toggle").click()

        page.locator("[data-open-sources]").first.click()
        check("Global sources still open", page.locator("#sources-dialog").evaluate("e=>e.open"))
        page.locator(".record-notes > summary").click()
        check("Individual source notes retained outside the sidebar", page.locator("#record-notes .source-item").count() == 48)
        page.locator("#close-sources").click()

        page.evaluate("""() => {
          window.__blobs=[];
          URL.createObjectURL = blob => { window.__blobs.push(blob); return 'blob:test'; };
          URL.revokeObjectURL = () => {};
          const original = HTMLAnchorElement.prototype.click;
          HTMLAnchorElement.prototype.click = function() { if(!this.href.startsWith('blob:')) original.call(this); };
        }""")
        page.locator("#export-data").click()
        exported = json.loads(page.evaluate("() => window.__blobs.at(-1).text()"))
        check("JSON export contains all original records", len(exported["people"]) == 48 and len(exported["links"]) == 54)
        page.locator("#export-svg").click()
        svg_text = page.evaluate("() => window.__blobs.at(-1).text()")
        svg_root = ET.fromstring(svg_text)
        svg_nodes = [e for e in svg_root.iter() if "node" in e.get("class", "").split()]
        markers = [m for e in svg_root.iter() for m in re.findall(r"marker-end:\s*url\((.*?)\)", e.get("style", ""))]
        check("SVG export produced a self-contained four-person drawing", len(svg_nodes) == 4 and bool(markers) and all(m.strip("\"'").startswith("#arrow-") for m in markers), f"{len(svg_nodes)} nodes; markers={markers}")

        for width in (320, 390, 650, 768, 1024, 1500):
            page.set_viewport_size({"width": width, "height": 950})
            page.set_content(html, wait_until="load")
            page.wait_for_timeout(120)
            no_overflow = page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
            check(f"No horizontal page overflow at {width}px", no_overflow)
            heading = page.locator(".section-header").bounding_box()
            check(f"Compact heading at {width}px", heading["height"] <= 44)

        context = browser.new_context(viewport={"width":390,"height":844}, is_mobile=True, has_touch=True)
        mobile = context.new_page()
        mobile.route("**/*", lambda route: route.abort())
        mobile.on("pageerror", lambda error: browser_errors.append(str(error)))
        mobile.set_content(html, wait_until="load")
        mobile.wait_for_timeout(150)
        check("Mobile biography hidden until a selection", not mobile.locator("#person-panel").is_visible())
        mobile.locator("#person-search").fill("jacobi")
        mobile.locator("#result-jacobi").tap()
        mobile.wait_for_timeout(200)
        check("Touch selection opens a name-first biography", mobile.locator("#person-panel").is_visible() and mobile.locator("#biography-title").inner_text() == "Carl Gustav Jacob Jacobi")
        check("Mobile panel contains no removed detail sections", mobile.locator("#person-panel").locator(forbidden).count() == 0)
        bounds = mobile.locator("#person-panel").bounding_box()
        check("Short mobile biography scrolls fully into view", bounds["y"] >= -1 and bounds["y"] + bounds["height"] <= 846, str(bounds))
        mobile.get_by_role("button", name="Close biography", exact=True).tap()
        check("Mobile biography closes", not mobile.locator("#person-panel").is_visible())
        check("No browser JavaScript exceptions", not browser_errors, "; ".join(browser_errors))
        browser.close()

    # Test installer safety using a temporary, never-published website folder.
    with tempfile.TemporaryDirectory() as directory:
        target = Path(directory)
        homepage = '<!doctype html><title>Existing website</title><div class="hero-links"><a href="genealogy.html" class="btn">Academic genealogy</a></div>'
        (target / "index.html").write_text(homepage)
        command = [sys.executable, str(ROOT / "tools/install.py"), str(target)]
        result = subprocess.run(command, capture_output=True, text=True)
        check("Installer dry run writes nothing", result.returncode == 0 and not (target / "genealogy.html").exists())
        result = subprocess.run(command + ["--apply"], capture_output=True, text=True)
        check("Installer applies the five required files", result.returncode == 0 and (target / "assets/genealogy.js").is_file())
        check("Installer preserves an already-linked homepage", (target / "index.html").read_text() == homepage)
        (target / "genealogy.html").write_text("previous version")
        result = subprocess.run(command + ["--apply"], capture_output=True, text=True)
        check("Installer refuses unapproved overwrite", result.returncode != 0 and (target / "genealogy.html").read_text() == "previous version")
        result = subprocess.run(command + ["--apply", "--overwrite"], capture_output=True, text=True)
        check("Explicit overwrite installs the revision", result.returncode == 0 and (target / "genealogy.html").read_text() == split)
        result = subprocess.run(command + ["--apply", "--overwrite"], capture_output=True, text=True)
        check("Installer is idempotent", result.returncode == 0 and (target / "index.html").read_text() == homepage)

if __name__ == "__main__":
    failure = None
    try:
        run()
    except Exception as error:
        failure = str(error)
        if not results or results[-1]["passed"]:
            results.append({"name":"Test runner completed", "passed":False, "detail":failure})
    output = {"revision":3,"tested_at":datetime.now(timezone.utc).isoformat(), "passed":sum(r["passed"] for r in results),"total":len(results),"results":results}
    (ROOT / "test-results.json").write_text(json.dumps(output, indent=2) + "\n")
    print(f"{output['passed']}/{output['total']} checks passed.")
    if failure:
        print(failure, file=sys.stderr)
        raise SystemExit(1)
