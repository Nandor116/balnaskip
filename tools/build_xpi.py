"""Build the installable BálnaSkip XPI.

No machine-specific path lives in this file. The extension folder and the output
folder are read from an env file (``balnaskip.env`` by default), so every
checkout can point at its own locations.

Resolution order for each setting:

1. process environment (``BALNASKIP_EXTENSION_DIR`` / ``BALNASKIP_DIST_DIR``),
2. the env file,
3. a repo-relative default (``extension/`` and ``dist/``).

Relative paths in the env file are resolved from the repository root.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import unicodedata
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ENV_FILE = ROOT / "balnaskip.env"

EXTENSION_DIR_VAR = "BALNASKIP_EXTENSION_DIR"
DIST_DIR_VAR = "BALNASKIP_DIST_DIR"

EXCLUDED_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini"}
EXCLUDED_SUFFIXES = {".pyc", ".pyo", ".swp", ".tmp"}


def parse_env_file(path: Path) -> dict[str, str]:
    """Read simple ``KEY=VALUE`` lines, ignoring blanks and ``#`` comments."""
    if not path.is_file():
        return {}

    values: dict[str, str] = {}
    text = path.read_text(encoding="utf-8-sig")
    for number, raw_line in enumerate(text.splitlines(), 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        key, separator, value = line.partition("=")
        if not separator:
            raise SystemExit(f"{path.name}:{number}: expected KEY=VALUE, got {raw_line!r}")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        values[key] = value
    return values


def setting(name: str, env_file: dict[str, str], default: str) -> str:
    value = os.environ.get(name) or env_file.get(name) or default
    return value.strip()


def resolve_path(value: str) -> Path:
    expanded = Path(os.path.expandvars(os.path.expanduser(value)))
    if not expanded.is_absolute():
        expanded = ROOT / expanded
    return expanded.resolve()


def artifact_prefix(manifest: dict) -> str:
    """``BálnaSkip`` -> ``balnaskip`` so the artifact name is ASCII and stable."""
    raw = manifest.get("short_name") or manifest.get("name") or "extension"
    ascii_name = (
        unicodedata.normalize("NFKD", str(raw)).encode("ascii", "ignore").decode("ascii")
    )
    slug = re.sub(r"[^a-z0-9]+", "", ascii_name.lower())
    return slug or "extension"


def iter_extension_files(extension_dir: Path):
    for base, dirs, files in os.walk(extension_dir):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        for name in sorted(files):
            if name.startswith(".") or name in EXCLUDED_NAMES:
                continue
            if Path(name).suffix.lower() in EXCLUDED_SUFFIXES:
                continue
            path = Path(base) / name
            yield path, path.relative_to(extension_dir).as_posix()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--env",
        type=Path,
        default=DEFAULT_ENV_FILE,
        help=f"env file to read (default: {DEFAULT_ENV_FILE.name})",
    )
    args = parser.parse_args()

    env_file_path = args.env
    if not env_file_path.is_absolute():
        env_file_path = ROOT / env_file_path
    env_file = parse_env_file(env_file_path)

    extension_dir = resolve_path(
        setting(EXTENSION_DIR_VAR, env_file, "extension")
    )
    dist_dir = resolve_path(setting(DIST_DIR_VAR, env_file, "dist"))

    manifest_path = extension_dir / "manifest.json"
    if not manifest_path.is_file():
        if env_file_path == DEFAULT_ENV_FILE:
            hint = (
                f"copy {DEFAULT_ENV_FILE.name}.example to {DEFAULT_ENV_FILE.name} "
                "and fill in your paths"
            )
        else:
            hint = f"set {EXTENSION_DIR_VAR} in {env_file_path.name}"
        raise SystemExit(
            f"manifest.json not found in {extension_dir}\n{hint}."
        )
    with manifest_path.open(encoding="utf-8") as handle:
        manifest = json.load(handle)

    version = manifest["version"]
    dist_dir.mkdir(parents=True, exist_ok=True)
    out = dist_dir / f"{artifact_prefix(manifest)}-{version}.xpi"

    files = list(iter_extension_files(extension_dir))
    if not any(rel == "manifest.json" for _, rel in files):
        raise SystemExit("manifest.json missing from the extension directory")

    out.unlink(missing_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        for path, rel in files:
            archive.write(path, rel)

    print(out)
    print(f"{out.stat().st_size} bytes, {len(files)} files, version {version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
