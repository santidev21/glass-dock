// Contador de notificaciones por app. Combina dos fuentes y usa la mayor:
//  1. Las notificaciones de GNOME que siguen en la bandeja (Main.messageTray).
//  2. La API "LauncherEntry" de Unity por D-Bus, con la que apps como
//     Telegram, Thunderbird o Discord publican su número de "no leídos".

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

const unpack = v => (v instanceof GLib.Variant ? v.recursiveUnpack() : v);

export class NotificationCounter extends EventEmitter {
    constructor() {
        super();
        this._tray = new Map();      // appId -> nº notificaciones en bandeja
        this._launcher = new Map();  // sender -> Map(appId -> count visible)
        this._watched = new Set();   // fuentes/notificaciones con señales conectadas

        Main.messageTray.connectObject(
            'source-added', () => this._scanTray(),
            'source-removed', () => this._scanTray(),
            this);

        const bus = Gio.DBus.session;
        this._updateSub = bus.signal_subscribe(null,
            'com.canonical.Unity.LauncherEntry', 'Update', null, null,
            Gio.DBusSignalFlags.NONE,
            (_c, sender, _p, _i, _s, params) =>
                this._onLauncherUpdate(sender, ...params.deep_unpack()));
        this._ownerSub = bus.signal_subscribe('org.freedesktop.DBus',
            'org.freedesktop.DBus', 'NameOwnerChanged', '/org/freedesktop/DBus',
            null, Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, _n, params) => {
                const [, oldOwner, newOwner] = params.deep_unpack();
                if (oldOwner && !newOwner && this._launcher.delete(oldOwner))
                    this.emit('changed');
            });
        // Varias apps (Electron/Chromium) solo envían el contador si este
        // nombre existe en el bus.
        this._nameId = bus.own_name('com.canonical.Unity',
            Gio.BusNameOwnerFlags.ALLOW_REPLACEMENT | Gio.BusNameOwnerFlags.REPLACE,
            null, null);

        this._scanTray();
    }

    getCount(appId) {
        let launcher = 0;
        for (const map of this._launcher.values()) {
            const e = map.get(appId);
            if (e?.visible)
                launcher = Math.max(launcher, e.count);
        }
        return Math.max(this._tray.get(appId) ?? 0, launcher);
    }

    _onLauncherUpdate(sender, appUri, props) {
        const appId = appUri.replace(/^\w+:\/\//, '');
        if (!sender || !appId)
            return;
        let map = this._launcher.get(sender);
        if (!map)
            this._launcher.set(sender, map = new Map());

        // Cada Update puede traer solo algunos campos: se fusionan con lo anterior.
        const entry = map.get(appId) ?? {count: 0, visible: false};
        const prev = entry.visible ? entry.count : 0;
        if ('count' in props)
            entry.count = Number(unpack(props['count']));
        if ('count-visible' in props)
            entry.visible = Boolean(unpack(props['count-visible']));
        map.set(appId, entry);
        if ((entry.visible ? entry.count : 0) !== prev)
            this.emit('changed');
    }

    _scanTray() {
        for (const obj of this._watched)
            obj.disconnectObject(this);
        this._watched.clear();

        const counts = new Map();
        for (const source of Main.messageTray.getSources()) {
            source.connectObject(
                'notification-added', () => this._scanTray(),
                'notification-removed', () => this._scanTray(), this);
            this._watched.add(source);

            for (const notification of source.notifications) {
                const app = notification.source?.app ?? source.app ?? source._app;
                const appId = app?.id ?? app?.get_id?.() ?? app?._appId;
                if (!appId)
                    continue;
                // Notificaciones residentes ya vistas no cuentan.
                if (notification.resident) {
                    if (notification.acknowledged)
                        continue;
                    notification.connectObject('notify::acknowledged',
                        () => this._scanTray(), this);
                }
                notification.connectObject('destroy', () => this._scanTray(), this);
                this._watched.add(notification);
                counts.set(appId, (counts.get(appId) ?? 0) + 1);
            }
        }
        this._tray = counts;
        this.emit('changed');
    }

    destroy() {
        Main.messageTray.disconnectObject(this);
        for (const obj of this._watched)
            obj.disconnectObject(this);
        this._watched.clear();
        const bus = Gio.DBus.session;
        bus.signal_unsubscribe(this._updateSub);
        bus.signal_unsubscribe(this._ownerSub);
        if (this._nameId)
            bus.unown_name(this._nameId);
        this._nameId = 0;
    }
}
