import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const BASE_URL = 'https://oferty.praca.gov.pl/portal/lista-ofert';
const API_BASE = 'https://oferty.praca.gov.pl/portal-api/v3';
const SEARCH_API = `${API_BASE}/oferta/wyszukiwanie`;
const OUTPUT_PATH = path.resolve('docs/oferty.json');

const MAX_OFFERS = Number(process.env.MAX_OFFERS || 100);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const POWIAT_BIALOSTOCKI_GMINY = [
  'białostocki',
  'choroszcz',
  'czarna białostocka',
  'dobrzyniewo',
  'gródek',
  'juchnowiec',
  'łapy',
  'michałowo',
  'poświętne',
  'supraśl',
  'suraż',
  'turośń kościelna',
  'tykocin',
  'wasilków',
  'zabłudów',
  'zawady',
  'kleosin',
  'ignatki',
  'fasty',
  'porosły',
  'grabówka',
  'zaścianki',
  'sobolewo',
  'księżyno',
  'horodniany',
  'niewodnica',
  'jurowce',
  'studzianki',
  'nowodworce'
];

function cleanStr(val) {
  return String(val ?? '').replace(/\s+/g, ' ').trim();
}

function flattenJson(obj, prefix = '', out = []) {
  if (obj === null || obj === undefined) return out;

  if (Array.isArray(obj)) {
    const simpleItems = obj
      .map((item) => {
        if (typeof item === 'string' || typeof item === 'number') return cleanStr(item);
        if (item && typeof item === 'object') {
          return cleanStr(
            item.nazwa || item.opis || item.wartosc || item.tekst || item.etykieta || item.name || ''
          );
        }
        return '';
      })
      .filter(Boolean);

    if (simpleItems.length > 0 && prefix) {
      out.push([prefix.toLowerCase(), [...new Set(simpleItems)].join(', ')]);
    }

    obj.forEach((item, idx) => {
      if (item && typeof item === 'object') {
        flattenJson(item, `${prefix}[${idx}]`, out);
      }
    });
    return out;
  }

  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      const nextKey = prefix ? `${prefix}.${k}` : k;
      if (v === null || v === undefined) continue;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        const s = cleanStr(v);
        if (s !== '') out.push([nextKey.toLowerCase(), s]);
      } else {
        flattenJson(v, nextKey, out);
      }
    }
  }
  return out;
}

function pickField(flatPairs, exactKeys, partialKeys = []) {
  for (const key of exactKeys) {
    const target = key.toLowerCase();
    const hit = flatPairs.find(([k, v]) => {
      const leaf = k.split('.').pop().replace(/\[\d+\]/g, '');
      return leaf === target && v && v !== 'false' && v !== 'null';
    });
    if (hit) return hit[1];
  }
  for (const key of partialKeys) {
    const target = key.toLowerCase();
    const hit = flatPairs.find(([k, v]) => k.includes(target) && v && v !== 'false' && v !== 'null');
    if (hit) return hit[1];
  }
  return '';
}

function isPowiatBialostocki(offerObj) {
  const flat = flattenJson(offerObj);
  const fullText = flat.map(([, v]) => v).join(' ').toLowerCase();

  const terytHit = flat.some(
    ([k, v]) => (k.includes('powiat') || k.includes('teryt')) && /^2002\b/.test(v)
  );
  if (terytHit) return true;

  const powiatVal = pickField(flat, ['powiat', 'powiatnazwa', 'nazwapowiatu'], ['powiat']).toLowerCase();
  if (powiatVal.includes('białostocki')) return true;

  const locationText = [
    pickField(flat, ['miejscepracy', 'miejscowoscnazwa', 'miejscowosc', 'gmina', 'adres'], ['miejsce', 'lokalizacj']),
    fullText
  ]
    .join(' ')
    .toLowerCase();

  return POWIAT_BIALOSTOCKI_GMINY.some((g) => locationText.includes(g));
}

