/*
 * Švajcarska: FEDRO/ASTRA Traffic Data Platform (opentransportdata.swiss, „Traffic situations“, DATEX II 2.2.3)
 * → mali fajl ch.json za posrednika. Ključ je tajna OTD_KEY (GitHub), nikad u kodu:
 *   OTD_KEY=… node alati/ch.js izlaz/ch.json
 * Izvor je ceo snimak (~9 MB SOAP/XML, ~600 situacija: sve ceste) – prevelik za besplatni Worker i telefon.
 * Uslovi FEDRO (tačka 8): sirovi podaci se ne prosleđuju dalje – ovde ostaju samo obrađeni zapisi za
 * autoputeve (A…), u istom obliku kao EVIS/UK u src/index.js: {id, p, t, d, st, en, o, m, s, a, b, man, pl}.
 * Obavezan natpis: "Data source: Federal Roads Office (FEDRO) Traffic Data Platform (TDP)".
 * Kvota: 260.000 poziva (6 meseci), 5 u minuti – posao na 10 min troši ~26.000.
 *
 * Tekst poruke (de-CH) je uređen: "Freigegeben: A9 Vevey -> Martigny zwischen Anschluss Villeneuve und
 * Raststätte Yvorne Sachlage: Verkehrsbehinderung Baustelle, Länge [km] 0.15 Dauer: … bis 12.12.2026 10:00"
 * – iz njega se uzimaju autoput, smer ("->" jedan smer, "<->" oba), mesto i vrsta; koordinate samo kad ih ima.
 */
'use strict';
const fs = require('fs'), path = require('path');

const IZVOR = 'https://api.opentransportdata.swiss/TDP/Soap_Datex2/TrafficSituations/Pull';
const TELO = '<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:dx223="http://datex2.eu/schema/2/2_0"><soapenv:Body><dx223:d2LogicalModel modelBaseVersion="2"><dx223:exchange><dx223:supplierIdentification><dx223:country>ch</dx223:country><dx223:nationalIdentifier>FEDRO</dx223:nationalIdentifier></dx223:supplierIdentification><dx223:subscription><dx223:operatingMode>operatingMode1</dx223:operatingMode><dx223:subscriptionStartTime>2026-01-01T00:00:00Z</dx223:subscriptionStartTime><dx223:subscriptionState>active</dx223:subscriptionState><dx223:updateMethod>singleElementUpdate</dx223:updateMethod><dx223:target><dx223:address></dx223:address><dx223:protocol>http</dx223:protocol></dx223:target></dx223:subscription></dx223:exchange></dx223:d2LogicalModel></soapenv:Body></soapenv:Envelope>';
const NATPIS = 'Data source: Federal Roads Office (FEDRO) Traffic Data Platform (TDP)';

