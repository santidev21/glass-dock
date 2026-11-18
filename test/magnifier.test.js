// Ejecutar: gjs -m test/magnifier.test.js
import {computeMagnification} from '../magnifier.js';

const W = 56;
const items = Array.from({length: 8}, (_, i) => ({x: 8 + i * W, width: W, magnify: i !== 4}));
const opts = {maxScale: 1.6, range: 3 * W};
let fails = 0;
const check = (cond, msg) => { if (!cond) { fails++; print('FAIL', msg); } };

// 1) Lejos del dock → sin cambios
let r = computeMagnification(items, -1000, opts);
check(r.scales.every(s => s === 1) && r.offsets.every(o => Math.abs(o) < 1e-9), 'reposo');

// 2) Barrido: continuidad y punto bajo el cursor fijo
let prev = null;
for (let px = 0; px <= 8 + 8 * W + 8; px += 0.5) {
    r = computeMagnification(items, px, opts);
    if (prev) {
        const jump = Math.max(...r.offsets.map((o, i) => Math.abs(o - prev.offsets[i])));
        check(jump < 2, `salto ${jump.toFixed(2)} en px=${px}`);
    }
    const k = items.findIndex(it => px >= it.x && px < it.x + it.width);
    if (k >= 0) {
        const it = items[k], s = r.scales[k];
        const restCenter = it.x + it.width / 2;
        const mapped = restCenter + r.offsets[k] + (px - restCenter) * s;
        check(Math.abs(mapped - px) < 1e-6, `ancla px=${px}`);
    }
    // sin solapes
    for (let i = 0; i < items.length - 1; i++) {
        const endI = items[i].x + items[i].width / 2 + r.offsets[i] + items[i].width * r.scales[i] / 2;
        const startJ = items[i + 1].x + items[i + 1].width / 2 + r.offsets[i + 1] - items[i + 1].width * r.scales[i + 1] / 2;
        check(startJ - endI > -1e-6, `solape ${i} px=${px}`);
    }
    prev = r;
}
check(computeMagnification(items, 8 + 1.5 * W, opts).scales[1] > 1.59, 'escala máxima');
check(computeMagnification(items, 8 + 4.5 * W, opts).scales[4] === 1, 'separador no escala');
print(fails === 0 ? 'OK: todas las pruebas pasaron' : `${fails} fallos`);
