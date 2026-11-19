import fs from 'node:fs/promises';
import path from 'node:path';

const API_BASE = 'https://oferty.praca.gov.pl/portal-api/v3';
const OUTPUT_PATH = path.resolve('docs/oferty.json');

// Limit można zmieniać w .github/workflows/scrape.yml (domyślnie pobiera wszystkie z powiatu do 500)
const MAX_OFFERS = Number(process.env.MAX_OFFERS || 500);
const CONCURRENCY = 5;

const HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'Accept-Language': 'pl-PL,pl;q=0.9',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clean(val) {
  if (val === null || val === undefined) return '';
  return String(val).replace(/\s+/g, ' ').trim();
}

function joinValues(val) {
  if (!val) return '';
  if (typeof val === 'string' || typeof val === 'number') return clean(val);
  if (Array.isArray(val)) {
    return val
      .map((item) => {
        if (typeof item === 'string' || typeof item === 'number') return clean(item);
        if (item && typeof item === 'object') {
          return clean(
            item.nazwa ||
              item.poziom ||
              item.typ ||
              item.opis ||
              item.wartosc ||
              item.etykieta ||
              item.zawod ||
              ''
          );
        }
        return '';
      })
      .filter(Boolean)
      .join(', ');
  }
  if (typeof val === 'object') {
    return clean(val.nazwa || val.poziom || val.opis || val.wartosc || val.etykieta || '');
  }
  return '';
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { ...HEADERS, ...(options.headers || {}) }
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} dla ${url}`);
  }
  return res.json();
}

/**
 * Pobiera ze słownika ePraca dokładne ID województwa podlaskiego oraz powiatu białostockiego.
 */
async function resolvePowiatBialostockiId() {
  try {
    const wojResp = await fetchJson(`${API_BASE}/slownik/wojewodztwo`, { method: 'GET' });
    const wojList = Array.isArray(wojResp) ? wojResp : wojResp?.payload || [];
    const podlaskie = wojList.find((w) => /podlask/i.test(JSON.stringify(w)));
    const wojId = podlaskie?.id ?? podlaskie?.kod ?? podlaskie?.wartosc ?? '20';
    console.log(`[Scraper] Słownik woj. podlaskie ID: ${wojId}`);

    const powResp = await fetchJson(
      `${API_BASE}/slownik/wojewodztwo/${encodeURIComponent(String(wojId))}/powiat`,
      { method: 'GET' }
    );
    const powList = Array.isArray(powResp) ? powResp : powResp?.payload || [];

    // Szukamy powiatu białostockiego (ziemskiego), a nie m. Białystok
    const bialostocki =
      powList.find((p) => {
        const txt = JSON.stringify(p).toLowerCase();
        return txt.includes('białostocki') && !txt.includes('m. białystok') && !txt.includes('miasto białystok');
      }) ||
      powList.find((p) => /białostocki/i.test(JSON.stringify(p)));

    if (bialostocki) {
      const powiatId = String(bialostocki.id ?? bialostocki.kod ?? bialostocki.wartosc ?? '2002');
      console.log(`[Scraper] Wykryto ID powiatu białostockiego ze słownika: ${powiatId} (${JSON.stringify(bialostocki)})`);
      return { wojId: String(wojId), powiatId };
    }
  } catch (err) {
    console.warn(`[Scraper] Nie udało się odczytać słownika powiatów (${err.message}), używam domyślnego TERYT 2002.`);
  }
  return { wojId: '20', powiatId: '2002' };
}

/**
 * Wyciąga wykształcenie i zawód z pola tekstowego wymagania (fallback, gdy brak w strukturze obiektu).
 */
function extractFromWymaganiaText(text, label) {
  if (!text) return '';
  const rx = new RegExp(`(?:^|\\n)\\s*${label}\\s*[-:]\\s*([^\\n]+)`, 'i');
  const m = String(text).match(rx);
  return m && m[1] ? clean(m[1]) : '';
}

function mapOffer(listItem, detail) {
  const dp = detail?.danePodstawowe || {};
  const dpoz = detail?.danePozostale || {};
  const prac = detail?.pracodawca || {};
  const war = detail?.warunki || detail?.warunkiPracyIPlacy || {};
  const wym = detail?.wymagania || {};

  // Numer oferty i numer StPr
  const numerRaw = clean(dp.numer);
  const numerEures = clean(dp.numerWEures);
  const idOferty = clean(dp.id || listItem.id);

  let numerStpr = 'Brak danych';
  if (/StPr\//i.test(numerRaw)) {
    numerStpr = numerRaw;
  } else if (/StPr\//i.test(numerEures)) {
    const m = numerEures.match(/StPr\/[^\s,;]+/i);
    numerStpr = m ? m[0] : numerEures;
  }

  // Numer oferty: jeśli główne pole "numer" ma OfPr/..., użyj go; w przeciwnym razie numer / idOfertyPl / id
  const numerOferty =
    clean(dp.idOfertyPl) ||
    (numerRaw && !/StPr\//i.test(numerRaw) ? numerRaw : '') ||
    numerEures ||
    numerRaw ||
    idOferty ||
    'Brak danych';

  // Urząd zgłaszający / PUP Białystok
  const nazwaUrzedu =
    clean(prac.nazwaUrzeduPracy) ||
    clean(listItem.placowkaOpis) ||
    clean(listItem.dodanePrzez);

  const czyPupBialystok =
    /powiatowy urząd pracy w białymstoku|pup\s+w\s+białymstoku|pup\s+białystok/i.test(nazwaUrzedu);

  // Lokalizacja pracy
  const lokalizacja =
    clean(war.miejscePracy) ||
    clean(war.adresMiejscaPracy) ||
    clean(listItem.miejscePracy) ||
    clean(prac.adres) ||
    'powiat białostocki';

  // Numer telefonu (ze szczegółów pracodawcy / kontaktu lub z listy)
  const telefon =
    clean(prac.nrTelefonuPracodawca) ||
    clean(prac.nrTelefonu) ||
    clean(listItem.telefon) ||
    'Brak danych';

  // Wynagrodzenie (pierwsza linia z opisem kwoty, jeśli pełny opis ma wiele akapitów)
  let wynagrodzenie =
    clean(war.wynagrodzenieBrutto) ||
    clean(war.wynagrodzenie) ||
    clean(listItem.wynagrodzenie);
  if (wynagrodzenie.length > 140) {
    const firstLine = clean(String(war.wynagrodzenieBrutto || listItem.wynagrodzenie || '').split('\n')[0]);
    wynagrodzenie = firstLine.length > 140 ? firstLine.slice(0, 137) + '...' : firstLine;
  }

  // Wymiar etatu
  let wymiarEtatu =
    clean(war.wymiarEtatu) ||
    clean(war.wymiarZatrudnienia) ||
    clean(listItem.wymiarZatrud);
  if (/^\d+(?:[.,]\d+)?$/.test(wymiarEtatu)) {
    wymiarEtatu = `${wymiarEtatu} etat`;
  }

  // Zmianowość
  const zmianowosc =
    clean(war.zmianowosc) ||
    clean(war.systemPracy) ||
    clean(war.rodzajZmianowosci) ||
    clean(listItem.zmianowosc) ||
    'Brak danych';

  // Zawód
  const zawod =
    joinValues(war.zawod) ||
    joinValues(dp.zawod) ||
    joinValues(wym.zawod) ||
    joinValues(wym.zawody) ||
    extractFromWymaganiaText(listItem.wymagania, 'zawód') ||
    'Brak danych';

  // Wykształcenie
  const wyksztalcenie =
    joinValues(wym.wyksztalcenie) ||
    joinValues(wym.wyksztalcenia) ||
    joinValues(wym.poziomWyksztalcenia) ||
    joinValues(wym.wymaganiaKonieczne?.wyksztalcenia) ||
    extractFromWymaganiaText(listItem.wymagania, 'wykształcenie') ||
    'Brak danych';

  // Daty
  const dataPublikacji =
    clean(dpoz.dataUdostepnieniaOferty) ||
    clean(dpoz.dataDodania) ||
    clean(listItem.dataDodaniaCbop) ||
    clean(listItem.dataWaznOd) ||
    'Brak danych';

  const dataWaznosci =
    clean(dpoz.dataWaznosci) ||
    clean(listItem.dataWaznDo) ||
    'Brak danych';

  return {
    numerOferty,
    numerStpr,
    dodanePrzezPupBialystok: czyPupBialystok,
    urzadZglaszajacy: nazwaUrzedu || 'Brak danych',
    lokalizacja,
    stanowisko: clean(dp.stanowisko || listItem.stanowisko) || 'Brak danych',
    pracodawca: clean(prac.nazwa || listItem.pracodawca) || 'Brak danych',
    rodzajUmowy: clean(war.rodzajUmowy || listItem.rodzajUmowy) || 'Brak danych',
    numerTelefonu: telefon,
    wynagrodzenie: wynagrodzenie || 'Brak danych',
    wymiarEtatu: wymiarEtatu || 'Brak danych',
    zmianowosc,
    zawod,
    wyksztalcenie,
    dataPublikacji,
    dataWaznosci,
    url: idOferty
      ? `https://oferty.praca.gov.pl/portal/lista-ofert/szczegoly-oferty/${encodeURIComponent(idOferty)}`
      : 'https://oferty.praca.gov.pl/portal/lista-ofert'
  };
}

