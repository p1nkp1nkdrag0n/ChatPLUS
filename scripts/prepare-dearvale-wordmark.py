"""Build an independent vector wordmark from the bundled OFL font outlines.

Requires fonttools and brotli. No raster reference is altered or embedded.
"""
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen

root = Path(__file__).resolve().parents[1]
font = TTFont(root / "apps/web/public/dearvale/fonts/cormorant-garamond-004.woff2")
if "fvar" in font:
    font = instantiateVariableFont(font, {"wght": 500})
glyphs = font.getGlyphSet()
mapping = font.getBestCmap()
cursor = 0
paths = []
top = 0
bottom = 0
for character in "Dearvale":
    glyph = glyphs[mapping[ord(character)]]
    pen = SVGPathPen(glyphs)
    glyph.draw(pen)
    bounds = BoundsPen(glyphs)
    glyph.draw(bounds)
    if bounds.bounds:
        top = max(top, bounds.bounds[3])
        bottom = min(bottom, bounds.bounds[1])
    paths.append((cursor, pen.getCommands()))
    cursor += glyph.width - 7
pad = 48
height = top - bottom + pad * 2 + 35
shapes = "\n".join(f'<path transform="translate({x+pad} {top+pad}) scale(1 -1)" d="{d}"/>' for x, d in paths)
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {cursor+pad*2} {height}" role="img" aria-label="Dearvale">
<title>Dearvale</title>
<defs><filter id="shadow" x="-10%" y="-20%" width="120%" height="160%"><feDropShadow dx="0" dy="16" stdDeviation="15" flood-color="#163125" flood-opacity=".42"/></filter></defs>
<g fill="#103d2b" stroke="#e6b84d" stroke-width="13" stroke-linejoin="round" paint-order="stroke fill" filter="url(#shadow)">
{shapes}
</g></svg>'''
destination = root / "apps/web/public/dearvale/art/wordmark.svg"
destination.write_text(svg, encoding="utf-8")
print(f"Vector wordmark: {destination} ({cursor+pad*2} x {height})")
