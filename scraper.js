import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const BASE_URL = 'https://oferty.praca.gov.pl/portal/lista-ofert';
const API_BASE = 'https://oferty.praca.gov.pl/portal-api/v3';
const SEARCH_API = `${API_BASE}/oferta/wyszukiwanie`;
const OUTPUT_PATH = path.resolve('docs/oferty.json');

const MAX_OFFERS = Number(process.env.MAX_OFFERS || 100);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 15 gmin powiatu białostockiego (TERYT 2002) — zapasowy filtr, jeśli API zwróci całe woj. podlaskie
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

/**
 * Spłaszcza zagnieżdżony obiekt JSON z API do listy par [klucz, wartość],
 * ułatwiając wydobycie pól niezależnie od struktury pod-obiektów.
 */
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
  // 1. Najpierw szukaj dokładnego dopasowania końcówki ścieżki
  for (const key of exactKeys) {
    const target = key.toLowerCase();
    const hit = flatPairs.find(([k, v]) => {
      const leaf = k.split('.').pop().replace(/\[\d+\]/g, '');
      return leaf === target && v && v !== 'false' && v !== 'null';
    });
    if (hit) return hit[1];
  }
  // 2. Następnie szukaj dopasowania częściowego
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

  // Sprawdź kod TERYT powiatu (2002)
  const terytHit = flat.some(
    ([k, v]) => (k.includes('powiat') || k.includes('teryt')) && /^2002\b/.test(v)
  );
  if (terytHit) return true;

  // Wyklucz oferty, które mają wyraźnie wpisane wyłącznie miasto Białystok (TERYT 2061) bez gmin powiatu
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

  // Wynagrodzenie (czasem jest jako jeden opis, czasem jako od/do)
  let wynagrodzenie = pickField(
    flat,
    ['wynagrodzeniebrutto', 'wynagrodzenie', 'wynagrodzenieopis', 'placa', 'stawka'],
    ['wynagrodzen']
  );
  if (!wynagrodzenie) {
    const od = pickField(flat, ['wynagrodzenieod', 'kwotaod', 'placaod'], []);
    const doKw = pickField(flat, ['wynagrodzeniedo', 'kwotado', 'placado'], []);
    if (od && doKw) wynagrodzenie = `${od} –${doKw} PLN brutto`;
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
      ? `https://oferty.praca.gov.pl/portal/lista-ofert/szczegoly-oferty?id=${encodeURIComponent(id)}` : BASE_URL }; }  async function apiSearch(request, body, page = 0, size = 50) { const url = `${SEARCH_API}?page=${page}&size=${size}&sort=dataDodania,desc`;
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
  // 1. Bazowa liczba wszystkich ofert w Polsce
  const base = await apiSearch(request, { kodJezyka: 'PL' }, 0, 5);
  const totalAll = base.total || 17000;
  console.log(`[Scraper] Wszystkie oferty w ePraca: ${totalAll}`);

  // 2. Test znanych struktur filtrów API v3 dla powiatu białostockiego (TERYT 2002)
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
        console.log(`[Scraper] Wykryto natywny filtr powiatu: ${cand.label} ->${r
