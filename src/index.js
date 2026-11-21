/*
 * Posrednik za vesti o saobraćaju u Austriji (EVIS.AT, ASFINAG – CC BY 4.0 ASFINAG).
 *
 * Lični EVIS ključ je tajna na Cloudflare-u (EVIS_KEY), nikad u aplikaciji ni na GitHub-u:
 *   npx wrangler secret put EVIS_KEY
 * Aplikacija pita:  GET /vesti?put=A9   (bez "put": svi autoputevi)
 * Odgovor: JSON sa događajima na mreži ASFINAG (autoputevi i brzi putevi), neplanirani događaji
 * (udesi, kolone, zatvaranja, vozila u kvaru…). Izvor se preuzima najviše jednom u minuti po instanci.
 */
const IZVOR = 'https://datasupply-evis.asfinag.at/1.0/getdata/EventsUnplanned/AT-ASF/2.2.3?apiKey=';
const KES_MS = 60_000;
const ATRIBUCIJA = 'Datenquelle: EVIS.AT / ASFINAG, CC BY 4.0 ASFINAG';

// Planirani događaji (gradilišta): GitHub Action jednom na sat pravi planirano.json u grani "podaci"
// (izvorni GeoJSON je ~2,8 MB – prevelik za besplatni Worker); ovde se čuva 10 min.
const PLANIRANO = 'https://raw.githubusercontent.com/zeljkobilbija/EvisPosrednik/podaci/planirano.json';
const KES_PLAN_MS = 10 * 60_000;

// Engleska: National Highways (Road and Lane Closures v2.0) – GitHub Action na 10 min pravi uk.json
// u grani "podaci-uk" (izvor je ceo SRN, do 6 MB XML). "Powered by National Highways' Transport Data Feeds"
const UK = 'https://raw.githubusercontent.com/zeljkobilbija/EvisPosrednik/podaci-uk/uk.json';
const KES_UK_MS = 5 * 60_000;
let kesUk = null;

let kes = null;     // { vreme, dogadjaji } – neplanirani
let kesPlan = null; // { vreme, dogadjaji } – planirani

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/uk') return await uk(url);
    if (url.pathname !== '/vesti') {
      return new Response('Austria Road Info – EVIS.AT posrednik. ' + ATRIBUCIJA, { status: 404 });
    }
    try {
      const sad = Date.now();
      if (!kes || sad - kes.vreme > KES_MS) kes = { vreme: sad, dogadjaji: obradi(await preuzmi(env.EVIS_KEY)) };
      if (!kesPlan || sad - kesPlan.vreme > KES_PLAN_MS) {
        try {
          const r = await fetch(PLANIRANO);
          const j = r.ok ? await r.json() : null;
          kesPlan = { vreme: sad, dogadjaji: (j && j.dogadjaji || []).filter(d => !d.en || d.en > sad) };
        } catch (e) {
          kesPlan = { vreme: sad, dogadjaji: kesPlan ? kesPlan.dogadjaji : [] };
        }
      }
      const put = (url.searchParams.get('put') || '').toUpperCase().replace(/^([AS])0*/, '$1');
      const ids = new Set(kes.dogadjaji.map(d => d.id));
      const sve = kes.dogadjaji.concat(kesPlan.dogadjaji.filter(d => !ids.has(d.id)));
      const lista = put ? sve.filter(d => d.p.includes(put)) : sve;
      return json({ izvor: ATRIBUCIJA, vreme: kes.vreme, dogadjaji: lista });
    } catch (e) {
      return json({ greska: String(e && e.message || e) }, 502);
    }
  },
};

/** GET /uk?put=M25 – zatvaranja na autoputu u Engleskoj (isti oblik zapisa kao /vesti). */
async function uk(url) {
  const sad = Date.now();
  if (!kesUk || sad - kesUk.vreme > KES_UK_MS) {
    try {
      const r = await fetch(UK, { cf: { cacheTtl: 120 } });
      const j = r.ok ? await r.json() : null;
      kesUk = { vreme: sad, izvor: j ? j.vreme : 0, dogadjaji: (j && j.dogadjaji) || [] };
    } catch (e) {
      if (!kesUk) return json({ greska: String(e && e.message || e) }, 502);
      kesUk.vreme = sad;
    }
  }
  const put = (url.searchParams.get('put') || '').toUpperCase().replace(/\s+/g, '');
  const lista = kesUk.dogadjaji.filter(d => (!d.en || d.en > sad) && (!put || d.p.includes(put)));
  return json({ izvor: "Powered by National Highways' Transport Data Feeds", vreme: kesUk.izvor, dogadjaji: lista });
}

function json(o, status = 200) {
  return new Response(JSON.stringify(o), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60' },
  });
}

