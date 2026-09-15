#!/usr/bin/env python3
"""Derive PI-Desktop platform icon resources from the canonical logo.

The tracked ``apps/desktop/build/icon_1024.png`` file is the brand source of
truth. This script preserves that file and emits:

  apps/desktop/build/icon.iconset/  - all macOS iconset sizes
  apps/desktop/build/icon.icns      - via `iconutil` (macOS only)
  apps/desktop/build/icon.ico       - multi-size Windows application icon
  apps/desktop/build/icon.png       - 512px Windows/Linux package icon
  apps/desktop/build/tray-icon-mac.png - transparent macOS template icon

Run: python3 scripts/make-icon.py
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "apps" / "desktop" / "build"
SOURCE = BUILD / "icon_1024.png"

BASE = 1024


def main() -> None:
    if not SOURCE.is_file():
        raise FileNotFoundError(f"canonical logo is missing: {SOURCE}")

    with Image.open(SOURCE) as source:
        master = source.convert("RGBA")
    if master.size != (BASE, BASE):
        raise ValueError(
            f"canonical logo must be {BASE}x{BASE}, got {master.width}x{master.height}"
        )

    BUILD.mkdir(parents=True, exist_ok=True)
    windows_icon = BUILD / "icon.ico"
    master.save(
        windows_icon,
        format="ICO",
        sizes=[
            (16, 16),
            (32, 32),
            (48, 48),
            (64, 64),
            (128, 128),
            (256, 256),
        ],
    )
    package_icon = BUILD / "icon.png"
    master.resize((512, 512), Image.LANCZOS).save(package_icon)

    # macOS menu bar icons are template images: the system tints the opaque
    # pixels, so the tray asset has to be a transparent monochrome silhouette.
    # Deriving that from the alpha channel keeps this independent of the
    # artwork, which the previous hardcoded crop was not.
    alpha = master.getchannel("A")
    if alpha.getbbox() is None:
        raise ValueError("canonical logo is fully transparent")
    tray_alpha = alpha.point(lambda value: 255 if value >= 24 else 0)
    tray_icon_mac = Image.new("RGBA", master.size, (0, 0, 0, 0))
    tray_icon_mac.putalpha(tray_alpha)
    mark_bounds = tray_alpha.getbbox()
    if mark_bounds is None:
        raise ValueError("canonical logo does not contain an opaque mark")
    mark = tray_icon_mac.crop(mark_bounds)
    side = max(mark.size)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(mark, ((side - mark.width) // 2, (side - mark.height) // 2))
    inset = BASE // 8
    tray_icon_mac = Image.new("RGBA", master.size, (0, 0, 0, 0))
    scaled = square.resize((BASE - inset * 2, BASE - inset * 2), Image.LANCZOS)
    tray_icon_mac.paste(scaled, (inset, inset), scaled)
    tray_icon_mac_path = BUILD / "tray-icon-mac.png"
    tray_icon_mac.save(tray_icon_mac_path)

    iconset = BUILD / "icon.iconset"
    iconutil = shutil.which("iconutil")
    icns = BUILD / "icon.icns"
    if iconutil is None:
        # Only macOS ships iconutil, so a Windows or Linux checkout still needs
        # a way to produce the bundle icon. Pillow writes a multi-size ICNS
        # anywhere, which keeps the tracked icon.icns in step with the source.
        master.save(
            icns,
            format="ICNS",
            sizes=[(16, 16), (32, 32), (64, 64), (128, 128), (256, 256), (512, 512)],
        )
        print(f"used {SOURCE}")
        print(f"wrote {windows_icon}")
        print(f"wrote {package_icon}")
        print(f"wrote {tray_icon_mac_path}")
        print(f"wrote {icns} (pillow fallback)")
        return

    # iconutil needs a complete iconset directory to build from.
    if iconset.exists():
        shutil.rmtree(iconset)
    iconset.mkdir()
    for size in (16, 32, 128, 256, 512):
        master.resize((size, size), Image.LANCZOS).save(
            iconset / f"icon_{size}x{size}.png"
        )
        master.resize((size * 2, size * 2), Image.LANCZOS).save(
            iconset / f"icon_{size}x{size}@2x.png"
        )

    subprocess.run(
        [iconutil, "-c", "icns", str(iconset), "-o", str(icns)], check=True
    )
    print(f"used {SOURCE}")
    print(f"wrote {windows_icon}")
    print(f"wrote {package_icon}")
    print(f"wrote {tray_icon_mac_path}")
    print(f"wrote {icns}")


if __name__ == "__main__":
    main()
