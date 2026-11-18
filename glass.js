// Fondo de vidrio del dock.
//
// Blur en vivo con esquinas redondeadas:
//  - Shell.BlurEffect en modo BACKGROUND dibuja un rectángulo: no respeta
//    esquinas redondeadas ni se puede enmascarar (lee del framebuffer).
//  - En su lugar desenfocamos (modo ACTOR) un CLON del grupo de ventanas
//    (ventanas + wallpaper) y lo recortamos con un shader de esquinas
//    redondeadas con antialias. En el Overview se usa el wallpaper.
//  - Con live-blur=false solo se desenfoca una copia del wallpaper.
//
// Rendimiento (clave en pantallas grandes / GPU integrada):
//  - Solo se desenfoca una FRANJA del tamaño del dock (+ margen para el zoom),
//    no el monitor completo: en 3440x1440 son ~100 veces menos píxeles.
//  - La franja desenfocada NUNCA se mueve. Para compensar el deslizamiento y
//    la magnificación se mueve su contenedor padre (_holder). Si se moviera el
//    actor con el blur, Clutter lo marcaría "sucio" y recalcularía el blur en
//    cada frame; así queda en caché y cada frame solo se recompone.
//
// Jerarquía:
//   Glass (clip + máscara redondeada)
//     ├ _holder   (se desplaza: compensa x/translation_y)
//     │   └ _strip   (franja bajo el dock, clip, BLUR en caché)
//     │       ├ _wall   (BackgroundManager: el wallpaper, para el Overview)
//     │       └ _live   (clon de global.window_group: blur en vivo)
//     └ _tint     (tinte + borde de luz, CSS)

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';

import {BLUR_BRIGHTNESS, BLUR_RADIUS, CORNER_RADIUS, LIVE_BLUR} from './config.js';

// Margen extra de la franja a cada lado (cubre la magnificación sin redimensionar).
const STRIP_PAD = 160;

// Distancia con signo a un rectángulo redondeado (SDF) → alfa con antialias de 1px.
const MASK_DECLARATIONS = `
uniform vec2 u_size;
uniform float u_radius;
`;
const MASK_CODE = `
vec2 p = cogl_tex_coord0_in.xy * u_size;
vec2 q = abs(p - u_size * 0.5) - (u_size * 0.5 - vec2(u_radius));
float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - u_radius;
cogl_color_out *= clamp(0.5 - d, 0.0, 1.0);
`;

const RoundedMaskEffect = GObject.registerClass(
class GlassDockRoundedMask extends Clutter.ShaderEffect {
    vfunc_get_static_snippet() {
        return Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT,
            MASK_DECLARATIONS, MASK_CODE);
    }

    setGeometry(width, height, radius) {
        this.set_uniform_float('u_size', 2, [width, height]);
        this.set_uniform_float('u_radius', 1, [Math.min(radius, height / 2, width / 2)]);
    }
});

