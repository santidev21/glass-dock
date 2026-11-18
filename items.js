// Elementos del dock: base común, íconos de apps, botón de aplicaciones,
// papelera y separadores.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import {AppMenu} from 'resource:///org/gnome/shell/ui/appMenu.js';

import {
    DOT_AREA, ICON_HI, ICON_SIZE, ITEM_ANIM_MS, ITEM_PADDING, MAX_SCALE,
} from './config.js';
import {_} from './i18n.js';

const DOT_SIZE = 5;

/**
 * Base de todo ícono del dock. Estructura:
 *   St.Button (item: recibe clics, escala y desplazamiento de la magnificación)
 *     └ _content (tamaño fijo ICON_SIZE x ICON_SIZE+DOT_AREA; el "rebote" mueve esto)
 *         ├ ícono renderizado a ICON_HI y reducido a 1/MAX_SCALE (nítido al ampliar)
 *         ├ punto indicador
 *         └ globo de notificaciones
 */
export const DockItem = GObject.registerClass(
class GlassDockItem extends St.Button {
    _init(dock, {label = '', magnify = true} = {}) {
        super._init({
            style_class: 'glass-dock-item',
            style: `padding: 0 ${ITEM_PADDING}px;`,
            reactive: true,
            track_hover: true,
            can_focus: false,
            button_mask: St.ButtonMask.PRIMARY | St.ButtonMask.MIDDLE,
            y_align: Clutter.ActorAlign.END,
        });
        this.dock = dock;
        this.labelText = label;
        this.magnifiable = magnify;
        this.set_pivot_point(0.5, 1);

        this._content = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            width: ICON_SIZE,
            height: ICON_SIZE + DOT_AREA,
        });
        this.set_child(this._content);

        this.connect('notify::hover', () => dock.onItemHover(this));
    }

    setIconActor(actor) {
        this._icon?.destroy();
        this._icon = actor;
        actor.set_pivot_point(0, 0);
        actor.set_scale(1 / MAX_SCALE, 1 / MAX_SCALE);
        actor.set_position(0, 0);
        this._content.insert_child_at_index(actor, 0);
    }

    /** Animación de entrada: crece desde ancho 0. */
    animateIn() {
        const [, natWidth] = this.get_preferred_width(-1);
        this.opacity = 0;
        this.width = 0;
        this.ease({
            width: natWidth,
            opacity: 255,
            duration: ITEM_ANIM_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => (this.width = -1),
        });
    }

    /** Animación de salida y destrucción. */
    animateOutAndDestroy() {
        this.reactive = false;
        this.width = this.width;
        this.ease({
            width: 0,
            opacity: 0,
            duration: ITEM_ANIM_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => this.destroy(),
        });
    }

    /** Rebote estilo macOS al abrir una app. */
    bounce(times = 2) {
        if (times <= 0)
            return;
        const c = this._content;
        c.ease({
            translation_y: -ICON_SIZE * 0.4,
            duration: 220,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => c.ease({
                translation_y: 0,
                duration: 300,
                mode: Clutter.AnimationMode.EASE_OUT_BOUNCE,
                onComplete: () => this._shouldKeepBouncing() && this.bounce(times - 1),
            }),
        });
    }

    _shouldKeepBouncing() {
        return true;
    }

    _openMenu(menu) {
        if (!this._menuManager) {
            this._menuManager = new PopupMenu.PopupMenuManager(this);
            this._menuManager.addMenu(menu);
            menu.connect('open-state-changed', (_m, open) => this.dock.onMenuState(open));
            Main.uiGroup.add_child(menu.actor);
            this.connect('destroy', () => menu.destroy());
        }
        this.dock.hideLabel();
        menu.open(BoxPointer.PopupAnimation.FULL);
    }
});

