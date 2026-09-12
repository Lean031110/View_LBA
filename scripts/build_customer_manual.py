#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ViewLBA — Constructor del Manual de Usuario (PDF profesional para CLIENTES).

Misión §25-§27:
  · Español, sencillo, para clientes (NO documentación técnica).
  · Portada con branding + índice + numeración + capturas REALES + pies.
  · 16 capítulos (§26): qué es, instalación, prueba, activación por WhatsApp,
    precios, administración, TV, temas, backup, problemas, seguridad, contacto.

Entradas:
  · /VERSION (única fuente de verdad de la versión).
  · docs/manual/assets/*.png (capturas REALES del sistema + logos).

Salida:
  · dist/manual/ViewLBA-Manual-Usuario-v{VERSIÓN}.pdf

Determinista: mismos assets + misma versión → mismo PDF (CI lo reconstruye).
Fuentes: familia Helvetica integrada de ReportLab (cobertura latin-1 completa
del español — sin dependencias de fuentes del sistema).
"""
import hashlib
import os
import sys

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm
from reportlab.lib.colors import HexColor, white
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY
from reportlab.platypus import (
    BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Image, Table,
    TableStyle, PageBreak, NextPageTemplate, KeepTogether,
)
from PIL import Image as PILImage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERSION = open(os.path.join(ROOT, "VERSION"), encoding="utf-8").read().strip()
BASE_VERSION = VERSION.split("-")[0]
OUT_DIR = os.path.join(ROOT, "dist", "manual")
OUT = os.path.join(OUT_DIR, f"ViewLBA-Manual-Usuario-v{VERSION}.pdf")
ASSETS = os.path.join(ROOT, "docs", "manual", "assets")

# ---- Paleta de marca ViewLBA -------------------------------------------
BG = HexColor("#0b0b0f")        # negro profundo
SURFACE = HexColor("#15151b")
AMBER = HexColor("#f5a623")     # ámbar primario
ACCENT = HexColor("#e8452c")    # acento
INK = HexColor("#1c1c22")       # texto sobre blanco
MUTED = HexColor("#6b6b76")
LINE = HexColor("#e6e2d8")
TIP_BG = HexColor("#fff7e8")
WARN_BG = HexColor("#fdeeee")
OK_GREEN = HexColor("#1d7a4f")

PAGE_W, PAGE_H = A4
MARGIN = 1.9 * cm

# ---- Estilos -------------------------------------------------------------
S = {}
S["h1"] = ParagraphStyle("h1", fontName="Helvetica-Bold", fontSize=19, leading=24, textColor=INK, spaceBefore=0, spaceAfter=6)
S["h2"] = ParagraphStyle("h2", fontName="Helvetica-Bold", fontSize=13, leading=17, textColor=HexColor("#8a5a00"), spaceBefore=14, spaceAfter=4)
S["body"] = ParagraphStyle("body", fontName="Helvetica", fontSize=10.3, leading=15.5, textColor=INK, alignment=TA_JUSTIFY, spaceAfter=7)
S["bodyL"] = ParagraphStyle("bodyL", parent=S["body"], alignment=TA_LEFT)
S["bullet"] = ParagraphStyle("bullet", parent=S["body"], alignment=TA_LEFT, leftIndent=14, bulletIndent=4, spaceAfter=3.5)
S["step"] = ParagraphStyle("step", parent=S["body"], alignment=TA_LEFT, leftIndent=30, bulletIndent=2, spaceAfter=5)
S["caption"] = ParagraphStyle("caption", fontName="Helvetica-Oblique", fontSize=8.7, leading=11, textColor=MUTED, alignment=TA_CENTER, spaceBefore=3, spaceAfter=10)
S["tip"] = ParagraphStyle("tip", fontName="Helvetica", fontSize=9.6, leading=13.5, textColor=HexColor("#5a4a1a"), alignment=TA_LEFT)
S["tipT"] = ParagraphStyle("tipT", parent=S["tip"], fontName="Helvetica-Bold", textColor=HexColor("#8a5a00"))
S["coverT"] = ParagraphStyle("coverT", fontName="Helvetica-Bold", fontSize=30, leading=36, textColor=white, alignment=TA_CENTER)
S["coverS"] = ParagraphStyle("coverS", fontName="Helvetica", fontSize=14, leading=19, textColor=HexColor("#cfc9bd"), alignment=TA_CENTER)
S["coverV"] = ParagraphStyle("coverV", fontName="Helvetica-Bold", fontSize=11.5, leading=15, textColor=AMBER, alignment=TA_CENTER)
S["toc"] = ParagraphStyle("toc", fontName="Helvetica", fontSize=10.6, leading=19, textColor=INK)

CONTACT = "52973387"

# --------------------------------------------------------------------------
# Páginas (fondos, cabeceras, pies con numeración — §27)
# --------------------------------------------------------------------------

def cover_page(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(BG)
    canvas.rect(0, 0, PAGE_W, PAGE_H, stroke=0, fill=1)
    # halo ámbar sutil
    canvas.setFillColor(HexColor("#f5a623"))
    canvas.setFillAlpha(0.06)
    canvas.circle(PAGE_W / 2, PAGE_H * 0.82, PAGE_W * 0.55, stroke=0, fill=1)
    canvas.setFillAlpha(1)
    canvas.restoreState()


def content_page(canvas, doc):
    canvas.saveState()
    # Cabecera: marca + capítulo actual
    canvas.setFillColor(BG)
    canvas.rect(0, PAGE_H - 1.05 * cm, PAGE_W, 1.05 * cm, stroke=0, fill=1)
    canvas.setFillColor(AMBER)
    canvas.rect(0, PAGE_H - 1.13 * cm, PAGE_W, 0.08 * cm, stroke=0, fill=1)
    canvas.setFillColor(white)
    canvas.setFont("Helvetica-Bold", 8.2)
    canvas.drawString(MARGIN, PAGE_H - 0.72 * cm, "ViewLBA")
    canvas.setFont("Helvetica", 8.2)
    canvas.setFillColor(HexColor("#bdb7ab"))
    canvas.drawRightString(PAGE_W - MARGIN, PAGE_H - 0.72 * cm, "Manual de Usuario")
    # Pie: versión + página
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.6)
    canvas.line(MARGIN, 1.25 * cm, PAGE_W - MARGIN, 1.25 * cm)
    canvas.setFont("Helvetica", 8.2)
    canvas.setFillColor(MUTED)
    canvas.drawString(MARGIN, 0.88 * cm, f"ViewLBA v{VERSION}  ·  Contacto: {CONTACT}")
    canvas.setFillColor(INK)
    canvas.setFont("Helvetica-Bold", 9)
    canvas.drawRightString(PAGE_W - MARGIN, 0.88 * cm, f"Página {doc.page}")
    canvas.restoreState()


# --------------------------------------------------------------------------
# Bloques auxiliares
# --------------------------------------------------------------------------

def img(path, width):
    """Imagen con ancho dado (alto proporcional)."""
    with PILImage.open(path) as im:
        w, h = im.size
    return Image(path, width=width, height=width * h / w)


def shot(name, caption, width=None):
    """Captura con marco + pie de foto (§27 capturas)."""
    width = width or (PAGE_W - 2 * MARGIN)
    path = os.path.join(ASSETS, name)
    if not os.path.exists(path):
        return []
    tbl = Table([[img(path, width)]], colWidths=[width])
    tbl.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.8, LINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    return [Spacer(1, 6), tbl, Paragraph(caption, S["caption"])]


def callout(kind, title, text):
    """Recuadro de consejo/aviso (icono tipográfico seguro: ✓ ! ▸ — latin-1/frac)."""
    bg = TIP_BG if kind == "tip" else WARN_BG
    edge = AMBER if kind == "tip" else ACCENT
    mark = "▸" if kind == "tip" else "!"
    head = ParagraphStyle("ch", parent=S["tipT"], textColor=edge)
    rows = [[Paragraph(f"{mark}  {title}", head)], [Paragraph(text, S["tip"])]]
    t = Table(rows, colWidths=[PAGE_W - 2 * MARGIN - 1.2 * cm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("BOX", (0, 0), (-1, -1), 0, bg),
        ("LINEBEFORE", (0, 0), (0, -1), 3, edge),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, 0), 7),
        ("TOPPADDING", (0, 1), (-1, 1), 2),
        ("BOTTOMPADDING", (0, -1), (-1, -1), 8),
    ]))
    return [Spacer(1, 4), t, Spacer(1, 8)]


def chapter(num, title):
    """Cabecera de capítulo con placa numerada + regla ámbar (§27 encabezados)."""
    badge = Table(
        [[Paragraph(f"<b>{num}</b>", ParagraphStyle("b", fontName="Helvetica-Bold", fontSize=15, leading=19, textColor=white, alignment=TA_CENTER))]],
        colWidths=[1.05 * cm], rowHeights=[1.05 * cm],
    )
    badge.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), BG),
        ("BOX", (0, 0), (-1, -1), 0, BG),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    head = Table([[badge, Paragraph(title, S["h1"])]], colWidths=[1.25 * cm, PAGE_W - 2 * MARGIN - 1.25 * cm])
    head.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    rule = Table([[""]], colWidths=[PAGE_W - 2 * MARGIN], rowHeights=[2])
    rule.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, -1), 1.6, AMBER)]))
    return [Spacer(1, 2), head, Spacer(1, 3), rule, Spacer(1, 10)]


def toc_entry(num, title):
    return Paragraph(f"<b>{num:>2}.</b>  {title}", S["toc"])


def bullets(items):
    return [Paragraph(i, S["bullet"], bulletText="•") for i in items]


def steps(items, start=1):
    return [Paragraph(t, S["step"], bulletText=f"<b>{i}</b>") for i, t in enumerate(items, start)]


# --------------------------------------------------------------------------
# Contenido (§26 — 16 capítulos)
# --------------------------------------------------------------------------

def build_story():
    st = []

    # ============ PORTADA ============
    logo_w = 7.2 * cm
    st.append(Spacer(1, PAGE_H * 0.16))
    if os.path.exists(os.path.join(ASSETS, "logo-full.png")):
        st.append(img(os.path.join(ASSETS, "logo-full.png"), logo_w))
        st.append(Spacer(1, 10))
    else:
        st.append(Spacer(1, 90))
    st.append(Spacer(1, PAGE_H * 0.05))
    st.append(Paragraph("Manual de Usuario", S["coverT"]))
    st.append(Spacer(1, 14))
    st.append(Paragraph("Sistema Profesional de Pantalla Digital<br/>para Restaurantes", S["coverS"]))
    st.append(Spacer(1, PAGE_H * 0.30))
    st.append(Paragraph(f"Versión {VERSION}", S["coverV"]))
    st.append(Paragraph(f"Soporte y licencias: {CONTACT}", ParagraphStyle("c", parent=S["coverV"], textColor=HexColor("#cfc9bd"), fontName="Helvetica")))
    st.append(NextPageTemplate("content"))
    st.append(PageBreak())

    # ============ ÍNDICE ============
    st += chapter("i", "Índice")
    st.append(Spacer(1, 6))
    chapters = [
        "¿Qué es ViewLBA?", "¿Qué puede hacer por su restaurante?",
        "Instalación", "Primer arranque",
        "Período de prueba (7 días)", "Activar la licencia completa",
        "Planes y precios", "Administración: guía de secciones",
        "La pantalla TV", "Temas de pantalla",
        "Temas incluidos", "Importar un tema",
        "Copias de seguridad", "Solución de problemas",
        "Seguridad y privacidad", "Contacto",
    ]
    for i, c in enumerate(chapters, 1):
        st.append(toc_entry(i, c))
    st.append(Spacer(1, 16))
    st += callout("tip", "Cómo leer este manual", "Este manual está escrito para el uso diario del restaurante: no necesita "
                 "conocimientos técnicos. Los capítulos 1 a 6 lo llevan de la instalación a la licencia; el resto son "
                 "guías rápidas que puede consultar cuando las necesite.")
    st.append(PageBreak())

    # ============ 1. ¿QUÉ ES VIEWLBA? ============
    st += chapter(1, "¿Qué es ViewLBA?")
    st.append(Paragraph(
        "ViewLBA es un sistema de pantalla digital pensado para restaurantes. Convierte cualquier televisor "
        "con conexión a Internet local en una pantalla profesional: muestra sus promociones, fotos, vídeos, "
        "el plato del día, horarios, redes sociales y mensajes en movimiento, junto con un reloj siempre "
        "visible. Todo se administra desde un panel sencillo en el mismo equipo, sin depender de servicios "
        "externos de pago.", S["body"]))
    st.append(Paragraph(
        "El sistema funciona en la red local de su negocio (LAN). Las televisiones muestran el contenido y "
        "el administrador lo controla desde el panel de administración. Al necesitar únicamente su propia "
        "red, la pantalla sigue funcionando aunque fallen servicios externos, y el contenido se actualiza "
        "al instante en todos los televisores conectados.", S["body"]))
    st += shot("tv-default.png", "Pantalla TV de ViewLBA con el tema predeterminado: reloj, promociones, plato del día, transmisión en vivo y ticker.")
    st += callout("tip", "Lo esencial", "Un equipo (mini PC u ordenador) ejecuta ViewLBA y se conecta a su televisor por HDMI. "
                 "Ese mismo equipo puede transmitir vídeo en vivo desde OBS Studio hacia todas las pantallas.")

    # ============ 2. ¿QUÉ PUEDE HACER? ============
    st += chapter(2, "¿Qué puede hacer por su restaurante?")
    st.append(Paragraph("ViewLBA reúne en una sola pantalla todo lo que un restaurante necesita comunicar:", S["body"]))
    st += bullets([
        "<b>Promociones</b> con foto, precio y duración, mostradas en carrusel automático.",
        "<b>Plato o sugerencia del día</b> con imagen, ingredientes y precio.",
        "<b>Transmisión en vivo</b> (streaming) desde OBS Studio: cocina en directo, eventos o vídeos.",
        "<b>Reloj y fecha</b> siempre visibles, con la zona horaria del restaurante.",
        "<b>Horarios</b> del día (desayuno, almuerzo, cena) resaltados según la hora.",
        "<b>Redes sociales</b> (Facebook, Instagram, TikTok, WhatsApp…) con sus usuarios.",
        "<b> ticker de mensajes</b> en movimiento continuo en la parte inferior.",
        "<b>Mensajes y anuncios</b> que puede cambiar en segundos desde el panel.",
        "<b>Varios televisores</b> a la vez, con la misma o distinta configuración.",
        "<b>Temas visuales</b> para cambiar la apariencia completa de la pantalla (capítulo 10).",
        "<b>Funcionamiento sin Internet</b>: la pantalla sigue mostrando el último contenido si la red falla.",
    ])
    st.append(Paragraph(
        "El audio del contenido y el volumen también se controlan desde el panel, y las pantallas conectadas "
        "se supervisan en tiempo real: puede ver qué TVs están en línea y qué están mostrando.", S["body"]))

    # ============ 3. INSTALACIÓN ============
    st += chapter(3, "Instalación")
    st.append(Paragraph("ViewLBA se instala en el equipo que quedará conectado a la televisión. "
                 "Elija el procedimiento según su sistema operativo:", S["body"]))
    st.append(Paragraph("Windows", S["h2"]))
    st += steps([
        "Descargue el instalador <b>ViewLBA-Server-Setup</b> (archivo .exe) desde el enlace que le entregó su proveedor.",
        "Haga doble clic en el archivo. Si Windows pregunta, permita la ejecución («Más información » Ejecutar de todas formas»).",
        "Siga el asistente: destino, acceso directo e instalar. El proceso crea el servicio de ViewLBA.",
        "Al terminar, abra su navegador en <b>http://localhost:3000</b>. Verá la página de inicio de ViewLBA.",
        "Conecte el equipo a la televisión por HDMI y deje el navegador de la TV en esa dirección.",
    ])
    st += callout("tip", "Requisitos", "Windows 10/11 (64 bits), 4 GB de RAM y un navegador moderno (Chrome o Edge). "
                 "Para transmisiones en vivo se recomienda además OBS Studio (gratuito).")
    st.append(Paragraph("Linux (Debian/Ubuntu)", S["h2"]))
    st += steps([
        "Descargue el paquete <b>ViewLBA-Server</b> (archivo .deb) desde el enlace de su proveedor.",
        "Instale con: <b>sudo dpkg -i ViewLBA-Server-*.deb</b> (el sistema queda registrado como servicio).",
        "Inicie el servicio: <b>sudo systemctl start viewlba</b> y habilítelo al arranque: <b>sudo systemctl enable viewlba</b>.",
        "Compruebe que responde: <b>http://localhost:3000</b> en cualquier navegador del negocio.",
        "Configure el firewall para permitir el puerto 3000 en la red local si usará otras pantallas.",
    ])
    st.append(Paragraph("Docker (opcional)", S["h2"]))
    st.append(Paragraph(
        "Si su proveedor le entrega la imagen Docker, ejecute el contenedor con el puerto 3000 publicado y un volumen "
        "persistente para los datos; después abra http://localhost:3000. El resto del manual es idéntico en Docker, "
        "Windows y Linux.", S["body"]))

    # ============ 4. PRIMER ARRANQUE ============
    st += chapter(4, "Primer arranque")
    st += shot("login.png", "Pantalla de acceso a la Administración (primer inicio).")
    st += steps([
        "Abra <b>http://localhost:3000</b>. Verá la página de inicio con dos accesos: «Pantalla TV» y «Administración».",
        "Entre a <b>Administración</b> con el usuario y la contraseña iniciales que le entregó su proveedor.",
        "En la primera sesión se recomienda cambiar la contraseña (sección Usuarios) y poner el nombre del restaurante (Logotipo).",
        "Abra la pantalla TV: en el televisor, cargue la misma dirección y elija su pantalla (por ejemplo TV Salón Principal) cuando el sistema lo pida. Esa identificación queda guardada: al encender la TV, recupera su identidad.",
        "Cargue su primer contenido: una promoción con foto (sección Promociones) y el plato del día (Sugerencias del Día).",
    ])
    st += callout("tip", "Consejo de instalación física", "Configure el navegador del TV en modo pantalla completa "
                 "(tecla F) y desactive el ahorro de energía/apagado de pantalla del televisor. ViewLBA mantiene la "
                 "pantalla encendida mientras se muestre.")

    # ============ 5. PERÍODO DE PRUEBA ============
    st += chapter(5, "Período de prueba (7 días)")
    st.append(Paragraph(
        "Al instalarse, ViewLBA funciona durante <b>7 días</b> en modo de prueba para que lo conozca con su contenido real. "
        "Durante la prueba:", S["body"]))
    st += bullets([
        "La pantalla TV muestra una <b>marca de agua</b> discreta con el aviso «VERSIÓN DE PRUEBA» y los días restantes.",
        "El contenido funciona con normalidad: promociones, transmisión, reloj, ticker y pantalla TV.",
        "Las funciones de personalización premium (logotipo propio, apariencia y <b>temas de pantalla</b>, usuarios, copias de seguridad manuales) permanecen bloqueadas.",
    ])
    st.append(Paragraph(
        "La marca de agua desaparece al activar la licencia completa (capítulo 6). La licencia se vincula al equipo "
        "donde instaló ViewLBA: no se puede trasladar copiando archivos, y el período de prueba no se reinicia "
        "desinstalando el sistema.", S["body"]))
    st += callout("warn", "Antes de que venza", "Active la licencia antes del séptimo día para no interrumpir el "
                 "uso de las funciones premium. El aviso «Obtenga la licencia completa» muestra el contacto de su proveedor.")

    # ============ 6. ACTIVAR LICENCIA ============
    st += chapter(6, "Activar la licencia completa")
    st.append(Paragraph("La activación es un flujo sencillo de <b>copiar y pegar</b> por WhatsApp. No necesita claves, "
                 "certificados ni conexión a Internet para funcionar (solo para el mensaje de WhatsApp).", S["body"]))
    st += steps([
        "Abra <b>Administración</b> y entre a la sección <b>Licencia</b>.",
        "Escriba el nombre de su negocio y pulse <b>«COPIAR CÓDIGO DE SOLICITUD»</b>. El código (VLREQ2-…) se copia al portapapeles. No contiene datos sensibles.",
        "Envíe ese código a su proveedor por WhatsApp al <b>" + CONTACT + "</b>.",
        "En minutos recibirá un <b>token de licencia</b> (VLBA2-…). Cópialo completo.",
        "Péguelo en el campo «Token de licencia» de la sección Licencia y pulse <b>«ACTIVAR LICENCIA»</b>.",
        "ViewLBA valida el token (firma, equipo y vigencia) y confirma: «Token verificado y válido».",
        "A partir de ese momento la licencia queda <b>ACTIVA</b>: verá el tipo de licencia, la fecha de inicio, la fecha de vencimiento y los días restantes.",
    ])
    st += shot("admin-license.png", "Sección Licencia con la licencia activa: plan, vigencia y días restantes.")
    st += callout("tip", "¿Qué pasa si cambia de equipo o disco?", "La licencia está vinculada a la instalación autorizada. "
                 "Si cambia el equipo o reinstala el sistema en otro disco, escriba a su proveedor: le emitirá una "
                 "licencia nueva para el nuevo equipo. La licencia no se «mueve» copiando archivos: es una protección "
                 "para que solo su negocio la use.")

    # ============ 7. PLANES Y PRECIOS ============
    st += chapter(7, "Planes y precios")
    plan_rows = [
        [Paragraph("<b>Plan</b>", S["bodyL"]), Paragraph("<b>Precio</b>", S["bodyL"]), Paragraph("<b>Duración</b>", S["bodyL"]), Paragraph("<b>Ideal para</b>", S["bodyL"])],
        [Paragraph("Mensual", S["bodyL"]), Paragraph("10 USD", S["bodyL"]), Paragraph("30 días", S["bodyL"]), Paragraph("Negocios que quieren probar el servicio mes a mes", S["bodyL"])],
        [Paragraph("Anual", S["bodyL"]), Paragraph("100 USD", S["bodyL"]), Paragraph("365 días", S["bodyL"]), Paragraph("El plan recomendado: 2 meses de ahorro al año", S["bodyL"])],
    ]
    pt = Table(plan_rows, colWidths=[2.6 * cm, 2.4 * cm, 2.6 * cm, PAGE_W - 2 * MARGIN - 7.6 * cm])
    pt.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), BG),
        ("TEXTCOLOR", (0, 0), (-1, 0), white),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [white, HexColor("#faf6ee")]),
        ("GRID", (0, 0), (-1, -1), 0.6, LINE),
        ("BOX", (0, 0), (-1, -1), 1.1, AMBER),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    # forzar color blanco del encabezado (Paragraph controla su color: rehacer fila 0)
    st.append(pt)
    st.append(Spacer(1, 8))
    st.append(Paragraph(
        "Ambos planes incluyen el producto completo: pantalla TV, transmisión en vivo, temas, usuarios, "
        "copias de seguridad y todas las funciones. La licencia queda vinculada a la instalación autorizada de su "
        "negocio. Para contratar o renovar, escriba a <b>" + CONTACT + "</b> (WhatsApp).", S["body"]))
    st += callout("tip", "Renovación", "Cuando se acerque el vencimiento verá un aviso en el panel. La renovación es el "
                 "mismo flujo del capítulo 6: copiar código, enviarlo por WhatsApp y pegar el token nuevo.")

    # ============ 8. ADMINISTRACIÓN ============
    st += chapter(8, "Administración: guía de secciones")
    st.append(Paragraph("El panel de administración se organiza en secciones claras. Este es un resumen de cada una:", S["body"]))
    admin_rows = [
        ("Dashboard", "Resumen del sistema: estado de las pantallas, transmisión en directo y métricas del negocio."),
        ("Transmisión", "Configuración del video en vivo (OBS): clave de transmisión, proporción y respaldo."),
        ("Promociones", "Alta y edición de ofertas con foto, precio y duración del carrusel."),
        ("Sugerencias del Día", "El plato del día con imagen, ingredientes y precio."),
        ("Horarios", "Franjas del día (desayuno, almuerzo, cena) que se resaltan según la hora."),
        ("Redes Sociales", "Facebook, Instagram, TikTok, WhatsApp… con los iconos en pantalla."),
        ("Ticker", "Los mensajes que corren en la franja inferior de la TV."),
        ("Logotipo", "Logo del restaurante, tamaño y posición en pantalla."),
        ("Audio", "Volumen y silencio del contenido."),
        ("Pantallas", "TVs conectadas: estado en línea, vinculación de nuevas pantallas."),
        ("Apariencia", "Colores, tipografía, animaciones y módulos visibles (licencia completa)."),
        ("Temas de Pantalla", "El gestor de temas visuales (capítulo 10; requiere licencia completa)."),
        ("Usuarios", "Usuarios del panel y roles ( Administrador / Operador / Invitado)."),
        ("Registros", "Historial de acciones para auditoría."),
        ("Licencia", "Estado de la licencia, activación y renovación."),
    ]
    rows = [[Paragraph("<b>Sección</b>", S["bodyL"]), Paragraph("<b>Para qué sirve</b>", S["bodyL"])]]
    for name, desc in admin_rows:
        rows.append([Paragraph(f"<b>{name}</b>", S["bodyL"]), Paragraph(desc, S["bodyL"])])
    at = Table(rows, colWidths=[4.1 * cm, PAGE_W - 2 * MARGIN - 4.1 * cm])
    at.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), BG),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [white, HexColor("#faf6ee")]),
        ("GRID", (0, 0), (-1, -1), 0.5, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 5.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5.5),
    ]))
    st.append(at)

    # ============ 9. PANTALLA TV ============
    st += chapter(9, "La pantalla TV")
    st.append(Paragraph(
        "La pantalla TV es lo que ven sus clientes. Se abre cargando <b>http://localhost:3000</b> en el navegador "
        "del televisor y pulsando «Pantalla TV» (la TV recuerda el modo). Al primer uso, la TV se identifica "
        "eligiendo su nombre en la lista (por ejemplo, «TV Salón Principal»).", S["body"]))
    st += bullets([
        "<b>Pantalla completa:</b> pulse el botón de la esquina o la tecla F; el sistema oculta el cursor solo.",
        "<b>Contenido:</b> promociones en carrusel, plato del día, horario, reloj, redes y ticker.",
        "<b>Transmisión en vivo:</b> el video de OBS ocupa la zona principal; si se corta, aparece un aviso y la pantalla sigue mostrando el resto del contenido.",
        "<b>Actualización al instante:</b> todo lo que cambia en Administración llega a las TVs conectadas en segundos, sin recargar.",
        "<b>Resistencia a fallos:</b> si la red o el servidor fallan, la TV muestra el último contenido conocido con un aviso discreto.",
    ])
    st += shot("tv-default.png", "Pantalla TV en funcionamiento: transmisión en vivo, promociones, plato del día y ticker.")
    st += callout("tip", "Varias televisiones", "Puede conectar todas las que necesite (salón, barra, entrada…). "
                 "Vincule cada TV con su nombre en «Pantallas» y supervise cuáles están en línea desde el panel.")

    # ============ 10. TEMAS ============
    st += chapter(10, "Temas de pantalla")
    st.append(Paragraph(
        "Los temas cambian la apariencia completa de la pantalla TV con un clic: paleta de colores, tipografía, "
        "estilo del reloj y del ticker, animaciones y fondo decorativo. ViewLBA incluye tres temas oficiales y "
        "admite paquetes adicionales en formato <b>.vtheme</b> que su proveedor puede entregarle.", S["body"]))
    st += shot("admin-themes.png", "Gestor de «Temas de Pantalla» en Administración: importar, aplicar y eliminar temas.")
    st += callout("warn", "Requiere licencia completa", "El gestor de temas está disponible con la licencia completa "
                 "(Mensual o Anual). Durante el período de prueba verá el aviso: «Los temas de pantalla están "
                 "disponibles con una licencia completa».")
    st.append(Paragraph("Qué puede hacer desde el gestor:", S["body"]))
    st += bullets([
        "<b>Aplicar</b> un tema con un clic: las TVs conectadas lo reciben al instante.",
        "<b>Importar</b> un paquete .vtheme entregado por su proveedor (capítulo 12).",
        "<b>Eliminar</b> un tema importado (el tema predeterminado no se puede eliminar).",
        "<b>Restaurar el tema predeterminado</b> en cualquier momento.",
        "<b>Vista previa</b> de cada tema antes de aplicarlo (miniatura con su paleta).",
    ])
    st.append(Paragraph(
        "Todo tema es revisado por seguridad antes de instalarse: un tema es puramente visual (declarativo) y "
        "no puede contener código. Si un tema fallara, la pantalla vuelve automáticamente al tema "
        "predeterminado: la TV nunca se queda en blanco.", S["body"]))

    # ============ 11. TEMAS INCLUIDOS ============
    st += chapter(11, "Temas incluidos")
    st.append(Paragraph("<b>ViewLBA Default</b> — el tema de fábrica: sobrio y legible, con acentos ámbar. "
                 "Siempre disponible y no depende de archivos externos.", S["body"]))
    st += shot("tv-classic.png", "Tema ViewLBA Classic: elegante, oscuro y profesional, con acentos dorados.")
    st.append(Paragraph("<b>ViewLBA Classic</b> — elegante y profesional: fondo negro profundo, acentos dorados, "
                 "transiciones suaves y un degradado cálido en la parte superior. Ideal para restaurantes de "
                 "carta y ambiente clásico.", S["body"]))
    st += shot("tv-neon.png", "Tema ViewLBA Neon: moderno y tecnológico, con brillos cian y magenta.")
    st.append(Paragraph("<b>ViewLBA Neon</b> — moderno y tecnológico: brillos cian y magenta, reloj digital con "
                 "efecto neón, ticker oscuro y transiciones con zoom. Perfecto para barras, locales gaming y "
                 "ambiente juvenil.", S["body"]))

    # ============ 12. IMPORTAR UN TEMA ============
    st += chapter(12, "Importar un tema")
    st.append(Paragraph("Si su proveedor le entrega un tema personalizado (archivo <b>.vtheme</b>):", S["body"]))
    st += steps([
        "Abra <b>Administración → Temas de Pantalla</b>.",
        "Pulse <b>«Importar tema (.vtheme)»</b> y seleccione el archivo que recibió.",
        "ViewLBA valida el paquete automáticamente (formato, imágenes y límites de seguridad).",
        "Si todo es correcto, el tema aparece en la lista como <b>Importado</b>.",
        "Pulse <b>Aplicar</b> en el tema nuevo: las pantallas conectadas cambian al instante.",
        "¿No le convence? Pulse <b>Restaurar predeterminado</b> o aplique otro tema: el cambio es inmediato y reversible.",
    ])
    st += callout("warn", "Si el archivo no importa", "El aviso «No se pudo importar el tema» indica que el paquete "
                 "no pasó la validación (archivo dañado, incompatible con su versión o con contenido no permitido). "
                 "Solicite a su proveedor un paquete nuevo; su sistema no queda afectado.")

    # ============ 13. BACKUPS ============
    st += chapter(13, "Copias de seguridad")
    st.append(Paragraph(
        "Desde el Dashboard, con licencia completa, puede crear una <b>copia de seguridad</b> del sistema con un "
        "clic: contenido, configuración y temas quedan guardados en un archivo de base de datos con verificación "
        "de integridad. Es su red de seguridad antes de cambios grandes.", S["body"]))
    st += bullets([
        "<b>Crear:</b> Administración → botón «Copia de seguridad». El sistema confirma integridad y tablas respaldadas.",
        "<b>Guardar:</b> descargue o copie el archivo generado a un lugar seguro (memoria USB o nube de su negocio).",
        "<b>Restaurar:</b> con ayuda de su proveedor, se restaura el archivo y el sistema revalida la licencia y los temas antes de seguir.",
    ])
    st += callout("tip", "Frecuencia recomendada", "Una copia semanal, o antes de cada cambio grande de menú o "
                 "temporada. Guarde al menos dos copias rotativas.")
    st += callout("warn", "Honestidad sobre la licencia", "La copia respalda SU contenido y configuración, no la "
                 "licencia de otra instalación: al restaurar, la licencia se revalida contra el equipo actual.")

    # ============ 14. PROBLEMAS ============
    st += chapter(14, "Solución de problemas")
    probs = [
        ("La TV no conecta o no aparece el contenido",
         "Compruebe que la TV y el equipo están en la misma red y que el navegador carga http://localhost:3000. "
         "Si la TV se identificó antes, pulse el botón de refrescar; si persiste, vuelva a elegir la pantalla (tecla S)."),
        ("El contenido no se actualiza en la TV",
         "Las pantallas conectadas se actualizan solas en segundos. Si una TV no cambia, verifique en "
         "«Pantallas» que aparezca En línea y recargue el navegador de esa TV."),
        ("OBS no transmite / la TV muestra el aviso de transmisión",
         "En OBS revise la clave de transmisión (cópiela desde «Transmisión» en el panel) y que la salida sea "
         "RTMP hacia el servidor local. Al conectar, el panel pasa a EN DIRECTO."),
        ("La licencia no activa",
         "Copie el token COMPLETO (empieza por VLBA2- y termina en el último carácter). Si sigue fallando, "
         "solicite un token nuevo por WhatsApp; el anterior no queda registrado."),
        ("La licencia venció",
         "Renueve con el mismo flujo del capítulo 6. Mientras tanto, el contenido básico sigue funcionando con "
         "el aviso de renovación; sus datos y temas instalados se conservan."),
        ("Un tema no importa",
         "El paquete no pasó la validación de seguridad (capítulo 12). Pida otro archivo a su proveedor."),
        ("Un tema importado se ve dañado o no aplica",
         "Elimínelo desde el gestor y vuelva a importarlo. La pantalla siempre puede volver al tema predeterminado."),
        ("La pantalla se quedó «congelada»",
         "Recargue el navegador de la TV (F5) o apague y encienda el televisor. ViewLBA recupera el último "
         "contenido conocido incluso tras un corte de luz del equipo."),
    ]
    for q, a in probs:
        st.append(KeepTogether([
            Paragraph(f"<b>{q}</b>", ParagraphStyle("q", parent=S["bodyL"], textColor=HexColor("#8a5a00"), spaceBefore=8, spaceAfter=2)),
            Paragraph(a, S["body"]),
        ]))

    # ============ 15. SEGURIDAD ============
    st += chapter(15, "Seguridad y privacidad")
    st += bullets([
        "<b>Funcionamiento local:</b> ViewLBA trabaja en la red de su negocio; el contenido no viaja a servicios externos de publicidad.",
        "<b>Licencia vinculada:</b> la licencia queda unida a la instalación autorizada de su restaurante.",
        "<b>Acceso protegido:</b> el panel exige usuario y contraseña, con bloqueo temporal ante intentos fallidos.",
        "<b>Roles:</b> diferencie Administradores de Operadores para limitar quién cambia ajustes críticos.",
        "<b>Temas revisados:</b> los paquetes de temas se validan antes de instalarse y no pueden contener código.",
        "<b>Copias de seguridad verificadas:</b> cada copia se comprueba antes de confirmarse.",
    ])
    st += callout("tip", "No comparta su token", "El token de licencia es personal para su instalación. "
                 "Compartirlo no activa otras instalaciones (la vinculación lo impide) pero puede exponer datos "
                 "de su contrato. Guárdelo junto a sus copias de seguridad.")
    st.append(Paragraph(
        "Si sospecha un problema de seguridad, contacte de inmediato a su proveedor al " + CONTACT + ".", S["body"]))

    # ============ 16. CONTACTO ============
    st += chapter(16, "Contacto")
    st.append(Paragraph("Para licencias, renovaciones, temas personalizados y soporte:", S["body"]))
    st.append(Spacer(1, 6))
    ct = Table([[Paragraph(f"<b>{CONTACT}</b>", ParagraphStyle("c1", fontName="Helvetica-Bold", fontSize=26, leading=30, textColor=HexColor("#8a5a00"), alignment=TA_CENTER))],
                [Paragraph("WhatsApp · Lun-Sáb · respuesta rápida", ParagraphStyle("c2", fontName="Helvetica", fontSize=10.5, textColor=MUTED, alignment=TA_CENTER))]],
               colWidths=[PAGE_W - 2 * MARGIN])
    ct.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), TIP_BG),
        ("BOX", (0, 0), (-1, -1), 1.1, AMBER),
        ("TOPPADDING", (0, 0), (-1, 0), 14), ("BOTTOMPADDING", (0, -1), (-1, -1), 12),
        ("TOPPADDING", (0, 1), (-1, 1), 2),
    ]))
    st.append(ct)
    st.append(Spacer(1, 14))
    st.append(Paragraph(
        "Gracias por elegir ViewLBA. Este manual corresponde a la versión " + VERSION + " del sistema; si su "
        "proveedor le entrega una versión nueva, solicite el manual actualizado o busque la sección de "
        "novedades con su proveedor.", S["body"]))
    return st


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    doc = BaseDocTemplate(
        OUT, pagesize=A4,
        leftMargin=MARGIN, rightMargin=MARGIN, topMargin=1.55 * cm, bottomMargin=1.6 * cm,
        title="Manual de Usuario ViewLBA",
        author="ViewLBA",
        subject="Sistema Profesional de Pantalla Digital para Restaurantes",
    )
    frame = Frame(MARGIN, 1.6 * cm, PAGE_W - 2 * MARGIN, PAGE_H - 1.55 * cm - 1.6 * cm, id="body")
    doc.addPageTemplates([
        PageTemplate(id="cover", frames=[Frame(0, 0, PAGE_W, PAGE_H, id="coverf")], onPage=cover_page),
        PageTemplate(id="content", frames=[frame], onPage=content_page),
    ])
    doc.build(build_story())

    data = open(OUT, "rb").read()
    sha = hashlib.sha256(data).hexdigest()
    size = len(data)
    if size < 50 * 1024:
        print(f"✗ el PDF es sospechosamente pequeño ({size} bytes)", file=sys.stderr)
        sys.exit(1)
    print(f"✓ {OUT}")
    print(f"  {size} bytes · SHA-256 {sha}")
    print(f"  Versión: {VERSION} · capturas: {sorted(os.listdir(ASSETS))}")


if __name__ == "__main__":
    main()
