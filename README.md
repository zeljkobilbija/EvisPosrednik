# EVIS posrednik (Cloudflare Worker)

Vesti o saobraćaju na austrijskim autoputevima i brzim putevima (EVIS.AT / ASFINAG, licenca CC BY 4.0 ASFINAG)
za aplikacije Austria Road Info i Euro Road Info. Lični EVIS ključ se čuva samo kao tajna na Cloudflare-u
(`EVIS_KEY`) – nikad u aplikaciji ni u ovom repozitorijumu.

- `GET /vesti?put=A9` – neplanirani događaji (udesi, kolone, zatvaranja, vozila u kvaru) za jedan autoput
- izvor se preuzima najviše jednom u minuti

Postavljanje: `npx wrangler deploy`; ključ: `npx wrangler secret put EVIS_KEY`.
