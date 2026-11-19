import { chromium } from 'playwright';

const BASE_URL = 'https://oferty.praca.gov.pl/portal/lista-ofert';
const API_BASE = 'https://oferty.praca.gov.pl/portal-api/v3';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log('[Diag3] Start ekstrakcji schematu API ePraca...');

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled']
  });

  const context = await browser.newContext({
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    viewport: { width: 1366, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  const jsBundles = [];
  const apiLog = [];

  page.on('response', async (res) => {
    try {
      const url = res.url();
      const ct = res.headers()['content-type'] || '';

      if (url.includes('oferty.praca.gov.pl/portal/') && (url.endsWith('.js') || ct.includes('javascript'))) {
        const text = await res.text();
        jsBundles.push({ url, text });
      }

      if (url.includes('portal-api')) {
        const req = res.request();
        let respText = '';
        try {
          respText = await res.text();
        } catch {}
        apiLog.push({
          method: req.method(),
          status: res.status(),
          url,
          postData: req.postData() || '',
          respText
        });
      }
    } catch {}
  });

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page
      .waitForFunction(() => (document.body?.innerText || '').trim().length > 200, { timeout: 25000 })
      .catch(() => {});
    await delay(2500);

    // 1. Wypisz pełny obiekt 1. oferty z listy wyszukiwania
    const searchCall = apiLog.find((c) => c.url.includes('/oferta/wyszukiwanie') && c.status === 200);
    let firstOfferId = null;
    if (searchCall) {
      try {
        const parsed = JSON.parse(searchCall.respText);
        const first = parsed?.payload?.ofertyPracyPage?.content?.[0];
        if (first) {
          firstOfferId = first.id;
          console.log('[Diag3] === PEŁNA 1. OFERTA Z LISTY ===');
          console.log(JSON.stringify(first, null, 2));
        }
      } catch (e) {
        console.log('[Diag3] Błąd parsowania wyszukiwania:', e.message);
      }
    }

    // 2. Przeszukaj pobrane pliki JS pod kątem dokładnych pól wyszukiwania i endpointów /v3/
    console.log('[Diag3] Przeskanowano plików JS:', jsBundles.length);
    const endpoints = new Set();
    const kodJezykaSnippets = [];
    const powiatSnippets = [];

    for (const bundle of jsBundles) {
      const t = bundle.text;

      const epMatches = t.match(/v3\/[a-zA-Z0-9_/${}-]+/g) || [];
      epMatches.forEach((m) => endpoints.add(m));

      let idx = 0;
      while ((idx = t.indexOf('kodJezyka', idx)) !== -1) {
        kodJezykaSnippets.push(t.slice(Math.max(0, idx - 250), idx + 450).replace(/\s+/g, ' '));
        idx += 9;
        if (kodJezykaSnippets.length >= 6) break;
      }

      let pIdx = 0;
      while ((pIdx = t.indexOf('powiat', pIdx)) !== -1) {
        const snip = t.slice(Math.max(0, pIdx - 100), pIdx + 180).replace(/\s+/g, ' ');
        if (/teryt|wojewodz|gmin|miejscow|lokalizacj|kod|wyszuk/i.test(snip)) {
          powiatSnippets.push(snip);
        }
        pIdx += 6;
        if (powiatSnippets.length >= 10) break;
      }
    }

    console.log('[Diag3] === ENDPOINTY v3 ZNALEZIONE W JS ===');
    Array.from(endpoints).sort().forEach((e) => console.log('  *', e));

    console.log('[Diag3] === KONTEKST "kodJezyka" W JS (pola filtra wyszukiwania) ===');
    kodJezykaSnippets.forEach((s, i) => console.log(`  [${i + 1}] ${s}`));

    console.log('[Diag3] === KONTEKST "powiat" W JS ===');
    powiatSnippets.forEach((s, i) => console.log(`  [${i + 1}] ${s}`));

    // 3. Kliknij pierwszą ofertę na liście, aby zobaczyć URL szczegółów i odpowiedź API szczegółów
    const beforeClickCount = apiLog.length;
    console.log('[Diag3] Próba otwarcia szczegółów 1. oferty...');

    // Szukaj linku lub karty oferty na stronie
    const clicked = await page.evaluate(() => {
      const a = Array.from(document.querySelectorAll('a[href]')).find((el) =>
        /szczegoly|oferta/i.test(el.getAttribute('href') || '') && (el.textContent || '').trim().length > 3
      );
      if (a) {
        a.click();
        return 'LINK: ' + a.getAttribute('href');
      }
      const card = document.querySelector('app-oferta-card, .oferta, [class*="offer"], mat-card, h2, h3');
      if (card) {
        card.click();
        return 'CARD: ' + card.tagName + ' ' + (card.textContent || '').trim().slice(0, 60);
      }
      return 'NONE';
    });
    console.log('[Diag3] Kliknięto element:', clicked);
    await delay(4000);
    console.log('[Diag3] URL po kliknięciu:', page.url());

    // Jeśli URL się nie zmienił, a mamy firstOfferId, sprawdź linki na stronie zawierające firstOfferId
    if (firstOfferId && !page.url().includes(firstOfferId)) {
      const matchingLinks = await page.evaluate((id) => {
        return Array.from(document.querySelectorAll('a[href]'))
          .map((a) => a.getAttribute('href'))
          .filter((h) => h && (h.includes(id) || h.includes('szczegol') || h.includes('oferta')));
      }, firstOfferId);
      console.log('[Diag3] Linki z ID/szczegółami na stronie:', JSON.stringify(matchingLinks.slice(0, 10)));
    }

    const newCalls = apiLog.slice(beforeClickCount);
    console.log('[Diag3] === NOWE WYWOŁANIA API PO KLIKNIĘCIU OFERTY (' + newCalls.length + ') ===');
    newCalls.forEach((c, i) => {
      console.log(`  #${i + 1} [${c.method} ${c.status}] ${c.url}`);
      if (c.postData) console.log('     POST:', c.postData.slice(0, 300));
      console.log('     RESP:', c.respText.slice(0, 1800));
    });
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('[Diag3] Błąd krytyczny:', err);
  process.exit(1);
});