function mapOfferToSchema(listItem, detailItem) {
  const merged = { ...listItem, ...(detailItem || {}) };
  const flat = flattenJson(merged);
  const allText = flat.map(([, v]) => v).join(' ');

  const stprRegex = allText.match(/StPr\/[\d-]+\/\d+/i);
  const ofprRegex = allText.match(/OfPr\/[\d-]+\/\d+/i);
  const phoneRegex = allText.match(/(?:\+48\s?)?(?:\d{2,3}[\s-]?\d{3}[\s-]?\d{2,3}[\s-]?\d{2})/);

  const placowka = pickField(
    flat,
    ['placowkaopis', 'nazwaurzedu', 'urzadpracy', 'jednostkazglaszajaca', 'urzad', 'dodaneprzez'],
    ['placowk', 'urzad']
  );

  const dodanePrzezFlag = pickField(flat, ['dodaneprzez'], []);
  const czyPupBialystok =
    /powiatowy urząd pracy w białymstoku|pup\s+w\s+białymstoku|pup\s+białystok/i.test(placowka) ||
    /powiatowy urząd pracy w białymstoku/i.test(allText) ||
    (dodanePrzezFlag.toUpperCase() === 'PUP' && /białymstoku|białystok/i.test(placowka));

  const urzadOpis =
    placowka && placowka !== 'PUP'
      ? placowka
      : czyPupBialystok
        ? 'Powiatowy Urząd Pracy w Białymstoku'
        : dodanePrzezFlag || 'Brak danych';

  let wynagrodzenie = pickField(
    flat,
    ['wynagrodzeniebrutto', 'wynagrodzenie', 'wynagrodzenieopis', 'placa', 'stawka'],
    ['wynagrodzen']
  );
  if (!wynagrodzenie) {
    const od = pickField(flat, ['wynagrodzenieod', 'kwotaod', 'placaod'], []);
    const doKw = pickField(flat, ['wynagrodzeniedo', 'kwotado', 'placado'], []);
    if (od && doKw) wynagrodzenie = `${od} – ${doKw} PLN brutto`;
    else if (od) wynagrodzenie = `od ${od} PLN brutto`;
  }

  const id = listItem.id || detailItem?.id || '';

  return {
    numerOferty:
      pickField(flat, ['numeroferty', 'nroferty', 'sygnaturaoferty', 'numerofertypracy'], ['numerofert']) ||
      (ofprRegex ? ofprRegex[0] : id || 'Brak danych'),
    numerStpr:
      pickField(flat, ['numerzpup', 'numerpracy', 'numerstpr', 'nrstpr', 'stpr', 'sygnatura', 'numerzgloszenia'], ['stpr']) ||
      (stprRegex ? stprRegex[0] : 'Brak danych'),
    dodanePrzezPupBialystok: czyPupBialystok,
    urzadZglaszajacy: urzadOpis,
    lokalizacja:
      pickField(flat, ['miejscepracy', 'lokalizacja', 'miejscowoscnazwa', 'adresmiejscapracy'], ['miejsceprac']) ||
      'powiat białostocki',
    stanowisko:
      pickField(flat, ['stanowisko', 'nazwastanowiska', 'tytuloferty'], ['stanowisk']) || 'Brak danych',
    pracodawca:
      pickField(flat, ['pracodawca', 'nazwapracodawcy', 'pracodawcanazwa', 'nazwafirmy', 'firma'], ['pracodawc']) ||
      'Brak danych',
    rodzajUmowy:
      pickField(flat, ['rodzajumowy', 'typumowy', 'rodzajzatrudnienia', 'umowa'], ['rodzajumow', 'typumow']) ||
      'Brak danych',
    numerTelefonu:
      pickField(flat, ['telefon', 'numertelefonu', 'nrtelefonu', 'telefonkontaktowy'], ['telefon']) ||
      (phoneRegex ? phoneRegex[0] : 'Brak danych'),
    wynagrodzenie: wynagrodzenie || 'Brak danych',
    wymiarEtatu:
      pickField(flat, ['wymiaretatu', 'wymiarzatrudnienia', 'etat', 'wymiar'], ['wymiaretat', 'etat']) ||
      'Brak danych',
    zmianowosc:
      pickField(flat, ['zmianowosc', 'systempracy', 'trybpracy', 'rodzajzmianowosci'], ['zmianow']) ||
      'Brak danych',
    zawod:
      pickField(flat, ['zawod', 'nazwazawodu', 'zawodnazwa', 'kodzawodunazwa'], ['zawod']) || 'Brak danych',
    wyksztalcenie:
      pickField(flat, ['wyksztalcenie', 'poziomwyksztalcenia', 'wymaganewyksztalcenie'], ['wyksztalc']) ||
      'Brak danych',
    dataPublikacji:
      pickField(flat, ['datapublikacji', 'datadodaniacbop', 'datadodania', 'datawaznod'], ['datapublik', 'datadodan']) ||
      'Brak danych',
    dataWaznosci:
      pickField(flat, ['datawazndo', 'datawaznosci', 'ofertawaznado', 'waznado'], ['datawazn', 'waznado']) ||
      'Brak danych',
    url: id
      ? `https://oferty.praca.gov.pl/portal/lista-ofert/szczegoly-oferty?id=${encodeURIComponent(id)}`
      : BASE_URL
  };
}