export const AppItem = GObject.registerClass(
class GlassDockAppItem extends DockItem {
    _init(dock, app, counter) {
        super._init(dock, {label: app.get_name()});
        this.app = app;
        this.isFavorite = false;
        this._delegate = this; // necesario para DnD

        this.setIconActor(app.create_icon_texture(ICON_HI));

        this._dot = new St.Widget({
            style_class: 'glass-dock-dot',
            width: DOT_SIZE,
            height: DOT_SIZE,
            x: Math.round((ICON_SIZE - DOT_SIZE) / 2),
            y: ICON_SIZE + 3,
        });
        this._content.add_child(this._dot);

        this._badge = new St.Label({style_class: 'glass-dock-badge', visible: false});
        this._badge.set_pivot_point(0.5, 0.5);
        this._content.add_child(this._badge);

        this._counter = counter;
        counter.connectObject('changed', () => this._syncBadge(), this);
        app.connectObject('notify::state', () => this._syncState(), this);
        this._syncState();
        this._syncBadge();

        this.connect('clicked', (_b, button) => this._activate(button));
        this.connect('button-press-event', (_a, event) => {
            if (event.get_button() === Clutter.BUTTON_SECONDARY) {
                this._popupMenu();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._draggable = DND.makeDraggable(this);
        this._draggable.connect('drag-begin', () => {
            Main.overview.beginItemDrag(this);
            dock.onOwnItemDragBegin(this);
        });
        this._draggable.connect('drag-cancelled', () => {
            Main.overview.cancelItemDrag(this);
            dock.onOwnItemDragCancelled(this);
        });
        this._draggable.connect('drag-end', () => {
            Main.overview.endItemDrag(this);
            dock.onOwnItemDragEnd(this);
        });
    }

    // --- DnD ---
    getDragActor() {
        return this.app.create_icon_texture(ICON_SIZE);
    }

    getDragActorSource() {
        return this._icon;
    }

    // --- Estado ---
    _syncState() {
        const running = this.app.state !== Shell.AppState.STOPPED;
        if (this._running === undefined) { // primera vez: sin animación
            this._running = running;
            this._dot.visible = running;
            return;
        }
        if (running === this._running)
            return;
        this._running = running;
        this._dot.visible = true;
        this._dot.ease({
            opacity: running ? 255 : 0,
            duration: ITEM_ANIM_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => (this._dot.visible = running),
        });
    }

    _shouldKeepBouncing() {
        return this.app.state === Shell.AppState.STARTING;
    }

    _syncBadge() {
        const count = this._counter.getCount(this.app.get_id());
        const badge = this._badge;
        if (count <= 0) {
            if (badge.visible) {
                badge.ease({
                    scale_x: 0, scale_y: 0, duration: 150,
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                    onComplete: () => (badge.visible = false),
                });
            }
            return;
        }
        const text = count > 99 ? '99+' : String(count);
        const changed = badge.text !== text || !badge.visible;
        badge.text = text;
        const [, w] = badge.get_preferred_width(-1);
        badge.set_position(Math.round(ICON_SIZE - w * 0.7), -4);
        if (changed) {
            // "pop" al aparecer o cambiar
            badge.visible = true;
            badge.set_scale(0.4, 0.4);
            badge.ease({
                scale_x: 1, scale_y: 1, duration: 260,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
        }
    }

    // --- Clics ---
    _activate(button) {
        const event = Clutter.get_current_event();
        const mods = event ? event.get_state() : 0;
        const wantsNew = button === Clutter.BUTTON_MIDDLE ||
            (mods & Clutter.ModifierType.CONTROL_MASK);

        if (wantsNew && this.app.can_open_new_window()) {
            this.app.open_new_window(-1);
            this.bounce();
            Main.overview.hide();
            return;
        }

        const windows = this.app.get_windows().filter(w => !w.is_skip_taskbar());
        if (this.app.state === Shell.AppState.STOPPED || windows.length === 0) {
            this.app.activate();
            this.bounce();
            Main.overview.hide();
            return;
        }

        // get_windows() viene ordenado por uso reciente.
        const focused = Shell.WindowTracker.get_default().focus_app === this.app;
        if (focused && !Main.overview.visible) {
            if (windows.length === 1)
                windows[0].minimize();
            else
                Main.activateWindow(windows[windows.length - 1]); // ciclar
        } else {
            Main.activateWindow(windows[0]);
        }
        Main.overview.hide();
    }

    _popupMenu() {
        if (!this._menu) {
            // Menú nativo de GNOME: ventanas abiertas, nueva ventana,
            // fijar/quitar del dock, detalles y salir.
            this._menu = new AppMenu(this, St.Side.BOTTOM, {
                favoritesSection: true,
                showSingleWindows: true,
            });
            this._menu.setApp(this.app);
        }
        this._openMenu(this._menu);
    }
});

export const ShowAppsItem = GObject.registerClass(
class GlassDockShowAppsItem extends DockItem {
    _init(dock) {
        super._init(dock, {label: _('Show Apps')});
        // Solo los 9 puntos, sin recuadro (centrados en el área del ícono).
        const tile = new St.Bin({
            width: ICON_HI,
            height: ICON_HI,
            child: new St.Icon({
                style_class: 'glass-dock-apps-icon',
                icon_name: 'view-app-grid-symbolic',
                icon_size: Math.round(ICON_HI * 0.72),
            }),
        });
        this.setIconActor(tile);
        this.connect('clicked', () => this._toggle());
    }

    _toggle() {
        const button = Main.overview.dash.showAppsButton;
        if (!Main.overview.visible)
            Main.overview.showApps();
        else if (button.checked)
            Main.overview.hide();
        else
            button.checked = true;
    }
});

export const TrashItem = GObject.registerClass(
class GlassDockTrashItem extends DockItem {
    _init(dock) {
        super._init(dock, {label: _('Trash')});
        this._iconWidget = new St.Icon({
            icon_size: ICON_HI,
            fallback_icon_name: 'user-trash-symbolic',
        });
        this.setIconActor(this._iconWidget);

        this._file = Gio.File.new_for_uri('trash:///');
        this._monitor = this._file.monitor_directory(Gio.FileMonitorFlags.NONE, null);
        this._monitor.connectObject('changed', () => this._refresh(), this);
        this._refresh();

        this.connect('clicked', () => this._open());
        this.connect('button-press-event', (_a, event) => {
            if (event.get_button() === Clutter.BUTTON_SECONDARY) {
                this._popupMenu();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this.connect('destroy', () => {
            this._monitor.cancel();
            this._monitor = null;
        });
    }

    _refresh() {
        this._file.query_info_async('trash::item-count', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_LOW, null, (file, res) => {
                if (!this._monitor)
                    return; // destruido mientras tanto
                let full = false;
                try {
                    full = file.query_info_finish(res).get_attribute_uint32('trash::item-count') > 0;
                } catch (e) {
                    logError(e, 'Glass Dock: papelera');
                }
                this._iconWidget.icon_name = full ? 'user-trash-full' : 'user-trash';
            });
    }

    _open() {
        Main.overview.hide();
        Gio.AppInfo.launch_default_for_uri('trash:///',
            global.create_app_launch_context(0, -1));
    }

    _empty() {
        // Nautilus muestra su propio diálogo de confirmación.
        Gio.DBus.session.call('org.gnome.Nautilus',
            '/org/gnome/Nautilus/FileOperations2',
            'org.gnome.Nautilus.FileOperations2', 'EmptyTrash',
            new GLib.Variant('(ba{sv})', [true, {}]),
            null, Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch (e) {
                    logError(e, 'Glass Dock: vaciar papelera');
                }
            });
    }

    _popupMenu() {
        if (!this._menu) {
            this._menu = new PopupMenu.PopupMenu(this, 0.5, St.Side.BOTTOM);
            this._menu.addAction(_('Open'), () => this._open());
            this._menu.addAction(_('Empty Trash…'), () => this._empty());
        }
        this._openMenu(this._menu);
    }
});

export const Separator = GObject.registerClass(
class GlassDockSeparator extends St.Widget {
    _init() {
        super._init({
            style_class: 'glass-dock-separator',
            width: 1,
            height: Math.round(ICON_SIZE * 0.7),
            y_align: Clutter.ActorAlign.START,
        });
        this.magnifiable = false;
        // centrado respecto al ícono (no al área del punto)
        this.translation_y = Math.round(ICON_SIZE * 0.15);
    }
});
