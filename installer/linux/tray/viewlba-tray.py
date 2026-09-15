#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ============================================================================
# viewlba-tray — Bandeja del sistema para ViewLBA Server (Linux)
#
# MISIÓN (pedida por el usuario): «un icono PERMANENTE en la barra de tareas
# como indicador de que está activo y que al hacer clic sobre él salgan
# opciones de iniciar, detener y configurar».
#
#   · Icono en la bandeja (StatusNotifier/AppIndicator en GNOME/KDE/MATE/
#     XFCE/Cinnamon; fallback Gtk.StatusIcon en escritorios clásicos):
#       VERDE  = servidor EN EJECUCIÓN (activo)
#       ROJO   = servidor DETENIDO
#       AMARILLO = arrancando / deteniendo / transición
#     Los iconos de color vienen del tema hicolor (viewlba-running/-stopped/
#     -waiting — los instala el .deb); si no existen, usa el icono del
#     producto (viewlba).
#   · Clic derecho → Iniciar servidor · Detener servidor · Reiniciar ·
#                    Configurar… · Abrir Panel · Estado · Salir
#   · «Configurar…» abre una ventana de control (estado en vivo, URL del
#     panel, credenciales, carpetas y control del servicio).
#   · Refresco automático cada 5 s (systemctl is-active).
#
# Requisitos: python3 + PyGObject (python3-gi) — presente en todo
# escritorio Linux estándar. Sin escritorio/bandeja: sale con mensaje
# claro (los servicios del servidor NO se ven afectados).
#
# Uso: viewlba-tray            (o desde el menú «ViewLBA — Bandeja»)
#      viewlba-tray --check    (verificación sin GUI: estado de script,
#                               unidad systemd y dependencias)
# ============================================================================

import os
import subprocess
import sys

SERVICE = "pantalla-restaurante.service"
TARGET = "pantalla-restaurante.target"
PANEL_URL = "http://localhost:3000"
APP_NAME = "ViewLBA Server"
APP_DIR = "/opt/pantalla-restaurante"
DATA_DIR = "/var/lib/pantalla-restaurante"
LOG_DIR = "/var/log/pantalla-restaurante"
CRED_FILE = "/opt/viewlba-server/CREDENCIALES.txt"

# Nombres de icono del tema hicolor (instalados por el .deb)
ICON_BY_STATE = {
    "running": "viewlba-running",
    "starting": "viewlba-waiting",
    "stopping": "viewlba-waiting",
    "stopped": "viewlba-stopped",
    "missing": "viewlba-stopped",
}

STATE_LABEL = {
    "running": "Estado: EN EJECUCIÓN",
    "starting": "Estado: iniciando…",
    "stopped": "Estado: DETENIDO",
    "stopping": "Estado: deteniendo…",
    "missing": "Estado: servicio NO instalado",
}


def service_state():
    """Estado del servicio vía systemctl (sin DBus privilegiado)."""
    try:
        r = subprocess.run(
            ["systemctl", "is-active", SERVICE],
            capture_output=True, text=True, timeout=5,
        )
        out = (r.stdout or "").strip().lower()
    except Exception:
        return "missing"
    if r.returncode == 0 and out == "active":
        return "running"
    if out in ("activating", "reloading", "auto-restart"):
        return "starting"
    if out == "deactivating":
        return "stopping"
    # failed / inactive / dead → detenido
    return "stopped"


