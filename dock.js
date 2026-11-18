// El dock: contenedor, layout de ítems, mostrar/ocultar, magnificación y DnD.
//
// Regla de rendimiento: lo que se anima cada frame (deslizar, zoom) son
// transformaciones (translation/scale), nunca tamaños de layout. Así Clutter
// no recalcula el layout por frame y la GPU solo recompone.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';

import * as C from './config.js';
import {Glass} from './glass.js';
import {Intellihide} from './intellihide.js';
import {NotificationCounter} from './badges.js';
import {computeMagnification} from './magnifier.js';
import {AppItem, Separator, ShowAppsItem, TrashItem} from './items.js';

export const Dock = GObject.registerClass(
class GlassDock extends St.Widget {
    _init() {
        super._init({
            name: 'glassDock',
            style_class: 'glass-dock',
            reactive: true,
            track_hover: true,
            layout_manager: new Clutter.FixedLayout(),
        });

        this._appSystem = Shell.AppSystem.get_default();
        this._favorites = AppFavorites.getAppFavorites();
        this._counter = new NotificationCounter();
        this._items = new Map();     // appId -> AppItem
        this._runningOrder = [];     // orden estable de apps abiertas no fijadas
        this._shown = true;
        this._overlap = false;
        this._revealed = false;
        this._menusOpen = 0;
        this._dragging = false;
        this._magnified = false;
        this._rest = null;           // {x, y, width, height} en reposo

        // Caja de ítems
        this._box = new St.BoxLayout({style_class: 'glass-dock-box'});
        this._box._delegate = this; // destino de DnD (handleDragOver/acceptDrop)
        this._appsButton = new ShowAppsItem(this);
        this._runSep = new Separator();
        this._trashSep = new Separator();
        this._trash = new TrashItem(this);
        for (const a of [this._appsButton, this._runSep, this._trashSep, this._trash])
            this._box.add_child(a);
        this.add_child(this._box);

        Main.layoutManager.addChrome(this, {trackFullscreen: false});

        // Etiqueta flotante con el nombre de la app (por encima del dock)
        this._label = new St.Label({style_class: 'glass-dock-label', visible: false, opacity: 0});
        Main.layoutManager.addTopChrome(this._label);

        this._intellihide = new Intellihide(overlap => {
            this._overlap = overlap;
            this._updateVisibility();
        });

        this._pressure = new Layout.PressureBarrier(C.PRESSURE_THRESHOLD,
            C.PRESSURE_TIMEOUT, Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);
        this._pressure.connectObject('trigger', () => this._onPressure(), this);

        this._buildGlass();
        this._connectSignals();
        this._redisplay();
        this._syncColorScheme();
    }

    // ------------------------------------------------------------------ setup

    get _monitor() {
        return Main.layoutManager.primaryMonitor;
    }

    _buildGlass() {
        this._glass?.destroy();
        this._glass = new Glass(Main.layoutManager.primaryIndex);
        this.insert_child_below(this._glass, this._box);
    }

    _connectSignals() {
        this._favorites.connectObject('changed', () => this._queueRedisplay(), this);
        this._appSystem.connectObject(
            'app-state-changed', () => this._queueRedisplay(),
            'installed-changed', () => this._queueRedisplay(), this);

        this._box.connectObject('notify::allocation', () => this._queueGeometry(), this);
        Main.layoutManager.connectObject('monitors-changed', () => {
            this._buildGlass();
            this._queueGeometry();
        }, this);

        Main.overview.connectObject(
            'showing', () => this._updateVisibility(),
            'hidden', () => this._updateVisibility(),
            'item-drag-begin', () => this._onDragBegin(),
            'item-drag-end', () => this._onDragEnd(),
            'item-drag-cancelled', () => this._onDragEnd(),
            this);

        St.Settings.get().connectObject('notify::color-scheme',
            () => this._syncColorScheme(), this);

        // Mostrar/ocultar y zoom según el puntero
        this.connect('notify::hover', () => {
            if (!this.hover) {
                this._revealed = false;
                this._unmagnify();
            }
            this._updateVisibility();
        });
        this.connect('motion-event', (_a, event) => {
            const [x] = event.get_coords();
            this._magnify(x);
            return Clutter.EVENT_PROPAGATE;
        });
        // El fondo de vidrio compensa el deslizamiento para no "viajar".
        this.connect('notify::translation-y', () =>
            this._glass.setWallTranslationY(this.translation_y));
    }

    _syncColorScheme() {
        const light = St.Settings.get().color_scheme === St.SystemColorScheme.PREFER_LIGHT;
        if (light)
            this.add_style_class_name('light');
        else
            this.remove_style_class_name('light');
    }

    // ------------------------------------------------------------- contenido

    _queueRedisplay() {
        if (this._redisplayId)
            return;
        this._redisplayId = global.compositor.get_laters().add(
            Meta.LaterType.BEFORE_REDRAW, () => {
                this._redisplayId = 0;
                this._redisplay();
                return GLib.SOURCE_REMOVE;
            });
    }

    _redisplay() {
        const favorites = this._favorites.getFavorites();
        const favIds = new Set(favorites.map(a => a.get_id()));
        const running = new Map(this._appSystem.get_running()
            .filter(a => !favIds.has(a.get_id()))
            .map(a => [a.get_id(), a]));

        // Las apps abiertas mantienen el orden en que se abrieron.
        this._runningOrder = this._runningOrder.filter(id => running.has(id));
        for (const id of running.keys()) {
            if (!this._runningOrder.includes(id))
                this._runningOrder.push(id);
        }
        const runningApps = this._runningOrder.map(id => running.get(id));

        const wanted = new Set([...favIds, ...running.keys()]);
        for (const [id, item] of this._items) {
            if (!wanted.has(id)) {
                this._items.delete(id);
                item.animateOutAndDestroy();
            }
        }

        let prev = this._appsButton;
        const place = actor => {
            if (actor.get_parent() === this._box)
                this._box.set_child_above_sibling(actor, prev);
            else
                this._box.insert_child_above(actor, prev);
            prev = actor;
        };
        const placeApp = (app, isFavorite) => {
            let item = this._items.get(app.get_id());
            const isNew = !item;
            if (isNew) {
                item = new AppItem(this, app, this._counter);
                this._items.set(app.get_id(), item);
            }
            item.isFavorite = isFavorite;
            place(item);
            if (isNew && this._initialized)
                item.animateIn();
        };

        favorites.forEach(app => placeApp(app, true));
        place(this._runSep);
        this._runSep.visible = runningApps.length > 0;
        runningApps.forEach(app => placeApp(app, false));
        place(this._trashSep);
        place(this._trash);
        this._initialized = true;
    }

    // ------------------------------------------------------------- geometría

    _queueGeometry() {
        if (this._geometryId)
            return;
        this._geometryId = global.compositor.get_laters().add(
            Meta.LaterType.BEFORE_REDRAW, () => {
                this._geometryId = 0;
                this._updateGeometry();
                return GLib.SOURCE_REMOVE;
            });
    }

    _updateGeometry() {
        const mon = this._monitor;
        if (!mon)
            return;
        const [width, height] = this._box.get_size();
        if (!width || !height)
            return;
        const x = Math.round(mon.x + (mon.width - width) / 2);
        const y = mon.y + mon.height - height - C.BOTTOM_MARGIN;

        // Tamaño fijo explícito: así el zoom (que pinta fuera) no cambia el layout.
        // El área del dock llega hasta el borde inferior de la pantalla: al
        // revelarlo empujando el borde, el mouse ya queda "dentro" del dock.
        this.set_position(x, y);
        this.set_size(width, height + C.BOTTOM_MARGIN);
        this._rest = {x, y, width, height};
        if (!this._magnified) {
            this._glass.setGeometry({x: 0, width, height, wallX: mon.x - x, wallY: mon.y - y});
            this._glass.setWallTranslationY(this.translation_y);
        }

        this._intellihide.setTarget(this._rest, Main.layoutManager.primaryIndex);
        this._updateBarrier();
    }

    _updateBarrier() {
        if (this._barrier) {
            this._pressure.removeBarrier(this._barrier);
            this._barrier.destroy();
        }
        const mon = this._monitor;
        const {x, width} = this._rest;
        const bottom = mon.y + mon.height;
        this._barrier = new Meta.Barrier({
            backend: global.backend,
            x1: Math.max(mon.x, x - C.SLOT_WIDTH),
            x2: Math.min(mon.x + mon.width, x + width + C.SLOT_WIDTH),
            y1: bottom,
            y2: bottom,
            directions: Meta.BarrierDirection.NEGATIVE_Y,
        });
        this._pressure.addBarrier(this._barrier);
    }

    // ------------------------------------------------------ mostrar / ocultar

    _shouldShow() {
        return Main.overview.visibleTarget || !this._overlap || this.hover ||
            this._revealed || this._menusOpen > 0 || this._dragging;
    }

    _updateVisibility() {
        if (this._hideTimeoutId) {
            GLib.source_remove(this._hideTimeoutId);
            this._hideTimeoutId = 0;
        }
        if (this._shouldShow()) {
            this._slide(true);
            return;
        }
        // Pequeña espera antes de ocultar: evita parpadeos al rozar el borde.
        this._hideTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, C.HIDE_DELAY, () => {
            this._hideTimeoutId = 0;
            if (!this._shouldShow())
                this._slide(false);
            return GLib.SOURCE_REMOVE;
        });
    }

    _slide(show) {
        if (show === this._shown)
            return;
        this._shown = show;
        // No usamos show()/hide(): volver a mostrar un actor oculto obliga a
        // recalcular su layout justo en el primer frame de la animación.
        // Oculto = fuera de pantalla + opacidad 0 → Clutter no lo pinta.
        if (show) {
            this.opacity = 255;
            this.ease({
                translation_y: 0,
                duration: C.SHOW_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        } else {
            this._unmagnify();
            this.hideLabel();
            this.ease({
                translation_y: (this._rest?.height ?? 80) + C.BOTTOM_MARGIN + 2,
                duration: C.HIDE_DURATION,
                mode: Clutter.AnimationMode.EASE_IN_OUT_CUBIC,
                onComplete: () => {
                    if (!this._shown)
                        this.opacity = 0;
                },
            });
        }
    }

    _onPressure() {
        if (this._monitor?.inFullscreen || Main.overview.visible)
            return;
        this._revealed = true;
        this._updateVisibility();
        if (this._revealId)
            GLib.source_remove(this._revealId);
        this._revealId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, C.REVEAL_GRACE, () => {
            this._revealId = 0;
            if (!this.hover) {
                this._revealed = false;
                this._updateVisibility();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // --------------------------------------------------------- magnificación

    _zoomableChildren() {
        return this._box.get_children().filter(c => c.visible);
    }

    _magnify(stageX) {
        if (this._dragging || this._menusOpen > 0 || !this._rest || !this._shown ||
            C.MAX_SCALE <= 1)
            return;
        const [ok, px] = this._box.transform_stage_point(stageX, 0);
        if (!ok)
            return;

        const children = this._zoomableChildren();
        const rest = children.map(c => {
            const box = c.get_allocation_box();
            return {x: box.x1, width: box.x2 - box.x1, magnify: c.magnifiable !== false};
        });
        const r = computeMagnification(rest, px, {
            maxScale: C.MAX_SCALE,
            range: C.MAGNIFY_RANGE * C.SLOT_WIDTH,
        });
        if (!r)
            return;

        // Al entrar el puntero, se suaviza unos ms; luego sigue al cursor 1:1.
        const now = GLib.get_monotonic_time();
        if (!this._magnified) {
            this._magnified = true;
            this._easeUntil = now + C.MAGNIFY_ENTER_MS * 1000;
        }
        const duration = now < this._easeUntil ? C.MAGNIFY_ENTER_MS : 0;

        children.forEach((c, i) => {
            const props = {scale_x: r.scales[i], scale_y: r.scales[i], translation_x: r.offsets[i]};
            if (duration > 0) {
                c.ease({...props, duration, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            } else {
                c.remove_transition('scale-x');
                c.remove_transition('scale-y');
                c.remove_transition('translation-x');
                c.set(props);
            }
        });

        const {width, height, x, y} = this._rest;
        const mon = this._monitor;
        this._glass.setGeometry({
            x: -r.extraLeft,
            width: width + r.extraLeft + r.extraRight,
            height,
            wallX: mon.x - x,
            wallY: mon.y - y,
        }, duration);

        if (this._hoveredItem)
            this._positionLabel(this._hoveredItem);
    }

    _unmagnify() {
        if (!this._magnified)
            return;
        this._magnified = false;
        const params = {duration: C.UNMAGNIFY_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD};
        for (const c of this._box.get_children())
            c.ease({scale_x: 1, scale_y: 1, translation_x: 0, ...params});
        if (this._rest) {
            const {width, height, x, y} = this._rest;
            const mon = this._monitor;
            this._glass.setGeometry({x: 0, width, height, wallX: mon.x - x, wallY: mon.y - y},
                C.UNMAGNIFY_MS);
        }
    }

    // ------------------------------------------------------- etiqueta / menús

    onItemHover(item) {
        if (item.hover && !this._dragging && this._menusOpen === 0) {
            this._hoveredItem = item;
            this._label.text = item.labelText;
            this._label.show();
            this._positionLabel(item);
            this._label.ease({opacity: 255, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } else if (this._hoveredItem === item) {
            this.hideLabel();
        }
    }

    _positionLabel(item) {
        const [ix, iy] = item.get_transformed_position();
        const [iw] = item.get_transformed_size();
        const [, lw] = this._label.get_preferred_width(-1);
        const [, lh] = this._label.get_preferred_height(-1);
        const mon = this._monitor;
        const x = Math.round(Math.max(mon.x + 4,
            Math.min(ix + iw / 2 - lw / 2, mon.x + mon.width - lw - 4)));
        this._label.set_position(x, Math.round(iy - lh - 6));
    }

    hideLabel() {
        this._hoveredItem = null;
        this._label.remove_all_transitions();
        this._label.opacity = 0;
        this._label.hide();
    }

    onMenuState(open) {
        this._menusOpen = Math.max(0, this._menusOpen + (open ? 1 : -1));
        if (open)
            this._unmagnify();
        this._updateVisibility();
    }

    // ------------------------------------------------------------------ DnD
    // Arrastrar dentro del dock reordena las apps fijadas; arrastrar una app
    // abierta (o desde la cuadrícula de apps) a esa zona la fija; soltar una
    // fijada lejos del dock la quita.

    _pinnedItems() {
        return this._box.get_children().filter(c => c instanceof AppItem && c.isFavorite && c.visible);
    }

    onOwnItemDragBegin(item) {
        // El hueco queda donde estaba el ícono mientras se arrastra.
        this._ensurePlaceholder();
        this._box.set_child_above_sibling(this._placeholder, item);
        this._placeholder.remove_all_transitions();
        this._placeholder.width = item.width;
        item.hide();
        this._dragSource = item;
    }

    onOwnItemDragCancelled(item) {
        const [, y] = global.get_pointer();
        if (item.isFavorite && this._rest && y < this._rest.y - C.ICON_SIZE)
            this._favorites.removeFavorite(item.app.get_id());
    }

    onOwnItemDragEnd(item) {
        item.show();
        this._dragSource = null;
    }

    _onDragBegin() {
        this._dragging = true;
        this._unmagnify();
        this.hideLabel();
        this._dragMonitor = {
            dragMotion: event => {
                if (!this.contains(event.targetActor))
                    this._clearPlaceholder();
                return DND.DragMotionResult.CONTINUE;
            },
        };
        DND.addDragMonitor(this._dragMonitor);
        this._updateVisibility();
    }

    _onDragEnd() {
        if (this._dragMonitor) {
            DND.removeDragMonitor(this._dragMonitor);
            this._dragMonitor = null;
        }
        this._clearPlaceholder();
        this._dragging = false;
        this._updateVisibility();
    }

    _ensurePlaceholder() {
        if (this._placeholder)
            return;
        this._placeholder = new St.Widget({style_class: 'glass-dock-placeholder', width: 0});
        this._placeholder.magnifiable = false;
        this._box.add_child(this._placeholder);
        this._placeholder.ease({
            width: C.SLOT_WIDTH, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _clearPlaceholder() {
        this._placeholder?.destroy();
        this._placeholder = null;
        this._dropPos = null;
    }

    handleDragOver(source, _actor, x) {
        const app = source?.app;
        if (!(app instanceof Shell.App) || app.is_window_backed())
            return DND.DragMotionResult.NO_DROP;

        const isFavorite = this._favorites.isFavorite(app.get_id());
        // Una app no fijada solo se puede soltar en la zona de fijadas.
        if (!isFavorite && this._runSep.visible) {
            const sep = this._runSep.get_allocation_box();
            if (x > sep.x1) {
                this._clearPlaceholder();
                return DND.DragMotionResult.NO_DROP;
            }
        }

        const pinned = this._pinnedItems();
        let pos = 0;
        for (const it of pinned) {
            const b = it.get_allocation_box();
            if (x > (b.x1 + b.x2) / 2)
                pos++;
        }

        this._ensurePlaceholder();
        if (pos < pinned.length)
            this._box.set_child_below_sibling(this._placeholder, pinned[pos]);
        else
            this._box.set_child_above_sibling(this._placeholder, pinned.at(-1) ?? this._appsButton);
        this._dropPos = pos;

        return isFavorite ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.COPY_DROP;
    }

    acceptDrop(source) {
        const app = source?.app;
        if (!(app instanceof Shell.App) || this._dropPos === null || this._dropPos === undefined)
            return false;
        const id = app.get_id();
        const pos = this._dropPos;
        // Se aplica tras terminar el drop para no destruir el actor arrastrado a mitad.
        global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            if (this._favorites.isFavorite(id))
                this._favorites.moveFavoriteToPos(id, pos);
            else
                this._favorites.addFavoriteAtPos(id, pos);
            return GLib.SOURCE_REMOVE;
        });
        return true;
    }

    // -------------------------------------------------------------- limpieza

    destroy() {
        for (const id of ['_hideTimeoutId', '_revealId']) {
            if (this[id])
                GLib.source_remove(this[id]);
            this[id] = 0;
        }
        const laters = global.compositor.get_laters();
        if (this._redisplayId)
            laters.remove(this._redisplayId);
        if (this._geometryId)
            laters.remove(this._geometryId);
        if (this._dragMonitor)
            DND.removeDragMonitor(this._dragMonitor);

        this._intellihide.destroy();
        if (this._barrier) {
            this._pressure.removeBarrier(this._barrier);
            this._barrier.destroy();
        }
        this._pressure.destroy();
        this._counter.destroy();
        Main.layoutManager.removeChrome(this._label);
        this._label.destroy();

        this._favorites.disconnectObject(this);
        this._appSystem.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.overview.disconnectObject(this);
        St.Settings.get().disconnectObject(this);

        Main.layoutManager.removeChrome(this);
        super.destroy();
    }
});
