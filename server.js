const express = require("express");
const cors = require("cors");
const cheerio = require("cheerio");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8787;
const BASE = "https://www.catawiki.com/nl";
const UA = "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36";

const CATEGORY_NAMES = [
  "Archeologie en natuurlijke historie",
  "Aziatische en tribale kunst",
  "Boeken en historische memorabilia",
  "Fashion",
  "Horloges, pennen en aanstekers",
  "Interieur en decoratie",
  "Kunst",
  "Munten en postzegels",
  "Muziek, films en camera's",
  "Oldtimers, klassieke motoren en automobilia",
  "Sieraden en edelstenen",
  "Speelgoed en modellen",
  "Sport",
  "Strips en animatie",
  "Trading cards",
  "Wijn, whisky en gedistilleerde dranken"
];

function todayNL() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Amsterdam",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const o = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${o.year}${o.month}${o.day}`;
}

async function getHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "nl-NL,nl;q=0.9,en;q=0.8",
      "Cache-Control": "no-cache"
    },
    redirect: "follow"
  });
  if (!res.ok) throw new Error(`Catawiki HTTP ${res.status}`);
  return await res.text();
}

function euroNumber(text) {
  if (!text) return null;
  const clean = String(text).replace(/\u00a0/g, " ");
  const m = clean.match(/€\s*([\d.]+(?:,\d{1,2})?)/);
  if (!m) return null;
  const n = m[1].replace(/\./g, "").replace(",", ".");
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

function firstEuro(text, patterns) {
  for (const pattern of patterns) {
    const m = String(text || "").match(pattern);
    if (m) {
      const v = euroNumber(m[0]);
      if (v != null) return v;
    }
  }
  return null;
}

function buyerProtection(bid) {
  if (bid == null) return null;
  return Math.round((bid * 0.09 + 3) * 100) / 100;
}

function absoluteUrl(href) {
  try { return new URL(href, BASE).toString(); } catch { return null; }
}

function normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function looksLikeLotUrl(href) {
  try {
    const p = new URL(href).pathname;
    return /\/l\/\d+[-/]/i.test(p) || /\/l\/\d+$/i.test(p);
  } catch {
    return false;
  }
}

async function discoverCategories() {
  const html = await getHtml(BASE);
  const $ = cheerio.load(html);
  const found = [];

  $("a[href]").each((_, a) => {
    const href = absoluteUrl($(a).attr("href"));
    if (!href || !/\/c\/\d+-/i.test(new URL(href).pathname)) return;

    const name = $(a).text().replace(/\s+/g, " ").trim();
    const n = normalizeName(name);
    if (!n) return;

    const match = CATEGORY_NAMES.find(x => {
      const nx = normalizeName(x);
      return n === nx || n.includes(nx) || nx.includes(n);
    });

    if (match && !found.some(x => x.name === match)) {
      found.push({ name: match, url: href });
    }
  });

  // The detailed category list on the homepage currently contains all 16 main categories.
  // If labels change, keep the first unique category links as a fallback.
  if (found.length < 10) {
    $("a[href*='/c/']").each((_, a) => {
      const href = absoluteUrl($(a).attr("href"));
      if (!href || !/\/c\/\d+-/i.test(new URL(href).pathname)) return;
      if (found.some(x => x.url === href)) return;
      const name = $(a).text().replace(/\s+/g, " ").trim();
      if (name) found.push({ name, url: href });
    });
  }

  return found.slice(0, 16);
}

function parseLots(html, categoryName) {
  const $ = cheerio.load(html);
  const lots = [];
  const seen = new Set();

  // Catawiki may return /nl/l/, /en/l/ or another locale. Do not hard-code /nl/l/.
  $("a[href]").each((_, a) => {
    const href = absoluteUrl($(a).attr("href"));
    if (!href || !looksLikeLotUrl(href) || seen.has(href)) return;

    const aText = $(a).text().replace(/\s+/g, " ").trim();
    const card = $(a).closest("article, li").first();
    const cardText = (card.text() || "").replace(/\s+/g, " ").trim();
    const parentText = ($(a).parent().text() || "").replace(/\s+/g, " ").trim();
    const text = [cardText, parentText, aText].filter(Boolean).sort((x, y) => y.length - x.length)[0] || aText;

    if (text.length < 8) return;

    const currentBid = firstEuro(text, [
      /(?:huidig bod|current bid|eindbod|bod)\s*[:]?\s*€?\s*[\d.]+(?:,\d{1,2})?/i,
      /€\s*[\d.]+(?:,\d{1,2})?/i
    ]);

    const catawikiEstimateLow = firstEuro(text, [
      /(?:schatting detailhandel|geschatte waarde|retail estimate|estimated value)\s*[:]?\s*€?\s*[\d.]+(?:,\d{1,2})?/i
    ]);

    let title = ($(a).attr("aria-label") || aText || "").replace(/\s+/g, " ").trim();
    if (!title || title.length < 4) title = text.slice(0, 180);

    let endAt = null;
    card.find("time[datetime]").each((_, t) => {
      if (!endAt) endAt = $(t).attr("datetime") || null;
    });
    if (!endAt) {
      const raw = card.html() || $(a).parent().html() || "";
      const m = raw.match(/(?:endDate|end_at|endsAt|closingDate|auctionEnd)[^"']{0,120}["']([^"']+)["']/i);
      if (m) endAt = m[1];
    }

    const bid = currentBid;
    lots.push({
      id: href.match(/\/l\/(\d+)/i)?.[1] || href.split("/").pop(),
      title,
      currentBid: bid,
      buyerProtectionFee: buyerProtection(bid),
      shipping: null,
      catawikiEstimateLow,
      catawikiEstimateHigh: null,
      expectedResale: null,
      maxBid: null,
      possibleProfit: null,
      risk: "Onbekend",
      endAt,
      category: categoryName,
      url: href
    });
    seen.add(href);
  });

  return lots;
}

async function fetchCategoryToday(category) {
  const day = todayNL();
  const sep = category.url.includes("?") ? "&" : "?";
  const url = `${category.url}${sep}filters=bidding_end_days%5B%5D%3D${day}`;
  const html = await getHtml(url);
  return { category: category.name, sourceUrl: url, lots: parseLots(html, category.name) };
}

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "catawiki-resell-scanner", time: new Date().toISOString() });
});

