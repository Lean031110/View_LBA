#!/usr/bin/env python3
"""
Vectoriza el wordmark del logo de ViewLBA (public/logo.svg).

Problema que resuelve:
  Los <text> del SVG dependen de fuentes del sistema (Inter, Segoe UI, Arial…).
  Al renderizar vía <img> (navegador, favicon, GitHub README, Smart TVs) NO se
  pueden cargar fuentes externas → el wordmark cambia de forma según el equipo.

Solución:
  Sustituye cada <text> por <path> (trazados) generados con fontTools a partir
  de Liberation Sans Bold (métricamente compatible con Arial, el último
  fallback declarado en el diseño original) → renderizado IDÉNTICO en
  cualquier visor, sin fuentes.

Ejecución:  python3 scripts/make-logo-vector.py   (idempotente: re-genera)
"""
import re
import sys
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.misc.transform import Transform

ROOT = "/home/z/my-project"
FONT_PATH = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"

font = TTFont(FONT_PATH)
UPM = font["head"].unitsPerEm
CMAP = font.getBestCmap()
GLYPHS = font.getGlyphSet()
HMTX = font["hmtx"]


def text_to_path(text: str, x: float, y: float, size: float, letter_spacing: float):
    """Trazado SVG del texto con baseline en (x, y). Devuelve (d, advance_end)."""
    scale = size / UPM
    ls_units = letter_spacing / scale  # spacing en unidades de fuente
    pen_x = x / scale
    parts = []
    for ch in text:
        gname = CMAP.get(ord(ch))
        if gname is None:
            sys.exit(f"✗ glifo no encontrado en la fuente: {ch!r}")
        if ch != " ":
            pen = SVGPathPen(GLYPHS)
            tpen = TransformPen(pen, Transform(scale, 0, 0, -scale, pen_x * scale, y))
            GLYPHS[gname].draw(tpen)
            cmds = pen.getCommands()
            if cmds:
                parts.append(cmds)
        pen_x += HMTX[gname][0] + ls_units
    return " ".join(parts), pen_x * scale


def main() -> None:
    svg_path = f"{ROOT}/public/logo.svg"
    with open(svg_path, encoding="utf-8") as f:
        svg = f.read()

    # ---- Wordmark: "View" (blanco) + "LBA" (gradiente) — baseline y=266 ----
    d_view, end_view = text_to_path("View", 452, 266, 248, 2)
    d_lba, _ = text_to_path("LBA", end_view, 266, 248, 2)

    # ---- Tagline — baseline y=340 ----
    d_tag, _ = text_to_path("SEÑALIZACIÓN DIGITAL", 462, 340, 40, 15)

    wordmark = (
        "  <!-- Wordmark (trazados vectoriales: renderizado idéntico sin fuentes) -->\n"
        f'  <path d="{d_view}" fill="#FFFFFF" aria-hidden="true"/>\n'
        f'  <path d="{d_lba}" fill="url(#vlba-grad-text)" aria-hidden="true"/>\n'
        "  <title>ViewLBA</title>\n"
    )
    tagline = (
        "  <!-- Tagline (trazado vectorial) -->\n"
        f'  <path d="{d_tag}" fill="#8B8D98" aria-hidden="true"/>\n'
    )

    # Sustituir los bloques <text>…</text> (DOTALL) por los trazados
    texts = re.findall(r"[ \t]*<text\b.*?</text>\n", svg, flags=re.DOTALL)
    if len(texts) != 2:
        sys.exit(f"✗ se esperaban 2 bloques <text> en logo.svg, hay {len(texts)}")

    svg = svg.replace(texts[0], wordmark)
    svg = svg.replace(texts[1], tagline)

    with open(svg_path, "w", encoding="utf-8") as f:
        f.write(svg)

    n_view = d_view.count("M")
    n_lba = d_lba.count("M")
    n_tag = d_tag.count("M")
    print(f"✓ logo.svg vectorizado: View ({n_view} contornos) · LBA ({n_lba} contornos) · "
          f"tagline ({n_tag} contornos)")
    print(f"  ancho wordmark: 452 → {end_view:.0f} (viewBox 1640)")


if __name__ == "__main__":
    main()