export const Glass = GObject.registerClass(
class GlassDockGlass extends St.Widget {
    _init(monitorIndex) {
        super._init({
            style_class: 'glass-dock-glass',
            layout_manager: new Clutter.FixedLayout(),
            clip_to_allocation: true,
            reactive: false,
        });
        this._monitorIndex = monitorIndex;

        this._holder = new Clutter.Actor();
        this._strip = new Clutter.Actor({clip_to_allocation: true});
        // El efecto va en la franja (no en el actor del fondo) porque
        // BackgroundManager reemplaza ese actor al cambiar de wallpaper.
        this._wall = new Clutter.Actor();
        this._holder.add_child(this._strip);
        this._strip.add_child(this._wall);
        this.add_child(this._holder);
        this._stripX = 0;

        // Blur en vivo: un clon del grupo de ventanas (incluye el wallpaper).
        // El clon solo invalida el blur cuando algo de debajo se redibuja.
        // En el Overview las ventanas reales están ocultas → se usa el wallpaper.
        if (LIVE_BLUR) {
            this._live = new Clutter.Clone({source: global.window_group});
            this._strip.add_child(this._live);
            Main.overview.connectObject(
                'showing', () => this._syncLive(),
                'hidden', () => this._syncLive(), this);
            this._syncLive();
        }

        this._bgManager = new Background.BackgroundManager({
            container: this._wall,
            monitorIndex,
            vignette: false,
            controlPosition: false,
        });
        this._strip.add_effect(new Shell.BlurEffect({
            mode: Shell.BlurMode.ACTOR,
            radius: BLUR_RADIUS,
            brightness: BLUR_BRIGHTNESS,
        }));

        // Tinte + borde de luz (se adapta a tema claro/oscuro por CSS).
        this._tint = new St.Widget({
            style_class: 'glass-dock-tint',
            style: `border-radius: ${CORNER_RADIUS}px;`,
        });
        this._tint.add_constraint(new Clutter.BindConstraint({
            source: this,
            coordinate: Clutter.BindCoordinate.SIZE,
        }));
        this.add_child(this._tint);

        this._mask = new RoundedMaskEffect();
        this.add_effect(this._mask);
        this.connect('notify::allocation', () => {
            const box = this.get_allocation_box();
            this._mask.setGeometry(box.get_width(), box.get_height(), CORNER_RADIUS);
        });

        this.connect('destroy', () => {
            Main.overview.disconnectObject(this);
            this._bgManager?.destroy();
            this._bgManager = null;
        });
    }

    _syncLive() {
        const overview = Main.overview.visible;
        this._live.visible = !overview;
        this._wall.visible = overview;
    }

    /**
     * @param {object} g
     * @param {number} g.x posición del vidrio dentro del dock
     * @param {number} g.width
     * @param {number} g.height
     * @param {number} g.wallX origen del monitor relativo al dock (x)
     * @param {number} g.wallY origen del monitor relativo al dock (y, ≤ 0)
     * @param {number} [duration] si > 0, anima el cambio
     */
    setGeometry({x, width, height, wallX, wallY}, duration = 0) {
        // La franja va desde el borde superior del dock hasta el fondo del
        // monitor, y solo cubre el ancho del dock (+ margen para el zoom).
        const mon = Main.layoutManager.monitors[this._monitorIndex];
        const left = x - wallX;            // borde izq. del vidrio, relativo al monitor
        const right = left + width;
        const stripH = Math.max(1, Math.ceil(mon.height + wallY));
        const covers = left >= this._stripX && right <= this._stripX + this._strip.width;
        const atRest = x === 0 && duration === 0;
        const snugW = width + 2 * STRIP_PAD;
        if (!covers || this._strip.height !== stripH ||
            (atRest && this._strip.width !== snugW)) {
            // Solo aquí se recalcula el blur por cambio de tamaño.
            this._stripX = Math.max(0, Math.floor(left - STRIP_PAD));
            const stripW = Math.min(mon.width - this._stripX, Math.ceil(right + STRIP_PAD) - this._stripX);
            this._strip.set_position(this._stripX, 0);
            this._strip.set_size(stripW, stripH);
            this._wall.set_position(-this._stripX, wallY);
            this._live?.set_position(-this._stripX - mon.x, wallY - mon.y);
        }

        const hx = wallX - x;
        if (duration > 0) {
            const params = {duration, mode: Clutter.AnimationMode.EASE_OUT_QUAD};
            this.ease({x, width, ...params});
            this._holder.ease({x: hx, ...params});
        } else {
            this.remove_transition('x');
            this.remove_transition('width');
            this._holder.remove_transition('x');
            this.set_position(x, 0);
            this.width = width;
            this._holder.x = hx;
        }
        this.height = height;
    }

    /** Compensa el deslizamiento del dock para que el fondo no "viaje". */
    setWallTranslationY(ty) {
        this._holder.translation_y = -ty;
    }
});
