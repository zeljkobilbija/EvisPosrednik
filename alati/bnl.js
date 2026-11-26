/*
 * Beneluks: vesti o saobraćaju na autoputevima → bnl.json za posrednika (ruta /bnl?put=NL-A2).
 *   node alati/bnl.js izlaz/bnl.json
 * Izvori (svi otvoreni, bez ključa):
 *  - NL: NDW „actueel_beeld“ (DATEX II 3, gzip ~0,3 MB) – licenca CC0 (navođenje izvora nije obavezno, ali ga navodimo)
 *  - BE (Flandrija): Verkeerscentrum Vlaanderen / Agentschap Wegen en Verkeer, DATEX II 3 – CC BY (obavezno navesti)
 *  - LU: CITA / Administration des ponts et chaussées, DATEX II 3.6 – CC0
 * Izvori nemaju (NL, BE) ili nemaju pouzdan (LU) broj autoputa u obliku naše aplikacije, pa se svaka vest
 * smešta po koordinatama na najbliži autoput iz alati/bnl_mreza.json (geometrija i izlazi iz BeneluxRoadInfo).
 * Zapis je isti kao /vesti, /uk i /ch: {id, p, t, d, st, en, o, m, s, a, b, man, pl}; m = „izlaz – izlaz“,
 * s = pravac (kraj deonice u smeru vožnje), a/b = početak i kraj u smeru vožnje.
 */
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');

const NL = 'https://opendata.ndw.nu/actueel_beeld.xml.gz';
const VL = 'https://www.verkeerscentrum.be/uitwisseling/datex2v3';
const LU = 'https://cita.lu/info_trafic/datex/situationrecord36';
const NATPIS = 'NDW (NL, CC0) · Verkeerscentrum Vlaanderen (CC BY) · CITA Luxembourg (CC0)';
const NA_PUTU_M = 120;      // tačka dalje od kolovoza od ovoga nije na autoputu
const T = '(?:\\w+:)?';

const mreza = JSON.parse(fs.readFileSync(path.join(__dirname, 'bnl_mreza.json'), 'utf8'));

// ---------- prostorni indeks (ćelije 0,01°) ----------
const CEL = 0.01;
const celije = new Map();
for (const [k, t] of mreza.geo) {
  for (let i = 2; i < t.length; i += 2) {
    const la1 = t[i - 2] / 1e5, lo1 = t[i - 1] / 1e5, la2 = t[i] / 1e5, lo2 = t[i + 1] / 1e5;
    const s = [k, la1, lo1, la2, lo2];
    for (let ci = Math.floor(Math.min(la1, la2) / CEL); ci <= Math.floor(Math.max(la1, la2) / CEL); ci++)
      for (let cj = Math.floor(Math.min(lo1, lo2) / CEL); cj <= Math.floor(Math.max(lo1, lo2) / CEL); cj++) {
        const kl = ci + ',' + cj;
        if (!celije.has(kl)) celije.set(kl, []);
        celije.get(kl).push(s);
      }
  }
}
/** Udaljenost tačke od duži u metrima (ravna aproksimacija, dovoljna za ~100 m). */
function odDuzi(la, lo, s) {
  const kx = 111320 * Math.cos(la * Math.PI / 180), ky = 110540;
  const ax = (s[2] - lo) * kx, ay = (s[1] - la) * ky, bx = (s[4] - lo) * kx, by = (s[3] - la) * ky;
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let u = l2 ? -(ax * dx + ay * dy) / l2 : 0;
  u = Math.max(0, Math.min(1, u));
  return Math.hypot(ax + u * dx, ay + u * dy);
}
/** Udaljenost (m) tačke do svakog autoputa u blizini: Map(indeks → m). */
function blizu(la, lo) {
  const r = new Map();
  const ci = Math.floor(la / CEL), cj = Math.floor(lo / CEL);
  for (let i = ci - 1; i <= ci + 1; i++)
    for (let j = cj - 1; j <= cj + 1; j++)
      for (const s of celije.get(i + ',' + j) || []) {
        const d = odDuzi(la, lo, s);
        if (d < NA_PUTU_M && d < (r.get(s[0]) ?? Infinity)) r.set(s[0], d);
      }
  return r;
}
function metara(la1, lo1, la2, lo2) {
  const kx = 111320 * Math.cos(la1 * Math.PI / 180);
  return Math.hypot((lo2 - lo1) * kx, (la2 - la1) * 110540);
}
/** Kilometar tačke na autoputu: između dva najbliža izlaza, srazmerno udaljenostima. */
function kmNa(put, la, lo) {
  const iz = put.iz.map(x => [metara(la, lo, x[2] / 1e5, x[3] / 1e5), x]).sort((a, b) => a[0] - b[0]);
  if (!iz.length) return null;
  if (iz.length === 1) return { km: iz[0][1][1], iz1: iz[0][1], iz2: null };
  const [d1, e1] = iz[0], [d2, e2] = iz[1];
  return { km: e1[1] + (e2[1] - e1[1]) * d1 / Math.max(1, d1 + d2), iz1: e1, iz2: e2 };
}

