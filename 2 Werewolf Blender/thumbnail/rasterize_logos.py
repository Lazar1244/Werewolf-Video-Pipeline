"""Rasterize the downloaded logo SVGs (logos/*.svg) to 1024 px transparent PNGs with headless Microsoft Edge.
Edge draws them exactly as a browser does (Gemini's blurred colour blobs, masks, filters), which Blender's SVG import
cannot. Output: <out folder>/<lab>.png, then run prep_logos.py on that folder.

    python thumbnail/rasterize_logos.py <out folder>
"""
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
LABS = ("openai", "claude", "gemini", "grok", "deepseek", "qwen", "meta")  # deepseek: Game 2 (2026-10-23); qwen, meta: Game 3 (2026-10-28)


def main(out):
    os.makedirs(out, exist_ok=True)
    work = tempfile.mkdtemp(prefix="logos_")
    for lab in LABS:
        svg = os.path.join(HERE, "logos", f"{lab}.svg").replace("\\", "/")
        page = os.path.join(work, f"{lab}.html")
        with open(page, "w", encoding="utf-8") as fh:
            fh.write("<!doctype html><html><head><style>html,body{margin:0;background:transparent}"
                     "img{display:block;width:1024px;height:1024px;object-fit:contain}</style></head>"
                     f'<body><img src="file:///{svg}"></body></html>')
        subprocess.run([EDGE, "--headless", "--disable-gpu", "--hide-scrollbars", f"--user-data-dir={os.path.join(work, 'profile')}",
                        "--allow-file-access-from-files", "--default-background-color=00000000", "--window-size=1024,1024",
                        f"--screenshot={os.path.join(out, lab + '.png')}", "file:///" + page.replace("\\", "/")], check=False)
        print(lab, os.path.exists(os.path.join(out, lab + ".png")))


if __name__ == "__main__":
    main(sys.argv[1])
