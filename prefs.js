// Ventana de preferencias: `gnome-extensions prefs glass-dock@santidev21`
// o desde la app "Extensiones". Los cambios se aplican al instante.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';

import {_} from './i18n.js';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class GlassDockPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings; // mantener viva la referencia
        window.set_default_size(560, 460);

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-desktop-apps-symbolic',
        });
        const group = new Adw.PreferencesGroup({
            title: _('Icons'),
            description: _('Changes apply to the dock instantly.'),
        });

        const size = Adw.SpinRow.new_with_range(24, 128, 4);
        size.title = _('Icon size');
        size.subtitle = _('In pixels (default 48)');
        settings.bind('icon-size', size, 'value', Gio.SettingsBindFlags.DEFAULT);

        const magnification = Adw.SpinRow.new_with_range(1.0, 2.5, 0.1);
        magnification.digits = 1;
        magnification.title = _('Magnification');
        magnification.subtitle = _('Maximum scale on hover (1.0 = no zoom)');
        settings.bind('magnification', magnification, 'value', Gio.SettingsBindFlags.DEFAULT);

        group.add(size);
        group.add(magnification);
        page.add(group);

        const glassGroup = new Adw.PreferencesGroup({title: _('Glass')});
        const live = new Adw.SwitchRow({
            title: _('Live blur'),
            subtitle: _('Blurs what is behind the dock, windows included. Turn it off if you notice lag.'),
        });
        settings.bind('live-blur', live, 'active', Gio.SettingsBindFlags.DEFAULT);
        glassGroup.add(live);
        page.add(glassGroup);
        window.add(page);
    }
}