// ---------- Belgijski Lambert 72 (EPSG:31370) → WGS84 ----------
function lambert72(x, y) {
  const a = 6378388, f = 1 / 297, e = Math.sqrt(2 * f - f * f);
  const rad = d => d * Math.PI / 180;
  const f1 = rad(49 + 50 / 60 + 0.00204 / 3600), f2 = rad(51 + 10 / 60 + 0.00204 / 3600);
  const f0 = rad(90), l0 = rad(4 + 22 / 60 + 2.952 / 3600), x0 = 150000.013, y0 = 5400088.438;
  const m = p => Math.cos(p) / Math.sqrt(1 - e * e * Math.sin(p) ** 2);
  const t = p => Math.tan(Math.PI / 4 - p / 2) / ((1 - e * Math.sin(p)) / (1 + e * Math.sin(p))) ** (e / 2);
  const n = (Math.log(m(f1)) - Math.log(m(f2))) / (Math.log(t(f1)) - Math.log(t(f2)));
  const F = m(f1) / (n * t(f1) ** n), r0 = a * F * t(f0) ** n;
  const dx = x - x0, dy = r0 - (y - y0);
  const r = Math.sign(n) * Math.hypot(dx, dy), tt = (r / (a * F)) ** (1 / n), th = Math.atan2(dx, dy);
  let p = Math.PI / 2 - 2 * Math.atan(tt);
  for (let i = 0; i < 8; i++) p = Math.PI / 2 - 2 * Math.atan(tt * ((1 - e * Math.sin(p)) / (1 + e * Math.sin(p))) ** (e / 2));
  const lam = th / n + l0;
  // BD72 (Hayford) → WGS84: geocentrično + Helmert (EPSG:1609, pomeranja u m, rotacije ″ – „position vector“)
  const N = a / Math.sqrt(1 - e * e * Math.sin(p) ** 2);
  const X = N * Math.cos(p) * Math.cos(lam), Y = N * Math.cos(p) * Math.sin(lam), Z = N * (1 - e * e) * Math.sin(p);
  const s = 1 + 1.2747e-6, sek = Math.PI / 180 / 3600;
  const rx = -0.3366 * sek, ry = 0.457 * sek, rz = -1.8422 * sek;
  const X2 = -106.8686 + s * (X - rz * Y + ry * Z), Y2 = 52.2978 + s * (rz * X + Y - rx * Z), Z2 = -103.7239 + s * (-ry * X + rx * Y + Z);
  const A = 6378137, E2 = 0.00669437999014, P = Math.hypot(X2, Y2);
  let la = Math.atan2(Z2, P * (1 - E2));
  for (let i = 0; i < 6; i++) { const Nn = A / Math.sqrt(1 - E2 * Math.sin(la) ** 2); la = Math.atan2(Z2 + E2 * Nn * Math.sin(la), P); }
  return [la * 180 / Math.PI, Math.atan2(Y2, X2) * 180 / Math.PI];
}

