// Ajustes del dock.
//
// Los valores que el usuario puede cambiar desde Preferencias (tamaño y
// magnificación) son `export let`: los imports de ES son enlaces vivos, así
// que tras llamar a configure() todos los módulos ven el valor nuevo.

// --- Configurables (ver schemas/ y prefs.js) ---
export let ICON_SIZE = 48;       // tamaño en reposo (px lógicos)
export let MAX_SCALE = 1.6;      // escala máxima bajo el puntero (1 = sin zoom)
// Los íconos se renderizan a la resolución máxima y se reducen en reposo,
// así al magnificar se ven nítidos (no se estira una textura pequeña).
export let ICON_HI = 77;
export let SLOT_WIDTH = 56;
export let CORNER_RADIUS = 20;

export const ITEM_PADDING = 4;   // espacio horizontal a cada lado del ícono
export const DOT_AREA = 10;      // espacio bajo el ícono para el punto indicador
export const MAGNIFY_RANGE = 3;  // alcance del zoom, en "ranuras" de ícono

export let LIVE_BLUR = true;

export function configure({iconSize = 48, magnification = 1.6, liveBlur = true} = {}) {
    LIVE_BLUR = liveBlur;
    ICON_SIZE = Math.round(iconSize);
    MAX_SCALE = Math.max(1, magnification);
    ICON_HI = Math.round(ICON_SIZE * MAX_SCALE);
    SLOT_WIDTH = ICON_SIZE + 2 * ITEM_PADDING;
    // El radio crece con el dock (alto ≈ ícono + 20px)
    CORNER_RADIUS = Math.round((ICON_SIZE + 20) * 0.3);
}

// --- Vidrio ---
export const BLUR_RADIUS = 40;
export const BLUR_BRIGHTNESS = 0.97;
export const BOTTOM_MARGIN = 6;  // separación respecto al borde inferior

// --- Animaciones (ms) ---
// Mostrar: ease-out cúbico (arranca con decisión y frena suave, sin "salto").
// Ocultar: ease-in-out (despega y aterriza suave).
export const SHOW_DURATION = 300;
export const HIDE_DURATION = 260;
export const HIDE_DELAY = 350;          // espera antes de ocultar al salir el mouse
export const MAGNIFY_ENTER_MS = 140;    // suavizado al entrar el puntero
export const UNMAGNIFY_MS = 220;
export const ITEM_ANIM_MS = 200;        // aparecer/desaparecer íconos

// --- Revelado por presión en el borde inferior ---
export const PRESSURE_THRESHOLD = 80;   // px de "empuje"
export const PRESSURE_TIMEOUT = 1000;
export const REVEAL_GRACE = 900;        // si el mouse no entra al dock en este tiempo, se vuelve a ocultar
