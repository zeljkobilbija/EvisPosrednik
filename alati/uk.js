/*
 * Engleska: National Highways – Road and Lane Closures v2.0 (DATEX II 3.4) → mali fajl uk.json za posrednika.
 * Licenca: National Highways Licence (na osnovu OGL 2.0); obavezan natpis
 * "Powered by National Highways' Transport Data Feeds". Ključ je tajna NH_KEY (GitHub), nikad u kodu:
 *   NH_KEY=… node alati/uk.js izlaz/uk.json
 * Izvor je ceo SRN odjednom (0,5–6 MB XML), prevelik za telefon i besplatni Worker; ovde ostaju samo
 * zapisi koji važe baš sada (validityStatus ≠ suspended – noćni radovi danju ne smetaju) na autoputevima
 * (M…, A…(M)), u istom obliku zapisa kao EVIS u src/index.js: {id, p, t, d, st, en, o, m, s, a, b, man, pl}.
 */
'use strict';
const fs = require('fs'), path = require('path');

const IZVOR = 'https://api.data.nationalhighways.co.uk/roads/v2.0/closures';

const prvi = (s, re) => { const m = s.match(re); return m ? m[1] : null; };
const xml = t => String(t || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
const vreme = s => { const t = Date.parse(s || ''); return isNaN(t) ? 0 : t; };
const velikoPrvo = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';

(async () => {
  const kljuc = process.env.NH_KEY;
  if (!kljuc) throw new Error('nema NH_KEY');
  const r = await fetch(IZVOR, { headers: { 'Ocp-Apim-Subscription-Key': kljuc, Accept: 'application/xml' } });
  if (!r.ok) throw new Error('National Highways HTTP ' + r.status);
  const tekst = await r.text();
  const sad = Date.now();
  const out = [];
  const reSit = /<situation>([\s\S]*?)<\/situation>/g;
  let m, ukupno = 0;
  while ((m = reSit.exec(tekst))) {
    ukupno++;
    const s = m[1];
    if ((prvi(s, /<informationStatus>([^<]+)</) || 'real') !== 'real') continue;
    // zapisi u situaciji: uzima se prvi koji važi sada
    const reZap = /<situationRecord>([\s\S]*?)<\/situationRecord>/g;
    let z, zap = null;
    while ((z = reZap.exec(s))) {
      const v = prvi(z[1], /<validityStatus>([^<]+)</);
      const st = vreme(prvi(z[1], /<overallStartTime>([^<]+)</)), en = vreme(prvi(z[1], /<overallEndTime>([^<]+)</));
      if (v === 'suspended' || (st && st > sad) || (en && en < sad)) continue;
      zap = { x: z[1], st, en };
      break;
    }
    if (!zap) continue;
    const x = zap.x;
    const put = (prvi(x, /<roadName>([^<]+)</) || '').replace(/\s+/g, '').toUpperCase();
    if (!/^(M\d+|A\d+\(M\))$/.test(put)) continue; // samo autoputevi

    const opis = xml(prvi(x, /<generalPublicComment>[\s\S]*?<comment>([^<]*)</));
    const lokacija = xml(prvi(x, /<locationDescription>([^<]*)</));
    const izvorZap = prvi(x, /<sourceIdentification>([^<]+)</) || '';
    const uzrok = prvi(x, /<causeType>([^<]+)</) || '';
    const tipUpr = prvi(x, /<roadOrCarriagewayOrLaneManagementType>\s*<value>([^<]+)</) || '';
    const vrstaKol = prvi(x, /<linearElementType>([^<]+)</) || '';
    const operativnih = parseInt(prvi(x, /<numberOfOperationalLanes>(\d+)</) || '-1', 10);
    const ceo = /\b(?:carriageway|road) closure|closed\b/i.test(opis) && !/lane|hard shoulder|slip/i.test(opis);
    const rampa = /slip/i.test(opis + ' ' + lokacija) || /slip/i.test(vrstaKol);
    const planirano = /roadworks|planned/i.test(izvorZap) || /construction|maintenance/i.test(uzrok);

    let t, d;
    if (/accident|collision/i.test(uzrok + ' ' + opis)) { t = ['Accident']; d = []; }
    else if (/vehicleObstruction|brokenDown|obstruction/i.test(uzrok)) { t = ['VehicleObstruction']; d = ['brokenDownVehicle']; }
    else if (/roadClosed|carriagewayClosures/i.test(tipUpr) || operativnih === 0 || ceo) {
      t = ['RoadOrCarriagewayOrLaneManagement']; d = rampa ? ['roadClosed', 'slipRoads'] : ['roadClosed', 'mainCarriageway'];
    } else {
      t = ['RoadOrCarriagewayOrLaneManagement', 'MaintenanceWorks']; d = ['laneClosures'];
    }

    // mesto: "M25 anti-clockwise between J30 and J29" → "J30 – J29"
    const izm = lokacija.match(/between (.+?) and (.+?)$/i);
    const kod = lokacija.match(/\b(?:at|on) (.+?)$/i);
    const jct = opis.match(/\b(?:Jct|J)\s?(\d+[A-Z]?)\b/i);
    // bez čvora: tekst bez oznake puta i smera ("M56 Eastbound hardshoulder closure (MP 56/3 to 56/0)"
    // → "Hardshoulder closure (MP 56/3 to 56/0)")
    const ostatak = velikoPrvo(opis.replace(new RegExp('^' + put.replace(/[()]/g, '\\$&') + '\\s*', 'i'), '')
      .replace(/^(?:north|south|east|west)bound\s*|^(?:anti-?)?clockwise\s*/i, '').trim());
    const mesto = izm ? izm[1] + ' – ' + izm[2] : kod ? kod[1] : jct ? 'J' + jct[1] : ostatak.slice(0, 60);
    const smer = velikoPrvo((prvi(x, /<directionOnLinearSection>([^<]+)</) || '').toLowerCase()); // "Eastbound", "Anticlockwise"

    // linija (lat lon …): prva i poslednja tačka, u smeru vožnje
    const brojevi = (prvi(x, /<posList>([^<]+)</) || '').trim().split(/\s+/).map(Number).filter(n => !isNaN(n));
    let a = null, b = null;
    if (brojevi.length >= 2) {
      a = [+brojevi[0].toFixed(6), +brojevi[1].toFixed(6)];
      const n = brojevi.length;
      if (n >= 4) b = [+brojevi[n - 2].toFixed(6), +brojevi[n - 1].toFixed(6)];
      if (b && a[0] === b[0] && a[1] === b[1]) b = null;
    }
    out.push({
      id: 'NH' + (prvi(s, /<idG>([^<]+)</) || out.length), p: [put], t, d, st: zap.st, en: zap.en,
      o: opis || lokacija, m: mesto, s: smer, a, b,
      man: /complianceOption>mandatory/.test(x), pl: planirano,
    });
  }
  const izlaz = process.argv[2] || 'uk.json';
  fs.mkdirSync(path.dirname(path.resolve(izlaz)), { recursive: true });
  fs.writeFileSync(izlaz, JSON.stringify({ izvor: "Powered by National Highways' Transport Data Feeds", vreme: sad, dogadjaji: out }));
  console.log('aktivnih na autoputevima:', out.length, 'od', ukupno, 'situacija –', fs.statSync(izlaz).size, 'B');
})().catch(e => { console.error(e.message); process.exit(1); });
