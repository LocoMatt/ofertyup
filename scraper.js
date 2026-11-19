import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const BASE_URL = 'https://oferty.praca.gov.pl/portal/lista-ofert';
const OUTPUT_PATH = path.resolve('docs/oferty.json');

// Limit można zmieniać zmienną środowiskową MAX_OFFERS w pliku scrape.yml
const MAX_OFFERS = Number(process.env.MAX_OFFERS || 100);
const REQUEST_DELAY_MS = 350;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function parseOfferDetails(page, offerUrl) {
  await page.goto(offerUrl, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('main, h1, h2', { timeout: 10000 }).catch(() => {});

  const data = await page.evaluate(() => {
    const clean = (str) => (str || '').replace(/\s+/g, ' ').trim();
    const rawText = document.body ? document.body.innerText : '';
    const fullText = clean(rawText);

    const pairs = [];

    document.querySelectorAll('dt').forEach((dt) => {
      const dd = dt.nextElementSibling;
      if (dd && dd.tagName === 'DD') {
        pairs.push([clean(dt.textContent).toLowerCase(), clean(dd.textContent)]);
      }
    });

    document.querySelectorAll('tr').forEach((tr) => {
      const cells = tr.querySelectorAll('th, td');
      if (cells.length >= 2) {
        pairs.push([clean(cells[0].textContent).toLowerCase(), clean(cells[1].textContent)]);
      }
    });

    document.querySelectorAll('div, li, p, section').forEach((el) => {
      if (el.children.length === 2) {
        const label = clean(el.children[0].textContent).toLowerCase();
        const val = clean(el.children[1].textContent);
        if (label.length > 1 && label.length < 70 && val.length > 0 && val.length < 300) {
          pairs.push([label, val]);
        }
      }
    });

    const findByLabels = (keywords) => {
      for (const kw of keywords) {
        const match = pairs.find(([k]) => k.includes(kw));
        if (match && match[1]) return match[1];
      }
      for (const kw of keywords) {
        const rx = new RegExp(`${kw}[:\\s]+([^\\n]{2,140})`, 'i');
        const m = rawText.match(rx);
        if (m && m[1]) return clean(m[1]);
      }
      return '';
    };

    const heading = clean(document.querySelector('h1, h2')?.textContent);
    const stprMatch = fullText.match(/StPr\/[\d-]+\/\d+/i);
    const ofertaMatch = fullText.match(/OfPr\/[\d-]+\/\d+/i);
    const phoneMatch = fullText.match(/(?:\+48\s?)?(?:\d{2,3}[\s-]?\d{3}[\s-]?\d{2,3}[\s-]?\d{2})/);

    const urzad = findByLabels([
      'urząd pracy',
      'jednostka zgłaszająca',
      'dodane przez',
      'zgłaszający urząd',
      'pup'
    ]);

    const czyPupBialystok =
      /powiatowy urząd pracy w białymstoku|pup\s+białystok/i.test(urzad) ||
      /powiatowy urząd pracy w białymstoku/i.test(fullText);

    return {
      numerOferty: findByLabels(['numer oferty', 'nr oferty']) || (ofertaMatch ? ofertaMatch[0] : 'Brak danych'),
      numerStpr: findByLabels(['numer stpr', 'nr stpr', 'stpr']) || (stprMatch ? stprMatch[0] : 'Brak danych'),
      dodanePrzezPupBialystok: czyPupBialystok,
      urzadZglaszajacy: urzad || (czyPupBialystok ? 'Powiatowy Urząd Pracy w Białymstoku' : 'Inny / pracodawca'),
      lokalizacja: findByLabels(['miejsce pracy', 'lokalizacja pracy', 'lokalizacja', 'miejscowość']) || 'powiat białostocki',
      stanowisko: findByLabels(['stanowisko']) || heading || 'Brak danych',
      pracodawca: findByLabels(['pracodawca', 'nazwa pracodawcy', 'firma']) || 'Brak danych',
      rodzajUmowy: findByLabels(['rodzaj umowy', 'typ umowy']) || 'Brak danych',
      numerTelefonu: findByLabels(['telefon', 'numer telefonu', 'nr telefonu']) || (phoneMatch ? phoneMatch[0] : 'Brak danych'),
      wynagrodzenie: findByLabels(['wynagrodzenie brutto', 'wynagrodzenie', 'płaca']) || 'Brak danych',
      wymiarEtatu: findByLabels(['wymiar etatu', 'etat']) || 'Brak danych',
      zmianowosc: findByLabels(['zmianowość', 'system pracy']) || 'Brak danych',
      zawod: findByLabels(['zawód', 'nazwa zawodu']) || 'Brak danych',
      wyksztalcenie: findByLabels(['wykształcenie', 'poziom wykształcenia']) || 'Brak danych',
      dataPublikacji: findByLabels(['data publikacji', 'data dodania', 'oferta aktualna od', 'ważna od']) || 'Brak danych',
      dataWaznosci: findByLabels(['data ważności', 'oferta ważna do', 'ważna do', 'aktualna do']) || 'Brak danych'
    };
  });

  return {
    ...data,
    url: offerUrl
  };
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
  console.log(`[Scraper] Start pobierania (limit: ${MAX_OFFERS} ofert)...`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'pl-PL',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 45000 });

    const acceptCookies = page
      .locator('button:has-text("Akceptuj"), button:has-text("Zgadzam się")')
      .first();
    if (await acceptCookies.isVisible().catch(() => false)) {
      await acceptCookies.click().catch(() => {});
    }

    const locationInput = page
      .locator(
        'input[placeholder*="Miejscowość"], input[placeholder*="Lokalizacja"], input[aria-label*="Lokalizacja"], input[aria-label*="Miejsce"]'
      )
      .first();

    if (await locationInput.isVisible().catch(() => false)) {
      await locationInput.click();
      await locationInput.fill('białostocki');
      await delay(1400);

      const option = page
        .locator('[role="option"]:has-text("białostocki"), li:has-text("powiat białostocki")')
        .first();
      if (await option.isVisible().catch(() => false)) {
        await option.click();
      } else {
        await page.keyboard.press('Enter');
      }

      const searchBtn = page.locator('button:has-text("Szukaj"), button:has-text("Filtruj")').first();
      if (await searchBtn.isVisible().catch(() => false)) {
        await searchBtn.click();
      }
      await page.waitForLoadState('networkidle');
      await delay(1500);
    }

    const offerUrls = new Set();
    let pageNum = 1;

    while (offerUrls.size < MAX_OFFERS) {
      const linksOnPage = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href*="szczegoly-oferty"]'))
          .map((a) => a.href)
          .filter(Boolean)
      );

      const prevCount = offerUrls.size;
      linksOnPage.forEach((href) => {
        if (offerUrls.size < MAX_OFFERS) offerUrls.add(href);
      });

      console.log(`[Scraper] Strona ${pageNum}: zebrano łącznie ${offerUrls.size} linków.`);
      if (offerUrls.size === prevCount || offerUrls.size >= MAX_OFFERS) break;

      const nextBtn = page
        .locator('button[aria-label*="Następna"], a[aria-label*="Następna"], button:has-text("Następna")')
        .first();
      const isDisabled = await nextBtn.isDisabled().catch(() => true);
      if (!(await nextBtn.isVisible().catch(() => false)) || isDisabled) break;

      await nextBtn.click();
      await page.waitForLoadState('networkidle');
      await delay(1200);
      pageNum++;
    }

    const results = [];
    const urlsArray = Array.from(offerUrls);

    for (let i = 0; i < urlsArray.length; i++) {
      console.log(`[Scraper] (${i + 1}/${urlsArray.length}) Pobieranie szczegółów...`);
      try {
        const offer = await parseOfferDetails(page, urlsArray[i]);
        results.push(offer);
      } catch (err) {
        console.warn(`[Scraper] Pominięto ${urlsArray[i]}:`, err.message);
      }
      await delay(REQUEST_DELAY_MS);
    }

    // Zabezpieczenie przed nadpisaniem dobrych danych podczas awarii portalu
    const previousCount = await readExistingOffersCount();
    if (results.length === 0 && previousCount > 0) {
      console.warn(
        `[Scraper] Pobrano 0 ofert (poprzednio: ${previousCount}). Zachowuję dotychczasowy plik docs/oferty.json.`
      );
      return;
    }

    const payload = {
      updatedAt: new Date().toISOString(),
      region: 'powiat białostocki',
      total: results.length,
      offers: results
    };

    await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await fs.writeFile(OUTPUT_PATH, JSON.stringify(payload, null, 2), 'utf-8');
    console.log(`[Scraper] Zapisano ${results.length} ofert do ${OUTPUT_PATH}.`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('[Scraper] Błąd krytyczny:', err);
  process.exit(1);
});
