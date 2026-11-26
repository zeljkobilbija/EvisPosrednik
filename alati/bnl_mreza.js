/*
 * Priprema mreže Beneluksa za alati/bnl.js (pokreće se ručno posle osvežavanja podataka u BeneluxRoadInfo):
 *   node alati/bnl_mreza.js ../BeneluxRoadInfo/app/src/main/assets alati/bnl_mreza.json
 * Iz aplikacije uzima: geometrija.bin (linija kolovoza svakog autoputa) i autoputevi/*.json (izlazi sa km i
 * smerovi deonica). Rezultat: {putevi:[{id, sek:[[plus, minus]], iz:[[ime, km, lat, lon, si]]}], geo:[[put, [lat,lon,…]]]}
 * (koordinate ·1e5, celi brojevi).
 */
'use strict';
const fs = require('fs'), path = require('path');
const [asseti, izlaz] = process.argv.slice(2);
if (!asseti || !izlaz) { console.error('upotreba: node alati/bnl_mreza.js <assets> <izlaz.json>'); process.exit(1); }

const putevi = [];
for (const f of fs.readdirSync(path.join(asseti, 'autoputevi')).filter(f => f.endsWith('.json')).sort()) {
  const j = JSON.parse(fs.readFileSync(path.join(asseti, 'autoputevi', f), 'utf8'));
  putevi.push({
    id: j.id,
    sek: (j.sekcije || []).map(s => [s.plus || s.do || '', s.minus || s.od || '']),
    iz: (j.stavke || []).filter(s => s.t === 'A' && s.n && s.la != null)
      .map(s => [s.n, s.km, Math.round(s.la * 1e5), Math.round(s.lo * 1e5), s.si || 0]),
  });
}
const indeks = new Map(putevi.map((p, i) => [p.id, i]));

// geometrija.bin (DataOutputStream, big-endian): broj autoputeva; za svaki: UTF ime, broj linija, linije (n, n×[lat, lon]·1e5)
const b = fs.readFileSync(path.join(asseti, 'geometrija.bin'));
let o = 0;
const int = () => { const v = b.readInt32BE(o); o += 4; return v; };
const utf = () => { const n = b.readUInt16BE(o); o += 2; const s = b.toString('utf8', o, o + n); o += n; return s; };
const geo = [];
const na = int();
for (let a = 0; a < na; a++) {
  const ime = utf();
  const np = int();
  for (let p = 0; p < np; p++) {
    const n = int(), t = [];
    for (let i = 0; i < n; i++) t.push(int(), int());
    const k = indeks.get(ime);
    if (k !== undefined) geo.push([k, t]);
  }
}
fs.writeFileSync(izlaz, JSON.stringify({ putevi, geo }));
console.log('autoputeva', putevi.length, 'linija', geo.length, 'izlaza', putevi.reduce((s, p) => s + p.iz.length, 0),
  '–', fs.statSync(izlaz).size, 'B');
