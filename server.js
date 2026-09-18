const express = require("express");
const cors = require("cors");
const cheerio = require("cheerio");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8787;
const BASE = "https://www.catawiki.com/nl";
const UA = "Mozilla/5.0 (Android 14; Mobile) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36";

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
    headers: { "User-Agent": UA, "Accept-Language": "nl-NL,nl;q=0.9,en;q=0.8" }
  });
  if (!res.ok) throw new Error(`Catawiki HTTP ${res.status}`);
  return await res.text();
}

function euroNumber(text) {
  if (!text) return null;
  const m = String(text).replace(/\u00a0/g, " ").match(/€\s*([\d.]+(?:,\d{1,2})?)/);
  if (!m) return null;
  const n = m[1].replace(/\./g, "").replace(",", ".");
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

function buyerProtection(bid) {
  if (bid == null) return null;
  return Math.round((bid * 0.09 + 3) * 100) / 100;
}

function absoluteUrl(href) {
  try { return new URL(href, BASE).toString(); } catch { return null; }
}

function categorySlugName(url) {
  try {
    const p = new URL(url).pathname;
    return p.split("/").filter(Boolean).pop() || "";
  } catch { return ""; }
}

async function discoverCategories() {
  const html = await getHtml(BASE);
  const $ = cheerio.load(html);
  const found = [];

  $("a[href]").each((_, a) => {
    const name = $(a).text().replace(/\s+/g, " ").trim();
    const href = absoluteUrl($(a).attr("href"));
    if (!href || !href.includes("/nl/c/")) return;
    const match = CATEGORY_NAMES.find(n => name.toLowerCase().includes(n.toLowerCase()) || n.toLowerCase().includes(name.toLowerCase()));
    if (match && !found.some(x => x.name === match)) found.push({ name: match, url: href });
  });

  // Fallback: keep any category links discovered even if the visible label changed.
  if (found.length < 4) {
    $("a[href*='/nl/c/']").each((_, a) => {
      const href = absoluteUrl($(a).attr("href"));
      if (!href || found.some(x => x.url === href)) return;
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

  $("a[href*='/nl/l/']").each((_, a) => {
    const href = absoluteUrl($(a).attr("href"));
    if (!href || seen.has(href)) return;

    const card = $(a).closest("article, li, div").first();
    const text = (card.text() || $(a).parent().text() || $(a).text())
      .replace(/\s+/g, " ").trim();

    // Keep reasonably lot-like links; avoid collecting navigation links.
    if (text.length < 8) return;

    const bid = euroNumber(text.match(/(?:eindbod|huidig bod|bod|current bid)\s*€?\s*[\d.]+(?:,\d{1,2})?/i)?.[0] || text);
    const title = ($(a).attr("aria-label") || $(a).text() || "").replace(/\s+/g, " ").trim() ||
      text.slice(0, 140);

    // Try to capture a machine-readable closing datetime when present.
    let endAt = null;
    const scope = card;
    scope.find("time[datetime]").each((_, t) => { if (!endAt) endAt = $(t).attr("datetime"); });
    if (!endAt) {
      const raw = scope.html() || "";
      const m = raw.match(/(?:endDate|end_at|endsAt|closingDate)[^"']{0,80}["']([^"']+)["']/i);
      if (m) endAt = m[1];
    }

    lots.push({
      id: href.split("/").pop(),
      title,
      currentBid: bid,
      buyerProtectionFee: buyerProtection(bid),
      shipping: null,
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
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/lots", async (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  const ending = String(req.query.ending || "today").toLowerCase();

  try {
    const categories = await discoverCategories();
    if (!categories.length) throw new Error("Geen Catawiki-categoriepagina's gevonden.");

    const results = [];
    // Keep requests modest to avoid hammering Catawiki.
    for (const category of categories) {
      try {
        const data = await fetchCategoryToday(category);
        for (const lot of data.lots) {
          if (!q || `${lot.title} ${lot.category}`.toLowerCase().includes(q)) results.push(lot);
        }
      } catch (err) {
        console.error(`Categorie mislukt: ${category.name}: ${err.message}`);
      }
    }

    res.json({
      ok: true,
      ending,
      date: todayNL(),
      count: results.length,
      lots: results.slice(0, 250),
      note: "Live publieke Catawiki-gegevens. Resale/max-bid worden pas ingevuld zodra een betrouwbare vergelijkingsbron wordt gekoppeld."
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => console.log(`Catawiki backend listening on ${PORT}`));
