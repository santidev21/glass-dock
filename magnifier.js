// Matemática de magnificación estilo macOS, sin dependencias de Clutter
// (se puede probar con gjs plano: ver test/magnifier.test.js).
//
// La idea: cada ícono recibe una escala según su distancia al puntero
// (curva coseno², suave y sin picos). Los íconos crecen "hacia afuera"
// y se reparten de forma que el punto exacto bajo el puntero no se mueve,
// así el ícono que estás apuntando nunca se escapa del cursor.
//
// Todo el resultado se aplica como transformaciones (scale/translation),
// que la GPU resuelve sin recalcular el layout: por eso es fluido.

/**
 * @param {{x: number, width: number, magnify: boolean}[]} items layout en reposo
 * @param {number} pointerX posición del puntero en las mismas coordenadas
 * @param {{maxScale: number, range: number}} opts range en px
 */
export function computeMagnification(items, pointerX, {maxScale, range}) {
    const n = items.length;
    if (n === 0)
        return null;

    const scales = items.map(it => {
        if (!it.magnify)
            return 1;
        const d = Math.abs(it.x + it.width / 2 - pointerX);
        if (d >= range)
            return 1;
        const t = Math.cos((d / range) * Math.PI / 2);
        return 1 + (maxScale - 1) * t * t;
    });

    // Nuevo layout acumulado, conservando los huecos originales entre ítems.
    const nx = new Array(n);
    let cursor = items[0].x;
    for (let i = 0; i < n; i++) {
        nx[i] = cursor;
        cursor += items[i].width * scales[i];
        if (i < n - 1)
            cursor += items[i + 1].x - (items[i].x + items[i].width);
    }

    // Ancla: el punto bajo el puntero queda fijo.
    const first = items[0];
    const last = items[n - 1];
    const lastEndRest = last.x + last.width;
    const lastEndNew = nx[n - 1] + last.width * scales[n - 1];
    let shift;
    if (pointerX <= first.x) {
        shift = 0;
    } else if (pointerX >= lastEndRest) {
        shift = lastEndRest - lastEndNew;
    } else {
        const k = items.findIndex(it => pointerX < it.x + it.width);
        const it = items[k];
        if (pointerX < it.x) // en un hueco entre ítems
            shift = it.x - nx[k];
        else
            shift = pointerX - (nx[k] + (pointerX - it.x) * scales[k]);
    }

    const offsets = items.map((it, i) =>
        (nx[i] + shift + it.width * scales[i] / 2) - (it.x + it.width / 2));

    return {
        scales,
        offsets,
        extraLeft: first.x - (nx[0] + shift),
        extraRight: (lastEndNew + shift) - lastEndRest,
    };
}