// ---------- DATEX II 3 ----------
const prvi = (s, re) => { const m = s.match(re); return m ? m[1] : null; };
const sviTagovi = (s, tag) => [...s.matchAll(new RegExp('<' + T + tag + '[^>]*>([^<]*)<', 'g'))].map(m => m[1]);
const vreme = s => { const t = Date.parse(s || ''); return isNaN(t) ? 0 : t; };
const xml = t => String(t || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** Tačke lokacije zapisa [[lat, lon], …] u WGS84 redom kako su date. */
function tacke(z, lambert) {
  const out = [];
  const pretvori = (p, q) => lambert ? lambert72(q, p) : [p, q]; // Lambert: „latitude“ = y, „longitude“ = x
  for (const pl of sviTagovi(z, 'posList')) {
    const v = pl.trim().split(/\s+/).map(Number);
    for (let i = 0; i + 1 < v.length; i += 2) out.push(lambert ? lambert72(v[i], v[i + 1]) : [v[i], v[i + 1]]);
  }
  const la = sviTagovi(z, 'latitude').map(Number), lo = sviTagovi(z, 'longitude').map(Number);
  for (let i = 0; i < Math.min(la.length, lo.length); i++) out.push(pretvori(la[i], lo[i]));
  return out.filter(([a, b]) => isFinite(a) && isFinite(b) && a > 49 && a < 54 && b > 2 && b < 8);
}

function obradi(tekst, zemlja, lambert, sad, out) {
  let ukupno = 0;
  const reSit = new RegExp('<' + T + 'situation [^>]*id="([^"]+)"[^>]*>([\\s\\S]*?)</' + T + 'situation>', 'g');
  let m;
  while ((m = reSit.exec(tekst))) {
    ukupno++;
    const id = m[1], s = m[2];
    if ((prvi(s, new RegExp('<' + T + 'informationStatus[^>]*>([^<]+)<')) || 'real') !== 'real') continue;
    const tipovi = [], podtipovi = [], tck = [], opisi = [];
    let st = 0, en = 0, planirano = false, kasn = 0;
    const reZap = new RegExp('<' + T + 'situationRecord [^>]*xsi:type="' + T + '(\\w+)"[^>]*>([\\s\\S]*?)</' + T + 'situationRecord>', 'g');
    let z;
    while ((z = reZap.exec(s))) {
      const v = prvi(z[2], new RegExp('<' + T + 'validityStatus[^>]*>([^<]+)<')) || 'active';
      const zSt = vreme(prvi(z[2], new RegExp('<' + T + 'overallStartTime[^>]*>([^<]+)<')));
      const kraj = Math.max(0, ...sviTagovi(z[2], 'overallEndTime').map(vreme), ...sviTagovi(z[2], 'endOfPeriod').map(vreme));
      if (v === 'suspended' || (zSt && zSt > sad + 10 * 60_000) || (kraj && kraj < sad)) continue;
      if (!tipovi.includes(z[1])) tipovi.push(z[1]);
      if (zSt && (!st || zSt < st)) st = zSt;
      if (kraj) en = Math.max(en, kraj);
      for (const tag of ['abnormalTrafficType', 'roadOrCarriagewayOrLaneManagementType', 'roadMaintenanceType',
        'constructionWorkType', 'vehicleObstructionType', 'accidentType', 'carriageway', 'causeType',
        'obstructionType', 'generalNetworkManagementType', 'reroutingManagementType'])
        for (const w of sviTagovi(z[2], tag).map(x => x.trim()).filter(Boolean)) if (!podtipovi.includes(w)) podtipovi.push(w);
      if (/MaintenanceWorks|ConstructionWorks/.test(z[1]) || /roadMaintenance|roadworks/.test(z[2])) planirano = true;
      // NDW: „stilstaand voertuig“ (VehicleObstruction other/stationary) – vozilo stoji, bez obaveštenja kao kvar
      if (z[1] === 'VehicleObstruction' && /vehicleObstructionType[^>]*>(?:other|brokenDownVehicle)</.test(z[2]) && !podtipovi.includes('brokenDownVehicle')) podtipovi.push('brokenDownVehicle');
      const d = Number(prvi(z[2], new RegExp('<' + T + 'delayTimeValue[^>]*>([^<]+)<')));
      if (d > kasn) kasn = d;
      for (const p of tacke(z[2], lambert)) tck.push(p);
      // tekst: NL causeDescription (nl), LU komentari (fr pre lb)
      for (const blok of z[2].match(new RegExp('<' + T + '(?:causeDescription|comment)[\\s>][\\s\\S]*?</' + T + '(?:causeDescription|comment)>', 'g')) || []) {
        const t = xml(prvi(blok, /lang="(?:fr|nl|en)">([^<]*)</) || prvi(blok, /lang="[^"]*">([^<]*)</));
        if (t && !opisi.includes(t) && !/^Section courante$/i.test(t)) opisi.push(t);
      }
    }
    if (!tipovi.length || !tck.length) continue;
    // samo stvarne smetnje: brzinska ograničenja i preusmeravanja bez zatvaranja nisu vest
    if (tipovi.every(t => /SpeedManagement|ReroutingManagement|GeneralNetworkManagement/.test(t))) continue;

    // autoput: onaj na kome leži najviše tačaka (prosečna udaljenost odlučuje pri jednakom broju)
    const glas = new Map();
    for (const [la, lo] of tck) for (const [k, d] of blizu(la, lo)) {
      const g = glas.get(k) || [0, 0];
      g[0]++; g[1] += d; glas.set(k, g);
    }
    if (!glas.size) continue;
    const [k] = [...glas].sort((x, y) => y[1][0] - x[1][0] || x[1][1] / x[1][0] - y[1][1] / y[1][0])[0];
    const put = mreza.putevi[k];
    if (!put.id.startsWith(zemlja + '-') && zemlja !== 'NL') { /* granični delovi: zadržava se autoput koji je pogođen */ }
    const naPutu = tck.filter(([la, lo]) => blizu(la, lo).has(k));
    const p1 = naPutu[0], p2 = naPutu.length > 1 ? naPutu[naPutu.length - 1] : null;
    const k1 = kmNa(put, p1[0], p1[1]), k2 = p2 ? kmNa(put, p2[0], p2[1]) : null;
    let b = p2 && metara(p1[0], p1[1], p2[0], p2[1]) > 200 ? p2 : null;
    // mesto: izlazi oko početka (i kraja), smer: kuda raste ili opada kilometar
    let mesto = '', smer = '';
    if (k1) {
      if (b && k2) {
        const [od, doo] = k1.km <= k2.km ? [k1, k2] : [k2, k1];
        const a1 = od.iz2 && od.iz2[1] < od.iz1[1] ? od.iz2 : od.iz1, a2 = doo.iz2 && doo.iz2[1] > doo.iz1[1] ? doo.iz2 : doo.iz1;
        mesto = a1[0] === a2[0] ? a1[0] : a1[0] + ' – ' + a2[0];
        const raste = k2.km > k1.km, sek = put.sek[k1.iz1[4]] || put.sek[0];
        if (sek && Math.abs(k2.km - k1.km) > 0.2) smer = raste ? sek[0] : sek[1];
        if (!raste) mesto = mesto.split(' – ').reverse().join(' – ');
      } else {
        const x = [k1.iz1, k1.iz2].filter(Boolean).sort((u, w) => u[1] - w[1]);
        mesto = x.length > 1 && x[0][0] !== x[1][0] ? x[0][0] + ' – ' + x[1][0] : x[0][0];
      }
    }
    const r = v => [+v[0].toFixed(5), +v[1].toFixed(5)];
    out.push({
      id: zemlja + '_' + id, p: [put.id], t: tipovi, d: podtipovi, st, en,
      o: opisi.join(' · '), m: mesto, s: smer, a: r(p1), b: b ? r(b) : null,
      man: /complianceOption[^>]*>mandatory/.test(s), pl: planirano, ...(kasn ? { k: Math.round(kasn / 60) } : {}),
    });
  }
  return ukupno;
}

async function preuzmi(url, gz) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (BeneluxRoadInfo posrednik)' } });
  if (!r.ok) throw new Error(url + ' HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  return (gz ? zlib.gunzipSync(buf) : buf).toString('utf8');
}

(async () => {
  const sad = Date.now(), out = [], izvestaj = [];
  for (const [ime, url, gz, lambert] of [['NL', NL, true, false], ['BE', VL, false, true], ['LU', LU, false, false]]) {
    try {
      const pre = out.length;
      const n = obradi(await preuzmi(url, gz), ime, lambert, sad, out);
      izvestaj.push(ime + ' ' + (out.length - pre) + '/' + n);
    } catch (e) {
      izvestaj.push(ime + ' GREŠKA ' + e.message); // jedan izvor ne sme da obori ostale
    }
  }
  const izlaz = process.argv[2] || 'bnl.json';
  fs.mkdirSync(path.dirname(path.resolve(izlaz)), { recursive: true });
  fs.writeFileSync(izlaz, JSON.stringify({ izvor: NATPIS, vreme: sad, dogadjaji: out }));
  console.log(izvestaj.join(' · '), '–', fs.statSync(izlaz).size, 'B');
  if (!out.length) process.exit(1);
})().catch(e => { console.error(e.message); process.exit(1); });
