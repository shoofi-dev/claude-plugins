"""
Prepare a promo-reel work folder: the brand font and icon (from the shoofi-app checkout) and
Shadi's poses with a transparent background (from the guided-reel skill's blue-screen PNGs).

    python3 -I prep.py <work>

Writes <work>/assets/{me.ttf, shoofi-icon.png, shadi-stand.png, shadi-point.png} and creates
<work>/{img,clips,specs,out}. Specs in <work>/specs refer to them as ../assets/…, ../img/….
SHOOFI_APP=<path> if the app is not at ~/Documents/project/shoofi/shoofi-app.
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent
POSES = SKILL.parent / "guided-reel" / "assets" / "shadi"
APP = Path(os.environ.get("SHOOFI_APP", Path.home() / "Documents/project/shoofi/shoofi-app"))
KEY = "colorkey=0x0000FF:0.34:0.10,despill=type=blue,format=rgba"


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    work = Path(sys.argv[1]).resolve()
    for d in ("assets", "img", "clips", "specs", "out"):
        (work / d).mkdir(parents=True, exist_ok=True)
    a = work / "assets"
    shutil.copy(APP / "assets/fonts/middleeast/MiddleEast-Regular.ttf", a / "me.ttf")
    shutil.copy(APP / "assets/icon.png", a / "shoofi-icon.png")
    for pose in ("stand", "point"):
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(POSES / f"{pose}.png"), "-vf", KEY, str(a / f"shadi-{pose}.png")], check=True)
    print(f"ready: {work}")


if __name__ == "__main__":
    main()
