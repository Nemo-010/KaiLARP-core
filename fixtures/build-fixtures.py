#!/usr/bin/env python3
"""Build the .zip fixtures the way a B2G/KaiOS toolchain does.

An app package is `application.zip` containing manifest.webapp plus the app
assets, sitting next to `update.webapp` (the descriptor GitLab dumps publish).
"""
import json
import pathlib
import shutil
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent


def build(app_dir: pathlib.Path) -> pathlib.Path:
    src = app_dir / "src"
    update_webapp = app_dir / "update.webapp"
    manifest = json.loads(update_webapp.read_text())
    out = app_dir / "application.zip"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.webapp", json.dumps(manifest, indent=2))
        for f in sorted(src.rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(src).as_posix())
    print(f"built {out.relative_to(ROOT)} ({out.stat().st_size} bytes, {len(zipfile.ZipFile(out).namelist())} entries)")
    return out


def vendor_dump_snapshot() -> None:
    """Copy the verified F491H runtime files next to the runtime profile."""
    src = pathlib.Path("/tmp/jio")
    dst = ROOT / "f491h"
    dst.mkdir(exist_ok=True)
    take = {
        "application.ini": "application.ini",
        "platform.ini": "platform.ini",
        "ua-update.json": "ua-update.json",
        "dependentlibs.list": "dependentlibs.list",
        "customization.json": "customization.json",
        "deviceconfig.json": "deviceconfig.json",
        "youtube.com_update.webapp": "youtube.update.webapp",
    }
    for a, b in take.items():
        p = src / a
        if p.exists():
            shutil.copyfile(p, dst / b)
    # settings.json is ~486 KiB upstream and was truncated by the sandbox proxy,
    # so keep only the entries the shim actually reads at boot.
    sample = {
        "deviceinfo.model": "F491H",
        "deviceinfo.kaios.version": "2.5.3.2",
        "deviceinfo.platform_version": "48.0a2",
        "deviceinfo.buildid": "20230831153742",
        "network.4g.ui": 1,
        "bluetooth.enabled": False,
        "browser.homepage.url": "https://dumps.tadiphone.dev/",
        "language.current": "en-IN",
        "time.timezone": "Asia/Kolkata",
        "ums.enabled": False,
        "ril.data.enabled": True,
    }
    (dst / "settings.sample.json").write_text(json.dumps(sample, indent=2) + "\n")
    print(f"vendored dump snapshot into {dst.relative_to(ROOT)}")


if __name__ == "__main__":
    for name in ("demo", "denied"):
        build(ROOT / "apps" / name)
    vendor_dump_snapshot()