async function preuzmi(kljuc) {
  if (!kljuc) throw new Error('nema EVIS_KEY');
  const r = await fetch(IZVOR + kljuc);
  if (!r.ok) throw new Error('EVIS HTTP ' + r.status);
  const bajtovi = new Uint8Array(await r.arrayBuffer());
  // EVIS šalje gzip fajl (bez Content-Encoding)
  if (bajtovi[0] === 0x1f && bajtovi[1] === 0x8b) {
    const tok = new Response(bajtovi).body.pipeThrough(new DecompressionStream('gzip'));
    return await new Response(tok).text();
  }
  return new TextDecoder().decode(bajtovi);
}

const prvi = (s, re) => { const m = s.match(re); return m ? m[1] : null; };
const xml = t => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const vreme = s => { const t = Date.parse(s); return isNaN(t) ? 0 : t; };

/** DATEX II 2.2.3 (EVIS) → kratki zapisi za aplikaciju. */
function obradi(tekst) {
  const out = [];
  const reSit = /<(?:\w+:)?situation [^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/(?:\w+:)?situation>/g;
  let m;
  while ((m = reSit.exec(tekst))) {
    const id = m[1], s = m[2];
    const status = prvi(s, /<(?:\w+:)?informationStatus>([^<]+)</);
    if (status && status !== 'real') continue;

    const tipovi = [], podtipovi = [];
    let aktivan = false;
    const reZap = /<(?:\w+:)?situationRecord [^>]*xsi:type="(?:\w+:)?(\w+)"[^>]*>([\s\S]*?)<\/(?:\w+:)?situationRecord>/g;
    let z;
    while ((z = reZap.exec(s))) {
      if (!tipovi.includes(z[1])) tipovi.push(z[1]);
      const v = prvi(z[2], /<(?:\w+:)?validityStatus>([^<]+)</);
      if (v !== 'suspended') aktivan = true;
      for (const tag of ['accidentType', 'vehicleObstructionType', 'obstructionType', 'abnormalTrafficType',
        'roadOrCarriagewayOrLaneManagementType', 'roadMaintenanceType', 'constructionWorkType', 'carriageway']) {
        const re = new RegExp('<(?:\\w+:)?' + tag + '>([^<]+)<', 'g');
        let w;
        while ((w = re.exec(z[2]))) if (!podtipovi.includes(w[1])) podtipovi.push(w[1]);
      }
    }
    if (!tipovi.length || !aktivan) continue;

    let st = 0, en = 0, w;
    const reSt = /<(?:\w+:)?overallStartTime>([^<]+)</g;
    while ((w = reSt.exec(s))) { const t = vreme(w[1]); if (t && (!st || t < st)) st = t; }
    const reEn = /<(?:\w+:)?overallEndTime>([^<]+)</g;
    while ((w = reEn.exec(s))) en = Math.max(en, vreme(w[1]));
    if (en && en < Date.now()) continue;

    const putevi = [];
    const reP = /<(?:\w+:)?roadNumber>([AS])0*(\d+)[^<]*</g;
    while ((w = reP.exec(s))) { const p = w[1] + w[2]; if (!putevi.includes(p)) putevi.push(p); }

    const opis = xml(prvi(s, /<(?:\w+:)?generalPublicComment>[\s\S]*?<(?:\w+:)?value lang="de[^"]*">([^<]*)</) || '');
    const mesto = xml(prvi(s, /<(?:\w+:)?locationName>[\s\S]*?<(?:\w+:)?value(?:\s[^>]*)?>([^<]*)</) || '');
    // oznaka iz opisa ("A12 Landecker Tunnel, …") je pouzdanija od roadNumber (tamo "A122" za isti tunel)
    const izOpisa = opis.match(/^([AS])0*(\d+)\b/);
    if (izOpisa && !putevi.includes(izOpisa[1] + izOpisa[2])) putevi.unshift(izOpisa[1] + izOpisa[2]);
    // smer: "Linz Richtung Freistadt"; bez mesta iz opisa ("A9 Pyhrn Autobahn, Graz Richtung Maribor (SLO), …")
    const smer = ((mesto.match(/Richtung (.+)$/) || opis.match(/Richtung ([^,]+)/) || [, ''])[1]).trim();

    const brojevi = r => r ? [parseFloat(r[1]), parseFloat(r[2])] : null;
    const LL = '<(?:\\w+:)?latitude>([-\\d.]+)</(?:\\w+:)?latitude>\\s*<(?:\\w+:)?longitude>([-\\d.]+)<';
    let a = brojevi(s.match(new RegExp('<(?:\\w+:)?start>\\s*' + LL)));
    let b = brojevi(s.match(new RegExp('<(?:\\w+:)?end>\\s*' + LL)));
    if (!a) a = brojevi(s.match(new RegExp('<(?:\\w+:)?locationForDisplay>\\s*' + LL)));
    if (a && b && Math.abs(a[0] - b[0]) < 1e-5 && Math.abs(a[1] - b[1]) < 1e-5) b = null;

    out.push({
      id, p: putevi, t: tipovi, d: podtipovi, st, en, o: opis, m: mesto, s: smer,
      a, b, man: /complianceOption>mandatory/.test(s),
    });
  }
  return out;
}