app.get("/api/categories", async (req, res) => {
  try {
    const cats = await discoverCategories();
    res.json({ categories: cats, count: cats.length });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.get("/api/lots", async (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  const ending = String(req.query.ending || "today").toLowerCase();

  try {
    const categories = await discoverCategories();
    if (!categories.length) throw new Error("Geen Catawiki-categoriepagina's gevonden.");

    const results = [];
    const errors = [];

    for (const category of categories) {
      try {
        const data = await fetchCategoryToday(category);
        for (const lot of data.lots) {
          if (!q || `${lot.title} ${lot.category}`.toLowerCase().includes(q)) results.push(lot);
        }
      } catch (err) {
        errors.push({ category: category.name, error: err.message });
        console.error(`Categorie mislukt: ${category.name}: ${err.message}`);
      }
    }

    // De same lot can appear in more than one category/navigation surface.
    const unique = Array.from(new Map(results.map(lot => [lot.url, lot])).values());

    res.json({
      ok: true,
      ending,
      date: todayNL(),
      categoriesChecked: categories.length,
      count: unique.length,
      lots: unique.slice(0, 250),
      errors: errors.slice(0, 16),
      note: "Live publieke Catawiki-gegevens. Catawiki's eigen waardeschatting is apart gemarkeerd; resale/max-bid worden niet gefingeerd."
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`Catawiki backend listening on ${PORT}`));
