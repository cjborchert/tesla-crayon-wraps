"""Builds the site from src/: index.html (single self-contained file), sw.js, manifest and icons.

    python3 build.py

Settings in site.json: {"site_url": "https://<user>.github.io/<repo>/", "repo_url": "https://github.com/<user>/<repo>"}
"""
import hashlib, json, pathlib, shutil

ROOT = pathlib.Path(__file__).parent
SRC = ROOT / "src"
cfg = json.loads((ROOT / "site.json").read_text()) if (ROOT / "site.json").exists() else {}
site, repo = cfg.get("site_url", ""), cfg.get("repo_url", "")

html = (SRC / "app.html").read_text()
engine = (SRC / "engine.js").read_text()
assert "</script" not in engine.lower()
html = html.replace("/*__ENGINE__*/", engine)
html = html.replace("__SITE_LINE__", f' Go to <a href="{site}">{site}</a>.' if site else "")
html = html.replace("__SOURCE_LINK__", f' <a href="{repo}" target="_blank" rel="noopener">Source on GitHub</a>.' if repo else "")
(ROOT / "index.html").write_text(html)

version = hashlib.sha1(html.encode()).hexdigest()[:10]
(ROOT / "sw.js").write_text((SRC / "sw.js").read_text().replace("__VERSION__", version))
shutil.copy(SRC / "manifest.webmanifest", ROOT / "manifest.webmanifest")
print(f"built index.html ({len(html):,} bytes), sw.js (cache {version})")