async function apiSearch(request, body, page = 0, size = 50) {
  const url = `${SEARCH_API}?page=${page}&size=${size}&sort=dataDodania,desc`;
  const res = await request.post(url, {
    data: body,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    timeout: 25000
  });
  if (!res.ok()) {
    return { ok: false, status: res.status(), total: 0, content: [] };
  }
  const json = await res.json();
  const pageObj = json?.payload?.ofertyPracyPage || json?.payload || {};
  return {
    ok: true,
    status: res.status(),
    total: pageObj.totalElements ?? (pageObj.content?.length || 0),
    totalPages: pageObj.totalPages ?? 1,
    content: Array.isArray(pageObj.content) ? pageObj.content : []
  };
}

async function detectSearchPayload(page, request) {
  const base = await apiSearch(request, { kodJezyka: 'PL' }, 0, 5);
  const totalAll = base.total || 17000;
  console.log(`[Scraper] Wszystkie oferty w ePraca: ${totalAll}`);

  const powiatCandidates = [
    { label: 'powiaty:["2002"]', body: { kodJezyka: 'PL', powiaty: ['2002'] } },
    { label: 'powiaty:["2002"] + woj:["20"]', body: { kodJezyka: 'PL', wojewodztwa: ['20'], powiaty: ['2002'] } },
    { label: 'kodPowiatu:"2002"', body: { kodJezyka: 'PL', kodPowiatu: '2002' } },
    { label: 'kodyPowiatow:["2002"]', body: { kodJezyka: 'PL', kodyPowiatow: ['2002'] } },
    { label: 'terytPowiaty:["2002"]', body: { kodJezyka: 'PL', terytPowiaty: ['2002'] } },
    { label: 'powiat:"2002"', body: { kodJezyka: 'PL', powiat: '2002' } },
    { label: 'lokalizacja:{powiaty:["2002"]}', body: { kodJezyka: 'PL', lokalizacja: { powiaty: ['2002'] } } },
    { label: 'miejscaPracy:["2002"]', body: { kodJezyka: 'PL', miejscaPracy: ['2002'] } }
  ];

  for (const cand of powiatCandidates) {
    try {
      const r = await apiSearch(request, cand.body, 0, 5);
      if (r.ok && r.total > 0 && r.total < totalAll * 0.15) {
        console.log('[Scraper] Wykryto natywny filtr powiatu: ' + cand.label + ' -> ' + r.total + ' ofert');
        return { mode: 'powiat', body: cand.body, total: r.total };
      }
    } catch {}
  }

  console.log('[Scraper] Próba przechwycenia filtra powiatu z interfejsu strony...');
  let capturedBody = null;
  const onReq = (req) => {
    if (req.url().includes('/oferta/wyszukiwanie') && req.method() === 'POST') {
      const pd = req.postData();
      if (pd && pd !== '{"kodJezyka":"PL"}') {
        try {
          capturedBody = JSON.parse(pd);
        } catch {}
      }
    }
  };
  page.on('request', onReq);

  try {
    const locBtn = page.locator('text=Wybór lokalizacji, text=Lokalizacja').first();
    if (await locBtn.isVisible().catch(() => false)) {
      await locBtn.click().catch(() => {});
      await delay(1000);

      const input = page.locator('input[type="text"], input[type="search"]').filter({ hasNotText: '' }).last();
      if (await input.isVisible().catch(() => false)) {
        await input.fill('białostocki');
        await delay(1500);
        const opt = page.locator('text=/powiat białostocki|białostocki/i').first();
        if (await opt.isVisible().catch(() => false)) {
          await opt.click().catch(() => {});
          await delay(800);
        }
      }

      const applyBtn = page.locator('button:has-text("Szukaj"), button:has-text("Zastosuj"), button:has-text("Potwierdź")').first();
      if (await applyBtn.isVisible().catch(() => false)) {
        await applyBtn.click().catch(() => {});
        await delay(2000);
      }
    }
  } catch {}
  page.off('request', onReq);

  if (capturedBody) {
    const r = await apiSearch(request, capturedBody, 0, 5);
    if (r.ok && r.total > 0 && r.total < totalAll * 0.2) {
      console.log('[Scraper] Przechwycono filtr z UI: ' + JSON.stringify(capturedBody) + ' -> ' + r.total + ' ofert');
      return { mode: 'powiat', body: capturedBody, total: r.total };
    }
  }

  const wojCandidates = [
    { label: 'wojewodztwa:["20"]', body: { kodJezyka: 'PL', wojewodztwa: ['20'] } },
    { label: 'wojewodztwo:"20"', body: { kodJezyka: 'PL', wojewodztwo: '20' } },
    { label: 'kodWojewodztwa:"20"', body: { kodJezyka: 'PL', kodWojewodztwa: '20' } },
    { label: 'terytWojewodztwa:["20"]', body: { kodJezyka: 'PL', terytWojewodztwa: ['20'] } },
    { label: 'slowoKluczowe:"białostocki"', body: { kodJezyka: 'PL', slowoKluczowe: 'białostocki' } },
    { label: 'miejscowosc:"białostocki"', body: { kodJezyka: 'PL', miejscowosc: 'białostocki' } }
  ];

  for (const cand of wojCandidates) {
    try {
      const r = await apiSearch(request, cand.body, 0, 5);
      if (r.ok && r.total > 0 && r.total < totalAll * 0.25) {
        console.log('[Scraper] Wykryto filtr zapasowy: ' + cand.label + ' -> ' + r.total + ' ofert');
        return { mode: 'filter_local', body: cand.body, total: r.total };
      }
    } catch {}
  }

  console.warn('[Scraper] Nie wykryto filtra terytorialnego API — używam skanowania z filtrem lokalnym.');
  return { mode: 'filter_local', body: { kodJezyka: 'PL' }, total: totalAll };
}

