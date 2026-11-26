# EVIS posrednik (Cloudflare Worker)

Vesti o saobraćaju na austrijskim autoputevima i brzim putevima (EVIS.AT / ASFINAG, licenca CC BY 4.0 ASFINAG)
za aplikacije Austria Road Info i Euro Road Info. Lični EVIS ključ se čuva samo kao tajna na Cloudflare-u
(`EVIS_KEY`) – nikad u aplikaciji ni u ovom repozitorijumu.

- `GET /vesti?put=A9` – neplanirani događaji (udesi, kolone, zatvaranja, vozila u kvaru) za jedan autoput
- izvor se preuzima najviše jednom u minuti; planirani radovi (gradilišta) iz grane `podaci` (planirano.json, GitHub Action jednom na sat – `alati/planirano.js`, tajna EVIS_KEY u GitHub-u)

Postavljanje: `npx wrangler deploy`; ključ: `npx wrangler secret put EVIS_KEY`.
- `GET /fr?tok=c` i `GET /fr?tok=b` – Francuska, Bison Futé „Action C“ (bezbednost) i „Action B“ (sav saobraćaj, i autoputevi sa naplatom), ograničen pristup uz potpisane licence; `content.xml` (DATEX II 2.0) se prosleđuje neizmenjen. Login: tajne `TIPI_KORISNIK` i `TIPI_LOZINKA` (Cloudflare → Workers → evis-posrednik → Settings → Variables and Secrets).
