/*
 * Planirani događaji EVIS.AT / ASFINAG (gradilišta, radovi) → mali fajl planirano.json za posrednika.
 * Pokreće ga GitHub Action jednom na sat (ključ je tajna EVIS_KEY u GitHub-u):
 *   EVIS_KEY=… node alati/planirano.js izlaz/planirano.json
 * Izvorni GeoJSON je ~2,8 MB (crteži trase); ovde ostaju samo trenutno aktivni događaji,
 * sa početnom i krajnjom tačkom – isti oblik zapisa kao neplanirani u src/index.js.
 */
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');

const IZVOR = 'https://datasupply-evis.asfinag.at/1.0/getdata/EventsPlannedGeoJson/AT-ASF/1.0?apiKey=';

(async () => {
  const kljuc = process.env.EVIS_KEY;
  if (!kljuc) throw new Error('nema EVIS_KEY');
  const r = await fetch(IZVOR + kljuc);
  if (!r.ok) throw new Error('EVIS HTTP ' + r.status);
  let b = Buffer.from(await r.arrayBuffer());
  if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
  const gj = JSON.parse(b.toString('utf8'));
  const sad = Date.now();
  const out = [];
  for (const f of gj.features || []) {
    const p = f.properties || {};
    const st = Date.parse(p['start-time'] || '') || 0, en = Date.parse(p['stop-time'] || '') || 0;
    if (st && st > sad) continue;   // još nije počelo
    if (en && en < sad) continue;   // završeno
    const opis = String(p.description || '').trim();
    const m = String(p.roadcode || '').match(/^([AS])0*(\d+)/) || opis.match(/^([AS])0*(\d+)\b/);
    if (!m) continue;
    // "In Fahrtrichtung von Salzburg nach Villach zwischen Anschlussstelle X und Anschlussstelle Y ist …"
    const smer = (opis.match(/Fahrtrichtung von .+? nach ([^,]+?) (?:zwischen|bei|im|in|auf|ist|sind|wird)/) || [, ''])[1].trim();
    const izmedju = opis.match(/zwischen (?:Anschlussstelle |Knoten |Halbanschlussstelle )?(.+?) und (?:Anschlussstelle |Knoten |Halbanschlussstelle )?(.+?) (?:ist|sind|wird|werden|kommt|gilt)/);
    const kod = opis.match(/bei (?:Anschlussstelle |Knoten |Halbanschlussstelle )?(.+?) (?:Auffahrtsrampe|Abfahrtsrampe|ist|sind|wird|werden)/);
    const mesto = izmedju ? izmedju[1] + ' – ' + izmedju[2] : kod ? kod[1] : '';
    let t = ['MaintenanceWorks'], d = [];
    if (/Totalsperre|ist die (?:A|S)\d+ (?:komplett )?gesperrt|Richtungsfahrbahn gesperrt|Fahrbahn (?:ist )?(?:komplett )?gesperrt/.test(opis)) {
      t = ['RoadOrCarriagewayOrLaneManagement']; d = ['roadClosed', 'mainCarriageway'];
    } else if (/(?:Fahrstreifen|Pannenstreifen)[^,]*gesperrt/.test(opis)) {
      // i na rampi ("Abfahrtsrampe ist der Pannenstreifen gesperrt") – samo traka, ne cela rampa
      t = ['RoadOrCarriagewayOrLaneManagement', 'MaintenanceWorks']; d = ['laneClosures'];
    } else if (/(?:Auffahrtsrampe|Abfahrtsrampe|Rampe) gesperrt/.test(opis)) {
      t = ['RoadOrCarriagewayOrLaneManagement']; d = ['roadClosed', 'slipRoads'];
    }
    const k = (f.geometry && f.geometry.coordinates) || [];
    const linija = f.geometry && f.geometry.type === 'MultiLineString' ? k.flat() : k;
    const prva = linija[0], posl = linija[linija.length - 1];
    const a = Array.isArray(prva) ? [+prva[1].toFixed(6), +prva[0].toFixed(6)] : null;
    let bb = Array.isArray(posl) ? [+posl[1].toFixed(6), +posl[0].toFixed(6)] : null;
    if (a && bb && a[0] === bb[0] && a[1] === bb[1]) bb = null;
    out.push({ id: p.id, p: [m[1] + m[2]], t, d, st, en, o: opis, m: mesto, s: smer, a, b: bb,
      man: p['compliance-option'] === 'mandatory', pl: true });
  }
  const izlaz = process.argv[2] || 'planirano.json';
  fs.mkdirSync(path.dirname(path.resolve(izlaz)), { recursive: true });
  fs.writeFileSync(izlaz, JSON.stringify({ izvor: 'EVIS.AT / ASFINAG, CC BY 4.0 ASFINAG', vreme: sad, dogadjaji: out }));
  console.log('aktivnih planiranih:', out.length, 'od', (gj.features || []).length, '–', fs.statSync(izlaz).size, 'B');
})().catch(e => { console.error(e.message); process.exit(1); });