async function detectDetailEndpoint(request, sampleId) {
  if (!sampleId) return null;

  const candidates = [
    (id) => `${API_BASE}/oferta/${id}`,
    (id) => `${API_BASE}/oferta/szczegoly/${id}`,
    (id) => `${API_BASE}/oferta/szczegoly?id=${id}`,
    (id) => `${API_BASE}/oferta/szczegolyOferty/${id}`,
    (id) => `${API_BASE}/oferta/pobierz/${id}`,
    (id) => `${API_BASE}/oferta/details/${id}`
  ];

  for (const makeUrl of candidates) {
    try {
      const url = makeUrl(sampleId);
      const res = await request.get(url, { headers: { Accept: 'application/json' }, timeout: 15000 });
      if (res.ok()) {
        const json = await res.json();
        const payload = json?.payload || json;
        if (payload && typeof payload === 'object' && Object.keys(payload).length > 3) {
          console.log('[Scraper] Wykryto endpoint szczegółów: ' + url);
          return makeUrl;
        }
      }
    } catch {}
  }
  console.log('[Scraper] Brak dedykowanego endpointu szczegółów — używam pełnych danych z listy wyszukiwania.');
  return null;
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
  console.log('[Scraper] Start pobierania ofert (powiat białostocki, limit: ' + MAX_OFFERS + ')...');

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled']
  });

  const context = await browser.newContext({
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page
      .waitForFunction(() => (document.body?.innerText || '').trim().length > 80, { timeout: 20000 })
      .catch(() => {});
    await delay(1500);

    const request = context.request;
    const strategy = await detectSearchPayload(page, request);

    const collectedRaw = [];
    const maxPages = strategy.mode === 'powiat' ? Math.ceil(MAX_OFFERS / 50) + 1 : 20;

    for (let p = 0; p < maxPages && collectedRaw.length < MAX_OFFERS; p++) {
      const res = await apiSearch(request, strategy.body, p, 50);
      if (!res.ok || res.content.length === 0) break;

      const matching =
        strategy.mode === 'powiat'
          ? res.content
          : res.content.filter((item) => isPowiatBialostocki(item));

      for (const item of matching) {
        if (collectedRaw.length < MAX_OFFERS) collectedRaw.push(item);
      }

      console.log(
        '[Scraper] Strona API ' + (p + 1) + '/' + res.totalPages + ': dopasowano ' + matching.length + ' (łącznie: ' + collectedRaw.length + ')'
      );

      if (p + 1 >= res.totalPages) break;
      await delay(200);
    }

    if (collectedRaw.length === 0) {
      const prevCount = await readExistingOffersCount();
      console.warn('[Scraper] Pobrano 0 ofert (poprzednio w pliku: ' + prevCount + ').');
      return;
    }

    console.log('[Diag] Klucze 1. oferty z listy:', Object.keys(collectedRaw[0]).join(', '));

    const makeDetailUrl = await detectDetailEndpoint(request, collectedRaw[0].id);
    const finalOffers = [];

    for (let i = 0; i < collectedRaw.length; i++) {
      const listItem = collectedRaw[i];
      let detailItem = null;

      if (makeDetailUrl && listItem.id) {
        try {
          const dRes = await request.get(makeDetailUrl(listItem.id), {
            headers: { Accept: 'application/json' },
            timeout: 15000
          });
          if (dRes.ok()) {
            const dJson = await dRes.json();
            detailItem = dJson?.payload || dJson;
            if (i === 0 && detailItem) {
              console.log('[Diag] Klucze 1. oferty ze szczegółów:', Object.keys(detailItem).join(', '));
            }
          }
        } catch {}
        await delay(120);
      }

      finalOffers.push(mapOfferToSchema(listItem, detailItem));
    }

    console.log('[Diag] Przykładowa zmapowana oferta #1:', JSON.stringify(finalOffers[0], null, 2));

    const payload = {
      updatedAt: new Date().toISOString(),
      region: 'powiat białostocki',
      total: finalOffers.length,
      offers: finalOffers
    };

    await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await fs.writeFile(OUTPUT_PATH, JSON.stringify(payload, null, 2), 'utf-8');
    console.log('[Scraper] Sukces! Zapisano ' + finalOffers.length + ' ofert do ' + OUTPUT_PATH + '.');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('[Scraper] Błąd krytyczny:', err);
  process.exit(1);
});