async function fetchOfferDetails(id) {
  const url = `${API_BASE}/oferta/szczegoly/${encodeURIComponent(id)}?alreadyVisited=false&hashJap=`;
  const json = await fetchJson(url, { method: 'GET' });
  return json?.payload || null;
}

async function readExistingOffersCount() {
  try {
    const raw = await fs.readFile(OUTPUT_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.offers) ? parsed.offers.length : 0;
  } catch {
    return 0;
  }
}

async function main() {
  console.log(`[Scraper] Start pobierania z ePraca API v3 (powiat białostocki, limit: ${MAX_OFFERS})...`);

  const { powiatId } = await resolvePowiatBialostockiId();
  const searchBody = {
    kodJezyka: 'PL',
    powiatyId: [powiatId]
  };

  const listItems = [];
  const pageSize = 50;
  let pageNum = 0;
  let totalPages = 1;

  while (pageNum < totalPages && listItems.length < MAX_OFFERS) {
    const url = `${API_BASE}/oferta/wyszukiwanie?page=${pageNum}&size=${pageSize}&sort=dataDodaniaCbop,desc`;
    const resp = await fetchJson(url, {
      method: 'POST',
      body: JSON.stringify(searchBody)
    });

    const pageObj = resp?.payload?.ofertyPracyPage;
    if (!pageObj || !Array.isArray(pageObj.content)) {
      throw new Error('Nieoczekiwana struktura odpowiedzi wyszukiwania API.');
    }

    totalPages = pageObj.totalPages ?? 1;
    for (const item of pageObj.content) {
      if (listItems.length < MAX_OFFERS) listItems.push(item);
    }

    console.log(
      `[Scraper] Strona ${pageNum + 1}/${totalPages}: pobrano ${pageObj.content.length} (łącznie: ${listItems.length} z ${pageObj.totalElements})`
    );
    pageNum++;
    await delay(150);
  }

  if (listItems.length === 0) {
    const prev = await readExistingOffersCount();
    console.warn(`[Scraper] API zwróciło 0 ofert dla powiatyId=[${powiatId}] (poprzednio: ${prev}).`);
    return;
  }

  // Pobieranie szczegółów równolegle w paczkach po CONCURRENCY (szybko i bezpiecznie dla serwera)
  const finalOffers = new Array(listItems.length);
  let loggedDetailSample = false;

  for (let i = 0; i < listItems.length; i += CONCURRENCY) {
    const batch = listItems.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (item, offset) => {
        const idx = i + offset;
        let detail = null;
        try {
          detail = await fetchOfferDetails(item.id);
          if (!loggedDetailSample && detail) {
            loggedDetailSample = true;
            console.log('[Diag] Sekcje szczegółów oferty #1:', Object.keys(detail).join(', '));
            if (detail.warunki) console.log('[Diag] Klucze warunki:', Object.keys(detail.warunki).join(', '));
            if (detail.wymagania) console.log('[Diag] Klucze wymagania:', Object.keys(detail.wymagania).join(', '));
          }
        } catch (err) {
          console.warn(`[Scraper] Nie pobrano szczegółów dla ${item.id}: ${err.message}`);
        }
        finalOffers[idx] = mapOffer(item, detail);
      })
    );
    await delay(180);
  }

  console.log('[Diag] Przykładowa zapisana oferta #1:', JSON.stringify(finalOffers[0], null, 2));

  const payload = {
    updatedAt: new Date().toISOString(),
    region: 'powiat białostocki',
    powiatId,
    total: finalOffers.length,
    offers: finalOffers
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(payload, null, 2), 'utf-8');
  console.log(`[Scraper] GOTOWE! Zapisano ${finalOffers.length} ofert do ${OUTPUT_PATH}.`);
}

main().catch((err) => {
  console.error('[Scraper] Błąd krytyczny:', err);
  process.exit(1);
});