const T = '(?:\\w+:)?'; // prefiks imenskog prostora (dx223:, ns2: …)
const prvi = (s, re) => { const m = s.match(re); return m ? m[1] : null; };
const xml = t => String(t || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const vreme = s => { const t = Date.parse(s || ''); return isNaN(t) ? 0 : t; };
const sviTagovi = (s, tag) => [...s.matchAll(new RegExp('<' + T + tag + '[^>]*>([^<]*)<', 'g'))].map(m => m[1]);

/** "Anschluss Villeneuve" → "Villeneuve"; "Verzweigung Hagnau", "Raststätte Yvorne" ostaju (vrsta je deo imena). */
const ocisti = m => m.replace(/^(?:Anschluss|Ortschaft|Kreuzung|Ausfahrt|Einfahrt)\s+/i, '').trim();

(async () => {
  const kljuc = process.env.OTD_KEY;
  if (!kljuc) throw new Error('nema OTD_KEY');
  const r = await fetch(IZVOR, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + kljuc, 'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: 'http://opentransportdata.swiss/TDP/Soap_Datex2/Pull/v1/pullTrafficMessages',
    },
    body: TELO,
  });
  if (!r.ok) throw new Error('FEDRO HTTP ' + r.status);
  const tekst = await r.text();
  const sad = Date.now();
  const out = [];
  let ukupno = 0;
  const reSit = new RegExp('<' + T + 'situation [^>]*id="([^"]+)"[^>]*>([\\s\\S]*?)</' + T + 'situation>', 'g');
  let m;
  while ((m = reSit.exec(tekst))) {
    ukupno++;
    const id = m[1], s = m[2];
    if ((prvi(s, new RegExp('<' + T + 'informationStatus[^>]*>([^<]+)<')) || 'real') !== 'real') continue;

    // opis (de-CH, commentType description) – prvi takav u situaciji
    let opis = '';
    const reKom = new RegExp('<' + T + 'generalPublicComment[\\s>][\\s\\S]*?</' + T + 'generalPublicComment>', 'g');
    let k;
    while ((k = reKom.exec(s))) {
      if (!/commentType[^>]*>description</.test(k[0])) continue;
      opis = xml(prvi(k[0], /lang="de[^"]*">([^<]*)</) || prvi(k[0], /lang="[^"]*">([^<]*)</));
      if (opis) break;
    }
    // "Freigegeben: A9 Vevey -> Martigny …" (oznaka statusa ispred dvotačke se odbacuje)
    const telo = opis.replace(/^[A-ZÄÖÜa-zäöü]+:\s*/, '');
    const glava = telo.match(/^(A\d+[a-z]?)\s+(.+?)\s+(<->|->)\s+(.+?)(?=\s+(?:zwischen|Ortschaft|Anschluss|Verzweigung|Raststätte|Rastplatz|Tunnel|Parkplatz|Sachlage:|in beide|bei)\b|\s*$)/);
    if (!glava) continue; // samo autoputevi (A…); H… i ostale ceste preskačemo
    const put = glava[1].toUpperCase();
    const jedanSmer = glava[3] === '->';
    const ka = glava[4].trim();

    // zapisi: vrste, važenje, podvrste
    const tipovi = [], podtipovi = [];
    let st = 0, en = 0, aktivan = false, planirano = false;
    const reZap = new RegExp('<' + T + 'situationRecord [^>]*xsi:type="' + T + '(\\w+)"[^>]*>([\\s\\S]*?)</' + T + 'situationRecord>', 'g');
    let z;
    while ((z = reZap.exec(s))) {
      const v = prvi(z[2], new RegExp('<' + T + 'validityStatus[^>]*>([^<]+)<')) || 'active';
      const zSt = vreme(prvi(z[2], new RegExp('<' + T + 'overallStartTime[^>]*>([^<]+)<')));
      // kraj: overallEndTime ili kraj perioda važenja (endOfPeriod)
      const kraj = Math.max(0, ...sviTagovi(z[2], 'overallEndTime').map(vreme), ...sviTagovi(z[2], 'endOfPeriod').map(vreme));
      if (v === 'suspended' || (zSt && zSt > sad + 10 * 60_000) || (kraj && kraj < sad)) continue;
      aktivan = true;
      if (!tipovi.includes(z[1])) tipovi.push(z[1]);
      if (zSt && (!st || zSt < st)) st = zSt;
      if (kraj) en = Math.max(en, kraj);
      for (const tag of ['abnormalTrafficType', 'roadOrCarriagewayOrLaneManagementType', 'roadMaintenanceType',
        'constructionWorkType', 'vehicleObstructionType', 'accidentType', 'carriageway', 'causeType']) {
        for (const w of sviTagovi(z[2], tag)) if (!podtipovi.includes(w)) podtipovi.push(w);
      }
      if (/MaintenanceWorks|ConstructionWorks/.test(z[1])) planirano = true;
    }
    if (!aktivan || !tipovi.length) continue;
    // tekst je precizniji od zapisa: "Strecke gesperrt" = zatvoreno, "Unfall" = udes, "Stau" = kolona
    const sachlage = (telo.match(/Sachlage:\s*(.+?)(?=\s+(?:Ursache|Dauer|Verkehrsführung|Empfehlung):|$)/) || [, ''])[1];
    if (/gesperrt/i.test(sachlage) && !/Fahrstreifen|Spur|Ausfahrt|Einfahrt|Parkplatz|Rastplatz|Raststätte/i.test(sachlage)) {
      if (!tipovi.includes('RoadOrCarriagewayOrLaneManagement')) tipovi.unshift('RoadOrCarriagewayOrLaneManagement');
      if (!podtipovi.includes('roadClosed')) podtipovi.push('roadClosed');
    }
    if (/Ausfahrt gesperrt|Einfahrt gesperrt/i.test(sachlage)) podtipovi.push('slipRoads');
    if (/Unfall/i.test(sachlage) && !tipovi.includes('Accident')) tipovi.unshift('Accident');
    if (/Stau|stockender Verkehr/i.test(sachlage) && !tipovi.includes('AbnormalTraffic')) tipovi.push('AbnormalTraffic');
    if (/Panne|Fahrzeug/i.test(sachlage) && /Panne/i.test(sachlage)) { tipovi.push('VehicleObstruction'); podtipovi.push('brokenDownVehicle'); }

    // mesto: "zwischen Anschluss Villeneuve und Raststätte Yvorne" → "Villeneuve – Raststätte Yvorne"
    const izm = telo.match(/zwischen\s+(.+?)\s+und\s+(.+?)(?=\s+Sachlage:|\s+in beide|$)/);
    const kod = telo.match(/(?:Ortschaft|Anschluss|Verzweigung|Raststätte|Rastplatz|Tunnel|Parkplatz)\s+(.+?)(?=\s+Sachlage:|\s+in beide|$)/);
    const mesto = izm ? ocisti(izm[1]) + ' – ' + ocisti(izm[2]) : kod ? ocisti(kod[0]) : '';

    // koordinate (samo kod dela poruka): prva tačka; za liniju i poslednja
    const lat = sviTagovi(s, 'latitude').map(Number), lon = sviTagovi(s, 'longitude').map(Number);
    let a = null, b = null;
    if (lat.length && lon.length) {
      a = [+lat[0].toFixed(6), +lon[0].toFixed(6)];
      const n = Math.min(lat.length, lon.length);
      if (n > 1) b = [+lat[n - 1].toFixed(6), +lon[n - 1].toFixed(6)];
      if (b && a[0] === b[0] && a[1] === b[1]) b = null;
    }

    out.push({
      id: 'CH' + id.replace(/^situation\./, ''), p: [put], t: tipovi, d: podtipovi, st, en,
      o: telo, m: mesto, s: jedanSmer ? ka : '', a, b,
      man: /complianceOption[^>]*>mandatory/.test(s), pl: planirano,
    });
  }
  const izlaz = process.argv[2] || 'ch.json';
  fs.mkdirSync(path.dirname(path.resolve(izlaz)), { recursive: true });
  fs.writeFileSync(izlaz, JSON.stringify({ izvor: NATPIS, vreme: sad, dogadjaji: out }));
  console.log('aktivnih na autoputevima:', out.length, 'od', ukupno, 'situacija –', fs.statSync(izlaz).size, 'B');
})().catch(e => { console.error(e.message); process.exit(1); });
