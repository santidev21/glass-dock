import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {configure} from './config.js';
import {Dock} from './dock.js';

// Espera tras un cambio de ajustes antes de reconstruir el dock
// (al mantener pulsado +/- en Preferencias llegan muchos cambios seguidos).
const REBUILD_DELAY = 200;

export default class GlassDockExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._settings.connectObject('changed', () => this._queueRebuild(), this);
        this._build();

        // El dash nativo del Overview queda vacío (sus hijos ocultos: ni se ve
        // ni recibe clics) pero sigue ahí como "espaciador" con la altura de
        // nuestro dock: así la cuadrícula de apps y las ventanas se acomodan
        // encima del dock en vez de quedar tapadas por él.
        const dash = Main.overview.dash;
        this._hiddenDashChildren = dash.get_children().filter(c => c.visible);
        this._hiddenDashChildren.forEach(c => c.hide());
        this._syncDashSpace();
    }

    _syncDashSpace() {
        const height = this._dock?.height ?? 0;
        if (height > 0)
            Main.overview.dash.set_height(height);
    }

    disable() {
        if (this._rebuildId)
            GLib.source_remove(this._rebuildId);
        this._rebuildId = 0;
        this._settings.disconnectObject(this);
        this._settings = null;
        this._dock?.destroy();
        this._dock = null;

        const dash = Main.overview.dash;
        dash.set_height(-1);
        this._hiddenDashChildren?.forEach(c => c.show());
        this._hiddenDashChildren = null;
    }

    _build() {
        configure({
            iconSize: this._settings.get_int('icon-size'),
            magnification: this._settings.get_double('magnification'),
            liveBlur: this._settings.get_boolean('live-blur'),
        });
        this._dock?.destroy();
        this._dock = new Dock();
        this._dock.connect('notify::height', () => this._syncDashSpace());
        this._syncDashSpace();
    }

    _queueRebuild() {
        if (this._rebuildId)
            GLib.source_remove(this._rebuildId);
        this._rebuildId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REBUILD_DELAY, () => {
            this._rebuildId = 0;
            this._build();
            return GLib.SOURCE_REMOVE;
        });
    }
}
