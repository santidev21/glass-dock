// Intellihide: avisa cuando alguna ventana visible se superpone al área del dock.
// Las comprobaciones se limitan a una cada CHECK_INTERVAL ms mientras haya
// cambios (mover/redimensionar ventanas emite muchas señales por segundo).

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

const CHECK_INTERVAL = 100;

const HANDLED_TYPES = [
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
    Meta.WindowType.TOOLBAR,
    Meta.WindowType.MENU,
    Meta.WindowType.UTILITY,
    Meta.WindowType.SPLASHSCREEN,
];

export class Intellihide {
    constructor(onChange) {
        this._onChange = onChange;
        this._target = null;
        this._monitorIndex = 0;
        this._overlaps = false;
        this._timeoutId = 0;
        this._pending = false;

        global.display.connectObject(
            'window-created', (_d, win) => {
                this._trackWindow(win.get_compositor_private());
                this._queueCheck();
            },
            'restacked', () => this._queueCheck(),
            this);
        global.workspace_manager.connectObject(
            'active-workspace-changed', () => this._queueCheck(), this);
        Shell.WindowTracker.get_default().connectObject(
            'notify::focus-app', () => this._queueCheck(), this);

        for (const actor of global.get_window_actors())
            this._trackWindow(actor);
    }

    get overlaps() {
        return this._overlaps;
    }

    setTarget(rect, monitorIndex) {
        this._target = rect;
        this._monitorIndex = monitorIndex;
        this._check();
    }

    _trackWindow(actor) {
        const win = actor?.get_meta_window();
        if (!win)
            return;
        actor.connectObject(
            'notify::allocation', () => this._queueCheck(),
            'destroy', () => {
                actor.disconnectObject(this);
                win.disconnectObject(this);
                this._queueCheck();
            }, this);
        win.connectObject('notify::minimized', () => this._queueCheck(), this);
    }

    _queueCheck() {
        if (this._timeoutId) {
            this._pending = true;
            return;
        }
        this._check();
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CHECK_INTERVAL, () => {
            if (this._pending) {
                this._pending = false;
                this._check();
                return GLib.SOURCE_CONTINUE;
            }
            this._timeoutId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _check() {
        if (!this._target)
            return;
        const {x, y, width, height} = this._target;
        const workspace = global.workspace_manager.get_active_workspace();

        const overlaps = global.get_window_actors().some(actor => {
            const win = actor.get_meta_window();
            if (!win || win.minimized || !win.showing_on_its_workspace())
                return false;
            if (!HANDLED_TYPES.includes(win.get_window_type()))
                return false;
            if (win.get_monitor() !== this._monitorIndex || !win.located_on_workspace(workspace))
                return false;
            const r = win.get_frame_rect();
            return r.x < x + width && r.x + r.width > x &&
                   r.y < y + height && r.y + r.height > y;
        });

        if (overlaps !== this._overlaps) {
            this._overlaps = overlaps;
            this._onChange(overlaps);
        }
    }

    destroy() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        Shell.WindowTracker.get_default().disconnectObject(this);
        for (const actor of global.get_window_actors()) {
            actor.disconnectObject(this);
            actor.get_meta_window()?.disconnectObject(this);
        }
    }
}
