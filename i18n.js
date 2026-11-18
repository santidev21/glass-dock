// Traducción mínima: sigue el idioma del sistema (LANGUAGE / LC_MESSAGES / LANG).
// Inglés por defecto; español si el sistema está en español.
// Para añadir un idioma: otra tabla en TABLES con su prefijo (p. ej. 'pt').

import GLib from 'gi://GLib';

const TABLES = {
    es: {
        'Show Apps': 'Mostrar aplicaciones',
        'Trash': 'Papelera',
        'Open': 'Abrir',
        'Empty Trash…': 'Vaciar papelera…',
        'General': 'General',
        'Icons': 'Íconos',
        'Changes apply to the dock instantly.': 'Los cambios se aplican al dock al instante.',
        'Icon size': 'Tamaño de los íconos',
        'In pixels (default 48)': 'En píxeles (por defecto 48)',
        'Magnification': 'Magnificación',
        'Maximum scale on hover (1.0 = no zoom)': 'Escala máxima al pasar el mouse (1.0 = sin zoom)',
        'Glass': 'Vidrio',
        'Live blur': 'Blur en vivo',
        'Blurs what is behind the dock, windows included. Turn it off if you notice lag.':
            'Desenfoca lo que hay detrás del dock, ventanas incluidas. Apágalo si notas lag.',
    },
};

function pickTable() {
    for (const name of GLib.get_language_names()) {
        if (name === 'C' || name === 'POSIX')
            break;
        const lang = name.split(/[_.@]/)[0];
        if (lang === 'en')
            return null;
        if (TABLES[lang])
            return TABLES[lang];
    }
    return null;
}

const table = pickTable();

/** Devuelve `text` traducido al idioma del sistema (o tal cual, en inglés). */
export function _(text) {
    return table?.[text] ?? text;
}