def run_pkexec(*args):
    """Ejecuta una acción privilegiada vía pkexec (polkit estándar)."""
    try:
        subprocess.Popen(
            ["pkexec", "systemctl", *args],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    except Exception:
        pass


def open_url(url):
    for cmd in (["xdg-open", url], ["gio", "open", url]):
        try:
            subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return
        except FileNotFoundError:
            continue


def open_path(path):
    if os.path.isdir(path):
        open_url(path)
    else:
        show_info("No se encontró: %s" % path)


def show_info(msg):
    """Mensaje por stderr SIEMPRE; por diálogo si hay GTK."""
    sys.stderr.write("viewlba-tray: %s\n" % msg)


# ---------------------------------------------------------------------------
# Modo --check: verificación SIN GUI (lo usa el CI y el diagnóstico manual)
# ---------------------------------------------------------------------------
def self_check():
    """Verificación sin GUI. CRÍTICO: script + unidad systemd + wrapper CLI
    (falla si falta algo). python3-gi es informativo: en un servidor headless
    la bandeja no aplica y el servidor funciona igual."""
    critical = {
        "script": os.path.isfile(__file__),
        "service-unit": os.path.exists("/etc/systemd/system/%s" % SERVICE),
        "cli-wrapper": os.path.exists("/usr/bin/viewlba-server"),
    }
    info = {}
    try:
        import gi  # noqa: F401
        info["python3-gi"] = True
    except Exception:
        info["python3-gi"] = False
    ok = all(critical.values())
    for k, v in sorted(critical.items()):
        print("  %-14s %s" % (k, "OK" if v else "NO (CRÍTICO)"))
    for k, v in sorted(info.items()):
        print("  %-14s %s (informativo — bandeja de escritorio)" % (k, "OK" if v else "NO"))
    return 0 if ok else 1


def main():
    if "--check" in sys.argv:
        return self_check()

    # Sin escritorio → mensaje claro y salida limpia (no romper nada).
    if not os.environ.get("DISPLAY") and not os.environ.get("WAYLAND_DISPLAY"):
        sys.stderr.write(
            "viewlba-tray: sin sesión gráfica (DISPLAY/WAYLAND_DISPLAY) — "
            "la bandeja necesita un escritorio; el servidor sigue corriendo.\n"
        )
        return 0

    try:
        import gi
    except Exception:
        sys.stderr.write(
            "viewlba-tray: falta python3-gi (PyGObject). Instálalo con:\n"
            "  sudo apt install python3-gi gir1.2-appindicator3-0.1\n"
        )
        return 0

    gi.require_version("Gtk", "3.0")
    from gi.repository import Gtk, GLib

    # --- ventana «Configurar…» (centro de control) ---
    def open_config_window(_item=None):
        state = service_state()
        win = Gtk.Window(title="Configurar — %s" % APP_NAME)
        win.set_default_size(500, 420)
        win.set_position(Gtk.WindowPosition.CENTER)

        vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        vbox.set_margin_top(16)
        vbox.set_margin_bottom(16)
        vbox.set_margin_start(16)
        vbox.set_margin_end(16)
        win.add(vbox)

        lbl_state = Gtk.Label()
        lbl_state.set_halign(Gtk.Align.START)
        lbl_state.set_markup(
            "<span size='14000' weight='bold'>%s</span>" % STATE_LABEL.get(state, state)
        )
        vbox.pack_start(lbl_state, False, False, 0)

        lbl_detail = Gtk.Label(
            "Servicio systemd: %s\nPanel (configuración completa): %s"
            % (SERVICE, PANEL_URL)
        )
        lbl_detail.set_halign(Gtk.Align.START)
        vbox.pack_start(lbl_detail, False, False, 0)

        grid = Gtk.Grid(column_spacing=8, row_spacing=8)
        grid.set_margin_top(8)
        vbox.pack_start(grid, False, False, 0)

        def refresh_state():
            s = service_state()
            lbl_state.set_markup(
                "<span size='14000' weight='bold'>%s</span>" % STATE_LABEL.get(s, s)
            )

        def deferred_refresh():
            GLib.timeout_add(1500, lambda: (refresh_state(), False)[1])

        def add_btn(label, row, col, cb):
            b = Gtk.Button.new_with_label(label)
            b.connect("clicked", cb)
            grid.attach(b, col, row, 1, 1)

        add_btn("Iniciar servidor", 0, 0, lambda _b: (run_pkexec("start", TARGET), deferred_refresh()))
        add_btn("Detener servidor", 0, 1, lambda _b: (run_pkexec("stop", TARGET), deferred_refresh()))
        add_btn("Reiniciar servidor", 1, 0, lambda _b: (run_pkexec("restart", TARGET), deferred_refresh()))
        add_btn("Abrir Panel", 1, 1, lambda _b: open_url(PANEL_URL))
        add_btn("Ver credenciales", 2, 0, lambda _b: open_path(CRED_FILE))
        add_btn("Carpeta de datos", 2, 1, lambda _b: open_path(DATA_DIR))
        add_btn("Carpeta del programa", 3, 0, lambda _b: open_path(APP_DIR))
        add_btn("Ver registros (logs)", 3, 1, lambda _b: open_path(LOG_DIR))

        nota = Gtk.Label(
            "Toda la configuración del restaurante (temas, pantallas,\n"
            "licencias, usuarios) se hace desde el Panel web.\n"
            "El servidor se inicia automáticamente con el equipo."
        )
        nota.set_halign(Gtk.Align.START)
        vbox.pack_start(nota, False, False, 8)

        win.connect("destroy", Gtk.main_quit)
        win.show_all()
        win.present()
        return False

    # --- menú de la bandeja ---
    state = service_state()
    m_state = Gtk.MenuItem.new_with_label(STATE_LABEL.get(state, state))
    m_state.set_sensitive(False)
    m_start = None
    m_stop = None
    m_restart = None

    def set_sensitive_by_state():
        s = service_state()
        if s == "running":
            m_start.set_sensitive(False)
            m_stop.set_sensitive(True)
            m_restart.set_sensitive(True)
        elif s == "stopped":
            m_start.set_sensitive(True)
            m_stop.set_sensitive(False)
            m_restart.set_sensitive(False)
        else:
            m_start.set_sensitive(True)
            m_stop.set_sensitive(True)
            m_restart.set_sensitive(False)

    def build_menu():
        nonlocal m_start, m_stop, m_restart
        menu = Gtk.Menu()

        def item(label, cb=None):
            m = Gtk.MenuItem.new_with_label(label)
            if cb:
                m.connect("activate", cb)
            menu.append(m)
            return m

        def sep():
            menu.append(Gtk.SeparatorMenuItem())

        m_title = Gtk.MenuItem.new_with_label(APP_NAME)
        m_title.set_sensitive(False)
        menu.append(m_title)
        menu.append(m_state)
        sep()
        m_start = item("Iniciar servidor", lambda _m: run_pkexec("start", TARGET))
        m_stop = item("Detener servidor", lambda _m: run_pkexec("stop", TARGET))
        m_restart = item("Reiniciar servidor", lambda _m: run_pkexec("restart", TARGET))
        sep()
        item("Configurar…", open_config_window)
        item("Abrir Panel (localhost:3000)", lambda _m: open_url(PANEL_URL))
        sep()
        item("Salir (cierra solo la bandeja; el servidor sigue)",
             lambda _m: Gtk.main_quit())
        menu.show_all()
        return menu

    menu = build_menu()
    set_sensitive_by_state()

    # --- bandeja: AppIndicator (StatusNotifier) con fallback StatusIcon ---
    tray = None
    try:
        try:
            gi.require_version("AyatanaAppIndicator3", "0.1")
            from gi.repository import AyatanaAppIndicator3 as AppIndicator
        except (ValueError, ImportError):
            gi.require_version("AppIndicator3", "0.1")
            from gi.repository import AppIndicator3 as AppIndicator

        indicator = AppIndicator.Indicator.new(
            "viewlba-tray", ICON_BY_STATE.get(state, "viewlba"),
            AppIndicator.IndicatorCategory.APPLICATION_STATUS,
        )
        indicator.set_status(AppIndicator.IndicatorStatus.ACTIVE)
        indicator.set_title(APP_NAME)
        indicator.set_menu(menu)
        tray = indicator

        def set_icon(state_now):
            indicator.set_icon(ICON_BY_STATE.get(state_now, "viewlba"))
    except Exception:
        # Fallback: Gtk.StatusIcon (escritorios clásicos)
        tray = Gtk.StatusIcon.new_from_icon_name(ICON_BY_STATE.get(state, "viewlba"))
        tray.set_title(APP_NAME)
        tray.set_tooltip_text(APP_NAME)
        tray.connect(
            "popup-menu",
            lambda ic, button, time: menu.popup(None, None, None, None, button, time),
        )
        tray.connect("activate", lambda ic: open_config_window())

        def set_icon(state_now):
            tray.set_from_icon_name(ICON_BY_STATE.get(state_now, "viewlba"))

    # --- refresco cada 5 s: icono + etiqueta + sensibilidad ---
    def tick():
        s = service_state()
        try:
            set_icon(s)
        except Exception:
            pass
        m_state.set_label(STATE_LABEL.get(s, s), None)
        set_sensitive_by_state()
        return True  # repetir

    GLib.timeout_add_seconds(5, tick)
    tick()

    Gtk.main()
    return 0


if __name__ == "__main__":
    sys.exit(main())
