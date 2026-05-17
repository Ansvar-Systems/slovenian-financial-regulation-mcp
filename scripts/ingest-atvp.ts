/**
 * Ingestion crawler for the Slovenian Financial Regulation MCP server.
 *
 * Scrapes regulatory content from three Slovenian financial supervisory bodies:
 *
 *   ATVP (Agencija za trg vrednostnih papirjev — Securities Market Agency)
 *     - e-Zakonodaja: consolidated law texts (ZTFI-1, ZUAIS, ZISDU-3, ZPre-1, sklepi)
 *     - Stalisca agencije: council positions and interpretive guidance
 *     - Izreceni ukrepi: enforcement actions and supervisory measures
 *
 *   AZN (Agencija za zavarovalni nadzor — Insurance Supervision Agency)
 *     - Podzakonski predpisi: subordinate regulations under ZZavar-1, ZPIZ-2, ZOZP
 *     - Stalisca agencije: agency positions / interpretive guidance
 *     - Izreceni ukrepi: enforcement actions (zavarovalnice + zastopniki)
 *
 *   BS (Banka Slovenije — Bank of Slovenia)
 *     - Placeholder sourcebook for banking supervision regulations
 *
 * Data sources:
 *   https://www.atvp.si/e-zakonodaja                     (ATVP laws index)
 *   https://www.atvp.si/si/e-zakonodaja/e-ztfi-1         (ZTFI-1 full text)
 *   https://www.atvp.si/e-ZUAIS                          (ZUAIS full text)
 *   https://www.atvp.si/e-zakonodaja/e-zisdu-3           (ZISDU-3 full text)
 *   https://www.atvp.si/e-Sklep-o-poslovanju-druzbe-za-upravljanje
 *   https://www.atvp.si/e-Sklep_o_kljucnih_elementih_investicijskega_sklada_...
 *   https://www.atvp.si/si/stalisca-agencije/zakon-o-trgu-financnih-instrumentov
 *   https://www.atvp.si/si/stalisca-agencije/zakon-o-prevzemih
 *   https://www.atvp.si/nadzorniska-razkritja-/izreceni-ukrepi  (ATVP enforcement)
 *   https://www.a-zn.si/zakonodaja-in-smernice/podzakonski-predpisi/...
 *   https://www.a-zn.si/zakonodaja-in-smernice/stalisca-agencije/
 *   https://www.a-zn.si/zavarovalnice-pokojninske-druzbe/postopek-nadzornega-pregleda/izreceni-ukrepi/
 *   https://www.a-zn.si/zastopniki-in-posredniki/stalisca-obvestila-agencije/izreceni-ukrepi/
 *
 * Usage:
 *   npx tsx scripts/ingest-atvp.ts
 *   npx tsx scripts/ingest-atvp.ts --dry-run
 *   npx tsx scripts/ingest-atvp.ts --resume
 *   npx tsx scripts/ingest-atvp.ts --force
 *   npx tsx scripts/ingest-atvp.ts --max-pages 5
 */

import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_PATH = process.env["ATVP_DB_PATH"] ?? "data/atvp.db";
const STATE_FILE = join(dirname(DB_PATH), "ingest-state.json");
const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const USER_AGENT =
  "AnsvarATVPCrawler/1.0 (+https://github.com/Ansvar-Systems/slovenian-financial-regulation-mcp)";

const ATVP_BASE = "https://www.atvp.si";
const AZN_BASE = "https://www.a-zn.si";

// CLI flags
const dryRun = process.argv.includes("--dry-run");
const resume = process.argv.includes("--resume");
const force = process.argv.includes("--force");
const maxPagesArg = process.argv.find((_, i, a) => a[i - 1] === "--max-pages");
const maxPagesOverride = maxPagesArg ? parseInt(maxPagesArg, 10) : null;

// ---------------------------------------------------------------------------
// ATVP e-Zakonodaja: law/regulation index pages
// ---------------------------------------------------------------------------

/**
 * ATVP publishes consolidated law texts as interactive e-zakonodaja pages.
 * Each law has its own sub-page with the full text broken into articles (cleni).
 * The main index at /e-zakonodaja links to each law page.
 */
const ATVP_E_ZAKONODAJA_INDEX = `${ATVP_BASE}/e-zakonodaja`;

/**
 * Known ATVP e-zakonodaja law pages.
 *
 * The ATVP index page may block automated access (403), so we enumerate the
 * known sub-pages directly. These are the primary capital-markets laws and
 * general acts that ATVP maintains as interactive e-zakonodaja texts.
 *
 * Sources verified via web search (2026-03-23):
 *   - e-ZTFI-1: /si/e-zakonodaja/e-ztfi-1
 *   - e-ZUAIS: /e-ZUAIS
 *   - e-ZISDU-3: /e-zakonodaja/e-zisdu-3  (investment funds and management companies)
 *   - e-ZPre-1: not yet an interactive e-zakonodaja page (PDF only)
 *   - Sklep pages: /e-Sklep-o-poslovanju-druzbe-za-upravljanje, etc.
 */
const ATVP_LAW_PAGES: Array<{
  id: string;
  path: string;
  sourcebook: string;
  type: string;
  description: string;
}> = [
  {
    id: "e-ztfi-1",
    path: "/si/e-zakonodaja/e-ztfi-1",
    sourcebook: "ATVP_SKLEPI",
    type: "zakon",
    description: "Zakon o trgu financnih instrumentov (ZTFI-1)",
  },
  {
    id: "e-zuais",
    path: "/e-ZUAIS",
    sourcebook: "ATVP_SKLEPI",
    type: "zakon",
    description: "Zakon o upravljavcih alternativnih investicijskih skladov (ZUAIS)",
  },
  {
    id: "e-zisdu-3",
    path: "/e-zakonodaja/e-zisdu-3",
    sourcebook: "ATVP_SKLEPI",
    type: "zakon",
    description: "Zakon o investicijskih skladih in druzbah za upravljanje (ZISDU-3)",
  },
  {
    id: "e-sklep-poslovanje-dzu",
    path: "/e-Sklep-o-poslovanju-druzbe-za-upravljanje",
    sourcebook: "ATVP_SKLEPI",
    type: "sklep",
    description: "Sklep o poslovanju druzbe za upravljanje",
  },
  {
    id: "e-sklep-kljucni-elementi",
    path: "/e-Sklep_o_kljucnih_elementih_investicijskega_sklada_ter_tipih_in_vrstah_investicijskih_skladov",
    sourcebook: "ATVP_SKLEPI",
    type: "sklep",
    description: "Sklep o kljucnih elementih investicijskega sklada ter tipih in vrstah investicijskih skladov",
  },
];

/**
 * ATVP enforcement actions listing page.
 */
const ATVP_ENFORCEMENT_URL = `${ATVP_BASE}/nadzorniska-razkritja-/izreceni-ukrepi`;

/**
 * ATVP stalisca agencije (agency positions / council interpretive guidance).
 *
 * The ATVP publishes council positions (stalisca) grouped by law. Each page
 * lists position documents as linked PDFs or inline descriptions.
 *
 * Verified sources:
 *   - /si/stalisca-agencije/zakon-o-trgu-financnih-instrumentov (ZTFI)
 *   - /si/stalisca-agencije/zakon-o-prevzemih (ZPre-1)
 */
const ATVP_STALISCA_PAGES: Array<{
  id: string;
  url: string;
  law: string;
}> = [
  {
    id: "atvp-stalisca-ztfi",
    url: `${ATVP_BASE}/si/stalisca-agencije/zakon-o-trgu-financnih-instrumentov`,
    law: "ZTFI-1",
  },
  {
    id: "atvp-stalisca-zpre",
    url: `${ATVP_BASE}/si/stalisca-agencije/zakon-o-prevzemih`,
    law: "ZPre-1",
  },
];

// ---------------------------------------------------------------------------
// AZN regulation listing pages
// ---------------------------------------------------------------------------

/**
 * AZN publishes subordinate regulations (podzakonski predpisi) as lists of
 * PDF documents grouped by parent statute. Each entry has an <h3> title
 * followed by a <ul> of gazette publications.
 */
const AZN_REGULATION_PAGES: Array<{
  id: string;
  url: string;
  sourcebook: string;
  type: string;
  description: string;
}> = [
  {
    id: "azn-zzavar-1",
    url: `${AZN_BASE}/zakonodaja-in-smernice/podzakonski-predpisi/podzakonski-predpisi-zzavar-1/`,
    sourcebook: "AZN_PREDPISI",
    type: "sklep",
    description: "Podzakonski predpisi na podlagi Zakona o zavarovalnistvu (ZZavar-1)",
  },
  {
    id: "azn-zpiz-2",
    url: `${AZN_BASE}/zakonodaja-in-smernice/podzakonski-predpisi/podzakonski-predpisi-zpiz-2/`,
    sourcebook: "AZN_PREDPISI",
    type: "sklep",
    description: "Podzakonski predpisi na podlagi Zakona o pokojninskem in invalidskem zavarovanju (ZPIZ-2)",
  },
  {
    id: "azn-zozp",
    url: `${AZN_BASE}/zakonodaja-in-smernice/podzakonski-predpisi/podzakonski-predpisi-zozp/`,
    sourcebook: "AZN_PREDPISI",
    type: "sklep",
    description: "Podzakonski predpisi na podlagi Zakona o izplacilu odskodnin (ZOZP)",
  },
  {
    id: "azn-arhiv-zzavar",
    url: `${AZN_BASE}/zakonodaja-in-smernice/podzakonski-predpisi/podzakonski-predpisi-arhiv-zzavar/`,
    sourcebook: "AZN_PREDPISI",
    type: "sklep",
    description: "Arhiv podzakonskih predpisov na podlagi starega Zakona o zavarovalnistvu (ZZavar)",
  },
];

/**
 * AZN stalisca (agency positions / interpretive guidance).
 */
const AZN_STALISCA_URL = `${AZN_BASE}/zakonodaja-in-smernice/stalisca-agencije/`;

/**
 * AZN enforcement actions come from two separate pages:
 *   1. zavarovalnice (insurance companies)
 *   2. zastopniki in posredniki (agents and brokers)
 */
const AZN_ENFORCEMENT_PAGES = [
  {
    id: "azn-ukrepi-zavarovalnice",
    url: `${AZN_BASE}/zavarovalnice-pokojninske-druzbe/postopek-nadzornega-pregleda/izreceni-ukrepi/`,
    label: "AZN ukrepi - zavarovalnice",
  },
  {
    id: "azn-ukrepi-zastopniki",
    url: `${AZN_BASE}/zastopniki-in-posredniki/stalisca-obvestila-agencije/izreceni-ukrepi/`,
    label: "AZN ukrepi - zastopniki in posredniki",
  },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IngestState {
  processedUrls: string[];
  lastRun: string;
  provisionsIngested: number;
  enforcementsIngested: number;
  stalisceIngested: number;
  errors: string[];
}

interface ParsedProvision {
  sourcebook_id: string;
  reference: string;
  title: string;
  text: string;
  type: string;
  status: string;
  effective_date: string | null;
  chapter: string | null;
  section: string | null;
}

interface ParsedEnforcement {
  firm_name: string;
  reference_number: string | null;
  action_type: string;
  amount: number | null;
  date: string | null;
  summary: string;
  sourcebook_references: string | null;
}

// ---------------------------------------------------------------------------
// HTTP fetching with rate limiting and retries
// ---------------------------------------------------------------------------

let lastRequestTime = 0;

async function rateLimitedFetch(url: string): Promise<string | null> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      lastRequestTime = Date.now();
      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "sl,en;q=0.5",
        },
        signal: AbortSignal.timeout(30_000),
      });

      if (response.status === 403 || response.status === 429) {
        console.warn(
          `  [WARN] HTTP ${response.status} for ${url} (attempt ${attempt}/${MAX_RETRIES})`,
        );
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }
        return null;
      }

      if (!response.ok) {
        console.warn(`  [WARN] HTTP ${response.status} for ${url}`);
        return null;
      }

      return await response.text();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `  [WARN] Fetch error for ${url} (attempt ${attempt}/${MAX_RETRIES}): ${message}`,
      );
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// State management (for --resume)
// ---------------------------------------------------------------------------

function loadState(): IngestState {
  if (resume && existsSync(STATE_FILE)) {
    try {
      const raw = readFileSync(STATE_FILE, "utf-8");
      const parsed = JSON.parse(raw) as IngestState;
      console.log(
        `Resuming from previous run (${parsed.processedUrls.length} URLs already processed)`,
      );
      return parsed;
    } catch {
      console.warn("[WARN] Could not read state file, starting fresh.");
    }
  }
  return {
    processedUrls: [],
    lastRun: new Date().toISOString(),
    provisionsIngested: 0,
    enforcementsIngested: 0,
    stalisceIngested: 0,
    errors: [],
  };
}

function saveState(state: IngestState): void {
  state.lastRun = new Date().toISOString();
  const dir = dirname(STATE_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Date parsing
// ---------------------------------------------------------------------------

/**
 * Parse a Slovenian date string (dd.MM.yyyy) to ISO format (yyyy-MM-dd).
 *
 * Handles both dd.MM.yyyy and d.M.yyyy. Falls through to ISO detection.
 */
function parseSlovenianDate(raw: string): string | null {
  if (!raw) return null;

  const cleaned = raw.trim();

  // dd.MM.yyyy or d.M.yyyy
  const dotMatch = cleaned.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dotMatch) {
    const [, day, month, year] = dotMatch;
    return `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
  }

  // Slovenian textual months: "15. januar 2024" or "15. januarja 2024"
  const slovenianMonths: Record<string, string> = {
    januar: "01", januarja: "01",
    februar: "02", februarja: "02",
    marec: "03", marca: "03",
    april: "04", aprila: "04",
    maj: "05", maja: "05",
    junij: "06", junija: "06",
    julij: "07", julija: "07",
    avgust: "08", avgusta: "08",
    september: "09", septembra: "09",
    oktober: "10", oktobra: "10",
    november: "11", novembra: "11",
    december: "12", decembra: "12",
  };

  const textMatch = cleaned.match(/(\d{1,2})\.\s*(\w+)\s+(\d{4})/);
  if (textMatch) {
    const [, day, monthName, year] = textMatch;
    const monthNum = slovenianMonths[monthName!.toLowerCase()];
    if (monthNum) {
      return `${year}-${monthNum}-${day!.padStart(2, "0")}`;
    }
  }

  // Already ISO: yyyy-MM-dd
  const isoMatch = cleaned.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return isoMatch[0];
  }

  return null;
}

/**
 * Extract the latest effective date from a gazette reference string.
 *
 * AZN regulation listings include text like:
 *   "Uradni list RS, stevilka: 137/2022, veljavnost: 01.01.2023, objava: 28.10.2022"
 *
 * We extract the veljavnost (effective) date, falling back to objava (publication).
 */
function extractDateFromGazette(text: string): string | null {
  // Look for "veljavnost: dd.MM.yyyy"
  const veljavnostMatch = text.match(/veljavnost:\s*(\d{1,2}\.\d{1,2}\.\d{4})/i);
  if (veljavnostMatch) {
    return parseSlovenianDate(veljavnostMatch[1]!);
  }

  // Fallback: "objava: dd.MM.yyyy"
  const objavaMatch = text.match(/objava:\s*(\d{1,2}\.\d{1,2}\.\d{4})/i);
  if (objavaMatch) {
    return parseSlovenianDate(objavaMatch[1]!);
  }

  // Fallback: any date pattern
  const anyDate = text.match(/(\d{1,2}\.\d{1,2}\.\d{4})/);
  if (anyDate) {
    return parseSlovenianDate(anyDate[1]!);
  }

  return null;
}

/**
 * Extract the gazette reference (stevilka) from text.
 *
 * Returns strings like "137/2022" from "Uradni list RS, stevilka: 137/2022".
 */
function extractGazetteRef(text: string): string | null {
  const match = text.match(/(?:stevilka|st\.|st|s\.|številka)[:\s]+(\d+\/\d{4})/i);
  if (match) return match[1]!;

  // Fallback: any NNN/YYYY pattern
  const fallback = text.match(/(\d{1,4}\/\d{4})/);
  return fallback ? fallback[1]! : null;
}

// ---------------------------------------------------------------------------
// Cheerio helpers
// ---------------------------------------------------------------------------

/** Get the lowercase tag name from a cheerio element. */
function tagName(el: AnyNode): string | null {
  if ("tagName" in el && typeof el.tagName === "string") {
    return el.tagName.toLowerCase();
  }
  return null;
}

// ---------------------------------------------------------------------------
// ATVP e-Zakonodaja scraping
// ---------------------------------------------------------------------------

/**
 * Attempt to scrape the ATVP e-zakonodaja index to discover law pages.
 *
 * The ATVP site sometimes blocks automated requests (403). If that happens,
 * we fall back to the hardcoded ATVP_LAW_PAGES list.
 */
async function discoverAtvpLawPages(): Promise<string[]> {
  const urls: string[] = [];

  console.log("\n  Discovering ATVP e-zakonodaja pages...");
  const html = await rateLimitedFetch(ATVP_E_ZAKONODAJA_INDEX);

  if (!html) {
    console.log("    Index page not accessible, using known law page list.");
    return ATVP_LAW_PAGES.map((p) => `${ATVP_BASE}${p.path}`);
  }

  const $ = cheerio.load(html);

  // The e-zakonodaja index links to individual law pages
  $("a[href]").each((_i, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    // Match internal links to e-zakonodaja sub-pages
    if (
      (href.startsWith("/e-") || href.startsWith("/si/e-zakonodaja/e-")) &&
      !href.includes("?") &&
      href !== "/e-zakonodaja"
    ) {
      const fullUrl = href.startsWith("http") ? href : `${ATVP_BASE}${href}`;
      if (!urls.includes(fullUrl)) {
        urls.push(fullUrl);
      }
    }
  });

  if (urls.length === 0) {
    console.log("    No sub-pages found on index, using known law page list.");
    return ATVP_LAW_PAGES.map((p) => `${ATVP_BASE}${p.path}`);
  }

  // Merge discovered URLs with known pages (some may not be on the index)
  for (const knownPage of ATVP_LAW_PAGES) {
    const knownUrl = `${ATVP_BASE}${knownPage.path}`;
    if (!urls.includes(knownUrl)) {
      urls.push(knownUrl);
    }
  }

  console.log(`    Found ${urls.length} e-zakonodaja pages`);
  return urls;
}

/**
 * Scrape an individual ATVP e-zakonodaja page for provisions.
 *
 * ATVP law pages present articles as individual elements. The page title
 * gives the law name, and articles are numbered sections within the body.
 * Structure varies: some use article query params (?clen=N), some inline all.
 *
 * We extract whatever structured content is available from the page body.
 */
async function scrapeAtvpLawPage(
  url: string,
  state: IngestState,
): Promise<ParsedProvision[]> {
  if (state.processedUrls.includes(url)) {
    return [];
  }

  const html = await rateLimitedFetch(url);
  if (!html) {
    state.errors.push(`Failed to fetch ${url}`);
    return [];
  }

  const $ = cheerio.load(html);
  const provisions: ParsedProvision[] = [];

  // Determine the law name from the page title or <h1>
  const pageTitle = $("h1").first().text().trim()
    || $("title").text().trim().replace(/\s*\|.*$/, "");

  if (!pageTitle) {
    state.errors.push(`No title found on ${url}`);
    return provisions;
  }

  // Determine sourcebook and type from URL / known list
  const knownPage = ATVP_LAW_PAGES.find((p) => url.includes(p.path));
  const sourcebook = knownPage?.sourcebook ?? "ATVP_SKLEPI";
  const docType = knownPage?.type ?? (pageTitle.toLowerCase().includes("sklep") ? "sklep" : "zakon");

  // Build a reference prefix from the page id
  const refPrefix = knownPage?.id?.toUpperCase().replace(/^E-/, "")
    ?? pageTitle.replace(/\s+/g, "_").substring(0, 40);

  // Strategy 1: Look for article-like sections (clen headings)
  // ATVP e-zakonodaja pages mark articles with headings containing "clen"
  const articlePattern = /(\d+)\.\s*(?:č|c)len/i;
  let currentChapter: string | null = null;

  $("h2, h3, h4, h5, p, div.article, div.clen, section").each((_i, el) => {
    const tag = tagName(el);
    const text = $(el).text().trim();

    // Detect chapter headings
    if ((tag === "h2" || tag === "h3") && !articlePattern.test(text)) {
      const chapterMatch = text.match(/^(?:(?:I{1,4}V?|V?I{0,4}|X{0,3})\.?\s+)?(.+)/);
      if (chapterMatch && text.length > 3 && text.length < 200) {
        currentChapter = text;
      }
      return;
    }

    // Detect article headings
    const artMatch = text.match(articlePattern);
    if (artMatch) {
      const articleNum = artMatch[1]!;
      // Gather the article body: take subsequent sibling text until next article heading
      const bodyParts: string[] = [];
      let titleText = text;

      // If the heading itself contains the full article text, use it
      if (text.length > 100) {
        // The heading includes body text; split title from body
        const titleEnd = text.indexOf("\n");
        if (titleEnd > 0) {
          titleText = text.substring(0, titleEnd).trim();
          bodyParts.push(text.substring(titleEnd).trim());
        } else {
          bodyParts.push(text);
        }
      } else {
        // Gather following siblings until next heading or article marker
        let sibling = $(el).next();
        while (sibling.length > 0) {
          const sibTag = sibling[0] ? tagName(sibling[0]) : null;
          const sibText = sibling.text().trim();

          // Stop at next article or heading
          if (
            (sibTag && ["h2", "h3", "h4"].includes(sibTag)) ||
            articlePattern.test(sibText)
          ) {
            break;
          }

          if (sibText.length > 0) {
            bodyParts.push(sibText);
          }

          sibling = sibling.next();
        }
      }

      const bodyText = bodyParts.join("\n\n");
      if (bodyText.length < 10) return; // skip empty articles

      provisions.push({
        sourcebook_id: sourcebook,
        reference: `${refPrefix} clen.${articleNum}`,
        title: titleText.length < 300 ? titleText : titleText.substring(0, 297) + "...",
        text: bodyText,
        type: docType,
        status: "in_force",
        effective_date: null,
        chapter: currentChapter,
        section: articleNum,
      });
    }
  });

  // Strategy 2: If no articles found via headings, try extracting the full page body
  // as a single provision (some ATVP pages are a single consolidated text)
  if (provisions.length === 0) {
    const mainContent = $("main, article, .content, .entry-content, .page-content")
      .first()
      .text()
      .trim();

    if (mainContent.length > 100) {
      // Try to split by "clen" markers within the text
      const articleSplits = mainContent.split(/(?=\d+\.\s*(?:č|c)len)/i);

      for (const segment of articleSplits) {
        const segArtMatch = segment.match(/^(\d+)\.\s*(?:č|c)len\b/i);
        if (segArtMatch) {
          const articleNum = segArtMatch[1]!;
          const titleLine = segment.split("\n")[0]?.trim() ?? "";
          const bodyText = segment.substring(titleLine.length).trim();

          if (bodyText.length >= 10) {
            provisions.push({
              sourcebook_id: sourcebook,
              reference: `${refPrefix} clen.${articleNum}`,
              title: titleLine.length < 300 ? titleLine : titleLine.substring(0, 297) + "...",
              text: bodyText,
              type: docType,
              status: "in_force",
              effective_date: null,
              chapter: null,
              section: articleNum,
            });
          }
        }
      }

      // Last resort: store the whole page as one provision
      if (provisions.length === 0 && mainContent.length >= 50) {
        provisions.push({
          sourcebook_id: sourcebook,
          reference: refPrefix,
          title: pageTitle,
          text: mainContent.substring(0, 50_000), // cap at 50k chars
          type: docType,
          status: "in_force",
          effective_date: null,
          chapter: null,
          section: null,
        });
      }
    }
  }

  state.processedUrls.push(url);
  console.log(`    ${url} -> ${provisions.length} provisions`);
  return provisions;
}

// ---------------------------------------------------------------------------
// ATVP stalisca agencije (council positions)
// ---------------------------------------------------------------------------

/**
 * Scrape ATVP stalisca agencije (council positions and interpretive guidance).
 *
 * The ATVP council publishes positions on specific laws. Each stalisca page
 * contains a list of position documents — linked PDFs, inline headings, or
 * structured blocks with date and description.
 */
async function scrapeAtvpStalisca(
  state: IngestState,
): Promise<ParsedProvision[]> {
  const allStalisca: ParsedProvision[] = [];

  for (const page of ATVP_STALISCA_PAGES) {
    if (state.processedUrls.includes(page.url)) {
      console.log(`  ${page.id} already processed, skipping.`);
      continue;
    }

    console.log(`\n  Fetching ATVP stalisca: ${page.id}...`);
    const html = await rateLimitedFetch(page.url);
    if (!html) {
      state.errors.push(`Failed to fetch ${page.url}`);
      continue;
    }

    const $ = cheerio.load(html);

    // Strategy 1: Look for structured content blocks (headings with body text)
    $("h3, h4").each((_i, el) => {
      const heading = $(el).text().trim();
      if (heading.length < 5 || heading.length > 500) return;
      if ($(el).closest("nav, header, footer, .menu, .sidebar").length > 0) return;

      const bodyParts: string[] = [];
      let sibling = $(el).next();
      while (sibling.length > 0) {
        const sibTag = sibling[0] ? tagName(sibling[0]) : null;
        if (sibTag && ["h2", "h3", "h4"].includes(sibTag)) break;
        const sibText = sibling.text().trim();
        if (sibText.length > 0) bodyParts.push(sibText);
        sibling = sibling.next();
      }

      const fullText = bodyParts.length > 0
        ? `${heading}\n\n${bodyParts.join("\n\n")}`
        : heading;

      if (fullText.length < 20) return;

      // Extract date if present
      const dateMatch = fullText.match(/(\d{1,2}\.\d{1,2}\.\d{4})/);
      const date = dateMatch ? parseSlovenianDate(dateMatch[1]!) : null;

      const dateRef = date ?? "unknown";

      allStalisca.push({
        sourcebook_id: "ATVP_SMERNICE",
        reference: `ATVP_STALISCA ${page.law}-${dateRef}-${allStalisca.length + 1}`,
        title: heading,
        text: fullText.substring(0, 10_000),
        type: "stalisca",
        status: "in_force",
        effective_date: date,
        chapter: `Stalisca Sveta ATVP - ${page.law}`,
        section: null,
      });
    });

    // Strategy 2: Fallback to list items with PDF links
    if (allStalisca.length === 0) {
      $("li, p").each((_i, el) => {
        const text = $(el).text().trim();
        if (text.length < 20 || text.length > 2000) return;
        if ($(el).closest("nav, header, footer, .menu, .sidebar, .breadcrumb").length > 0) return;

        const link = $(el).find("a[href]").first();
        const href = link.attr("href") ?? "";
        if (!href.includes(".pdf") && !href.includes(".docx") && !href.includes("stalis")) return;

        const linkText = link.text().trim();
        if (linkText.length < 10) return;

        const cleanTitle = linkText
          .replace(/\s*\(PDF[^)]*\)/gi, "")
          .replace(/\s*\(DOCX[^)]*\)/gi, "")
          .trim();

        const dateMatch = text.match(/(\d{1,2}\.\d{1,2}\.\d{4})/);
        const date = dateMatch ? parseSlovenianDate(dateMatch[1]!) : null;
        const dateRef = date ?? "unknown";

        allStalisca.push({
          sourcebook_id: "ATVP_SMERNICE",
          reference: `ATVP_STALISCA ${page.law}-${dateRef}-${allStalisca.length + 1}`,
          title: cleanTitle,
          text: text,
          type: "stalisca",
          status: "in_force",
          effective_date: date,
          chapter: `Stalisca Sveta ATVP - ${page.law}`,
          section: null,
        });
      });
    }

    state.processedUrls.push(page.url);
    console.log(`    Found ${allStalisca.length} ATVP stalisca from ${page.id}`);
  }

  return allStalisca;
}

// ---------------------------------------------------------------------------
// ATVP enforcement actions
// ---------------------------------------------------------------------------

/**
 * Scrape ATVP enforcement actions.
 *
 * The page at /nadzorniska-razkritja-/izreceni-ukrepi lists enforcement
 * actions as linked PDF entries with metadata. The page groups enforcement
 * actions by legal basis (MAR, ZTFI-1, ZISDU-3, etc.).
 */
async function scrapeAtvpEnforcement(
  state: IngestState,
): Promise<ParsedEnforcement[]> {
  if (state.processedUrls.includes(ATVP_ENFORCEMENT_URL)) {
    console.log("  ATVP enforcement already processed, skipping.");
    return [];
  }

  console.log("\n  Fetching ATVP enforcement actions...");
  const html = await rateLimitedFetch(ATVP_ENFORCEMENT_URL);
  if (!html) {
    state.errors.push(`Failed to fetch ATVP enforcement page`);
    return [];
  }

  const $ = cheerio.load(html);
  const actions: ParsedEnforcement[] = [];

  // Enforcement entries are rendered as list items or blocks with linked PDFs
  // and descriptive text. Structure varies, so we use multiple strategies.

  // Strategy 1: List items with PDF links
  $("li, .enforcement-item, .ukrep-item").each((_i, el) => {
    const text = $(el).text().trim();
    if (text.length < 20) return;

    // Skip navigation/menu items
    if ($(el).closest("nav, header, footer, .menu, .nav").length > 0) return;

    const linkText = $(el).find("a").first().text().trim();
    const fullText = text;

    // Try to extract firm name from the link text or surrounding text
    const firmName = extractFirmName(linkText || fullText);
    if (!firmName) return;

    // Extract date
    const dateMatch = fullText.match(/(?:objava|datum)[:\s]*(\d{1,2}\.\d{1,2}\.\d{4})/i)
      ?? fullText.match(/(\d{1,2}\.\d{1,2}\.\d{4})/);
    const date = dateMatch ? parseSlovenianDate(dateMatch[1]!) : null;

    // Determine action type
    const actionType = classifyEnforcementType(fullText);

    // Extract amount if mentioned
    const amount = extractAmount(fullText);

    actions.push({
      firm_name: firmName,
      reference_number: extractReferenceNumber(fullText),
      action_type: actionType,
      amount,
      date,
      summary: fullText.substring(0, 2000),
      sourcebook_references: null,
    });
  });

  // Strategy 2: Structured content blocks (h3/h4 + paragraph pairs)
  if (actions.length === 0) {
    $("h3, h4").each((_i, el) => {
      const heading = $(el).text().trim();
      if (heading.length < 5 || heading.length > 500) return;

      const bodyParts: string[] = [];
      let sibling = $(el).next();
      while (sibling.length > 0) {
        const sibTag = sibling[0] ? tagName(sibling[0]) : null;
        if (sibTag && ["h3", "h4", "h2"].includes(sibTag)) break;
        const sibText = sibling.text().trim();
        if (sibText.length > 0) bodyParts.push(sibText);
        sibling = sibling.next();
      }

      const fullText = `${heading}\n${bodyParts.join("\n")}`;
      const firmName = extractFirmName(heading) ?? extractFirmName(fullText);
      if (!firmName) return;

      const dateMatch = fullText.match(/(\d{1,2}\.\d{1,2}\.\d{4})/);
      const date = dateMatch ? parseSlovenianDate(dateMatch[1]!) : null;

      actions.push({
        firm_name: firmName,
        reference_number: extractReferenceNumber(fullText),
        action_type: classifyEnforcementType(fullText),
        amount: extractAmount(fullText),
        date,
        summary: fullText.substring(0, 2000),
        sourcebook_references: null,
      });
    });
  }

  state.processedUrls.push(ATVP_ENFORCEMENT_URL);
  console.log(`    Found ${actions.length} ATVP enforcement actions`);
  return actions;
}

// ---------------------------------------------------------------------------
// AZN regulation scraping (podzakonski predpisi)
// ---------------------------------------------------------------------------

/**
 * Scrape an AZN regulation listing page.
 *
 * AZN pages list regulations as <h3> headings followed by <ul> items
 * containing gazette references and PDF links.
 */
async function scrapeAznRegulations(
  page: (typeof AZN_REGULATION_PAGES)[number],
  state: IngestState,
): Promise<ParsedProvision[]> {
  if (state.processedUrls.includes(page.url)) {
    console.log(`  ${page.id} already processed, skipping.`);
    return [];
  }

  console.log(`\n  Fetching AZN regulations: ${page.id}...`);
  const html = await rateLimitedFetch(page.url);
  if (!html) {
    state.errors.push(`Failed to fetch ${page.url}`);
    return [];
  }

  const $ = cheerio.load(html);
  const provisions: ParsedProvision[] = [];

  // AZN regulation pages use <h3> for regulation titles, followed by <ul>
  // lists of gazette publications
  $("h3").each((_i, el) => {
    const title = $(el).text().trim();
    if (title.length < 5 || title.length > 500) return;

    // Skip headings that are clearly navigation
    if ($(el).closest("nav, header, footer, .menu").length > 0) return;

    // Gather all list items following this heading (gazette entries)
    const listItems: string[] = [];
    let latestDate: string | null = null;
    let latestGazetteRef: string | null = null;

    const nextUl = $(el).next("ul");
    if (nextUl.length > 0) {
      nextUl.find("li").each((_j, li) => {
        const liText = $(li).text().trim();
        listItems.push(liText);

        // Track the latest (most recent) gazette entry
        const entryDate = extractDateFromGazette(liText);
        if (entryDate && (!latestDate || entryDate > latestDate)) {
          latestDate = entryDate;
          latestGazetteRef = extractGazetteRef(liText);
        }
      });
    }

    // Also check for sibling ul (sometimes nested differently)
    if (listItems.length === 0) {
      $(el).parent().find("ul li").each((_j, li) => {
        const liText = $(li).text().trim();
        if (liText.length > 10) {
          listItems.push(liText);
          const entryDate = extractDateFromGazette(liText);
          if (entryDate && (!latestDate || entryDate > latestDate)) {
            latestDate = entryDate;
            latestGazetteRef = extractGazetteRef(liText);
          }
        }
      });
    }

    // Build the provision text from gazette entries
    const gazetteText = listItems.length > 0
      ? listItems.join("\n")
      : "";

    // Build reference
    const ref = latestGazetteRef
      ? `${page.sourcebook} UL-${latestGazetteRef}`
      : `${page.sourcebook} ${title.substring(0, 60).replace(/\s+/g, "_")}`;

    // Determine status: check for "prenehal veljati" (ceased to be in force)
    // or "arhiv" in the page id
    let status = "in_force";
    if (
      page.id.includes("arhiv") ||
      gazetteText.toLowerCase().includes("prenehal veljati") ||
      gazetteText.toLowerCase().includes("razveljavljen")
    ) {
      status = "repealed";
    }

    const bodyText = gazetteText.length > 0
      ? `${title}\n\n${gazetteText}`
      : title;

    provisions.push({
      sourcebook_id: page.sourcebook,
      reference: ref,
      title,
      text: bodyText,
      type: page.type,
      status,
      effective_date: latestDate,
      chapter: page.description,
      section: latestGazetteRef,
    });
  });

  // Fallback: if no h3 headings found, try other heading levels
  if (provisions.length === 0) {
    $("h2, h4").each((_i, el) => {
      const title = $(el).text().trim();
      if (title.length < 10 || title.length > 500) return;
      if ($(el).closest("nav, header, footer, .menu, .sidebar").length > 0) return;

      // Check if this looks like a regulation title
      if (!title.toLowerCase().includes("sklep") && !title.toLowerCase().includes("tarif")) {
        return;
      }

      const nextUl = $(el).next("ul");
      const listText = nextUl.length > 0 ? nextUl.text().trim() : "";
      const dateFromList = extractDateFromGazette(listText);
      const gazetteRef = extractGazetteRef(listText);

      provisions.push({
        sourcebook_id: page.sourcebook,
        reference: gazetteRef
          ? `${page.sourcebook} UL-${gazetteRef}`
          : `${page.sourcebook} ${title.substring(0, 60).replace(/\s+/g, "_")}`,
        title,
        text: listText.length > 0 ? `${title}\n\n${listText}` : title,
        type: page.type,
        status: page.id.includes("arhiv") ? "repealed" : "in_force",
        effective_date: dateFromList,
        chapter: page.description,
        section: gazetteRef,
      });
    });
  }

  state.processedUrls.push(page.url);
  console.log(`    Found ${provisions.length} AZN regulations from ${page.id}`);
  return provisions;
}

// ---------------------------------------------------------------------------
// AZN stalisca (agency positions)
// ---------------------------------------------------------------------------

/**
 * Scrape AZN stalisca (agency positions / interpretive guidance).
 *
 * The page lists 40+ position documents as linked PDFs with publication dates.
 */
async function scrapeAznStalisca(
  state: IngestState,
): Promise<ParsedProvision[]> {
  if (state.processedUrls.includes(AZN_STALISCA_URL)) {
    console.log("  AZN stalisca already processed, skipping.");
    return [];
  }

  console.log("\n  Fetching AZN stalisca agencije...");
  const html = await rateLimitedFetch(AZN_STALISCA_URL);
  if (!html) {
    state.errors.push("Failed to fetch AZN stalisca page");
    return [];
  }

  const $ = cheerio.load(html);
  const provisions: ParsedProvision[] = [];

  // Stalisca are listed as linked PDF documents with dates
  // Structure: <li><a href="...pdf">Title (PDF, size)</a> objava DD.MM.YYYY</li>
  // or sometimes as <p> elements with embedded links

  // Try list items first
  $("li, p").each((_i, el) => {
    const text = $(el).text().trim();
    if (text.length < 20 || text.length > 2000) return;

    // Skip navigation and structural elements
    if ($(el).closest("nav, header, footer, .menu, .sidebar, .breadcrumb").length > 0) return;

    // Look for linked documents (PDF or DOCX)
    const link = $(el).find("a[href]").first();
    const href = link.attr("href") ?? "";
    if (!href.includes(".pdf") && !href.includes(".docx") && !href.includes("stalis")) return;

    const linkText = link.text().trim();
    if (linkText.length < 10) return;

    // Clean up the title (remove file size info)
    const cleanTitle = linkText
      .replace(/\s*\(PDF[^)]*\)/gi, "")
      .replace(/\s*\(DOCX[^)]*\)/gi, "")
      .trim();

    // Extract date from surrounding text
    const dateMatch = text.match(/objava\s+(\d{1,2}\.\d{1,2}\.\d{4})/i)
      ?? text.match(/(\d{1,2}\.\d{1,2}\.\d{4})/);
    const date = dateMatch ? parseSlovenianDate(dateMatch[1]!) : null;

    // Build reference from date
    const dateRef = date ?? "unknown";
    const ref = `AZN_SMERNICE STALISCE-${dateRef}`;

    provisions.push({
      sourcebook_id: "AZN_SMERNICE",
      reference: ref,
      title: cleanTitle,
      text: text,
      type: "stalisca",
      status: "in_force",
      effective_date: date,
      chapter: "Stalisca agencije",
      section: null,
    });
  });

  state.processedUrls.push(AZN_STALISCA_URL);
  console.log(`    Found ${provisions.length} AZN stalisca`);
  return provisions;
}

// ---------------------------------------------------------------------------
// AZN enforcement actions
// ---------------------------------------------------------------------------

/**
 * Scrape AZN enforcement actions from both the zavarovalnice and
 * zastopniki pages.
 */
async function scrapeAznEnforcement(
  state: IngestState,
): Promise<ParsedEnforcement[]> {
  const allActions: ParsedEnforcement[] = [];

  for (const page of AZN_ENFORCEMENT_PAGES) {
    if (state.processedUrls.includes(page.url)) {
      console.log(`  ${page.id} already processed, skipping.`);
      continue;
    }

    console.log(`\n  Fetching AZN enforcement: ${page.label}...`);
    const html = await rateLimitedFetch(page.url);
    if (!html) {
      state.errors.push(`Failed to fetch ${page.url}`);
      continue;
    }

    const $ = cheerio.load(html);

    // AZN enforcement entries are list items containing linked PDFs
    // Format: <li><a href="...pdf">Title with firm name</a>, objava DD.MM.YYYY (status)</li>
    $("li").each((_i, el) => {
      const text = $(el).text().trim();
      if (text.length < 20) return;

      // Skip nav/menu items
      if ($(el).closest("nav, header, footer, .menu, .sidebar, .breadcrumb").length > 0) return;

      // Must contain a link to a PDF (enforcement PDFs)
      const link = $(el).find("a[href]").first();
      const href = link.attr("href") ?? "";
      // Not all enforcement items have PDF links, so also check for enforcement keywords
      if (
        !href.includes(".pdf") &&
        !text.toLowerCase().includes("ukrep") &&
        !text.toLowerCase().includes("krsitev") &&
        !text.toLowerCase().includes("kršitev")
      ) {
        return;
      }

      const linkText = link.text().trim();
      const firmName = extractFirmName(linkText || text);
      if (!firmName) return;

      // Extract date
      const dateMatch = text.match(/objava\s+(\d{1,2}\.\d{1,2}\.\d{4})/i)
        ?? text.match(/(\d{1,2}\.\d{1,2}\.\d{4})/);
      const date = dateMatch ? parseSlovenianDate(dateMatch[1]!) : null;

      // Determine action type
      const actionType = classifyEnforcementType(text);

      // Check status (answered / resolved)
      const isRemedied = text.toLowerCase().includes("odpravljena")
        || text.toLowerCase().includes("odpravlj");

      allActions.push({
        firm_name: firmName,
        reference_number: extractReferenceNumber(text),
        action_type: actionType,
        amount: extractAmount(text),
        date,
        summary: `${text}${isRemedied ? " [krsitev odpravljena]" : ""}`.substring(0, 2000),
        sourcebook_references: null,
      });
    });

    state.processedUrls.push(page.url);
    console.log(`    Found ${allActions.length} AZN enforcement actions from ${page.id}`);
  }

  return allActions;
}

// ---------------------------------------------------------------------------
// Helper: firm name extraction
// ---------------------------------------------------------------------------

/**
 * Extract a firm/entity name from enforcement text.
 *
 * Slovenian firm names end with suffixes like d.d., d.o.o., d.n.o., k.d.,
 * or are well-known institution names.
 */
function extractFirmName(text: string): string | null {
  if (!text || text.length < 5) return null;

  // Pattern 1: Legal entity with suffix (d.d., d.o.o., etc.)
  const entityMatch = text.match(
    /([A-ZŠĐČĆŽ][A-Za-zšđčćžŠĐČĆŽáéíóúàèìòùäëïöüâêîôû\s\-&.,]+(?:d\.d\.|d\.o\.o\.|d\.n\.o\.|k\.d\.|z\.o\.o\.|s\.p\.))/i,
  );
  if (entityMatch) {
    return entityMatch[1]!.trim();
  }

  // Pattern 2: Capitalized multi-word name (at least 2 words, starts with uppercase)
  const nameMatch = text.match(
    /([A-ZŠĐČĆŽ][A-Za-zšđčćžŠĐČĆŽ]+(?:\s+[A-Za-zšđčćžŠĐČĆŽ]+){1,6})/,
  );
  if (nameMatch && nameMatch[1]!.length > 5) {
    return nameMatch[1]!.trim();
  }

  // Pattern 3: Use the first meaningful segment of the text
  const firstLine = text.split(/[,\n]/).find((s) => s.trim().length > 5);
  if (firstLine && firstLine.trim().length > 5 && firstLine.trim().length < 200) {
    return firstLine.trim();
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helper: enforcement action classification
// ---------------------------------------------------------------------------

function classifyEnforcementType(text: string): string {
  const lower = text.toLowerCase();

  if (lower.includes("globa") || lower.includes("kazen") || lower.includes("denarn")) {
    return "fine";
  }
  if (lower.includes("prepoved") || lower.includes("odvzem dovoljenja") || lower.includes("odvzem licence")) {
    return "prohibition";
  }
  if (lower.includes("opozorilo") || lower.includes("opomin")) {
    return "warning";
  }
  if (lower.includes("omejitev") || lower.includes("prepoved izplacila")) {
    return "restriction";
  }
  if (lower.includes("odredba") || lower.includes("odprav")) {
    return "corrective_order";
  }
  if (lower.includes("nadzorni ukrep") || lower.includes("nadzorniski ukrep")) {
    return "supervisory_measure";
  }

  return "supervisory_measure";
}

// ---------------------------------------------------------------------------
// Helper: amount extraction
// ---------------------------------------------------------------------------

function extractAmount(text: string): number | null {
  const patterns = [
    // "N EUR" or "EUR N" or "N eur"
    /([\d.,\s]+)\s*EUR/gi,
    /EUR\s*([\d.,\s]+)/gi,
    // "N eurov" / "N eura" / "N evrov"
    /([\d.,\s]+)\s*(?:eurov|eura|evrov|eur)\b/gi,
    // "globa ... N"
    /glob[aeo]\s+(?:v\s+znesku\s+)?([\d.,\s]+)/gi,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      let numStr = match[1].trim();
      // Slovenian number formatting: 1.234,56 (dot thousands, comma decimal)
      numStr = numStr.replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
      const val = parseFloat(numStr);
      if (!isNaN(val) && val > 0) return val;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helper: reference number extraction
// ---------------------------------------------------------------------------

function extractReferenceNumber(text: string): string | null {
  // ATVP reference patterns: ATVP-YYYY-XX-NNN or similar
  const atvpMatch = text.match(/ATVP[\-\/]\d{4}[\-\/][A-Z]{2,4}[\-\/]\d{1,5}/i);
  if (atvpMatch) return atvpMatch[0];

  // AZN reference patterns
  const aznMatch = text.match(/AZN[\-\/]\d{4}[\-\/][A-Z]{2,4}[\-\/]\d{1,5}/i);
  if (aznMatch) return aznMatch[0];

  // Generic Slovenian administrative reference: NNN-NNN/YYYY or NNN/YYYY-NNN
  const genericMatch = text.match(/\d{2,6}[\-\/]\d{2,6}[\-\/]\d{4}/);
  if (genericMatch) return genericMatch[0];

  return null;
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

function initDb(): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`Deleted existing database at ${DB_PATH}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  return db;
}

function ensureSourcebooks(db: Database.Database): void {
  const insertSourcebook = db.prepare(
    "INSERT OR IGNORE INTO sourcebooks (id, name, description) VALUES (?, ?, ?)",
  );

  const sourcebooks = [
    {
      id: "ATVP_SKLEPI",
      name: "ATVP Sklepi",
      description:
        "Sklepi in zakoni Agencije za trg vrednostnih papirjev o regulaciji trga kapitala, avtorizacijah in nadzornih ukrepih.",
    },
    {
      id: "ATVP_SMERNICE",
      name: "ATVP Smernice",
      description:
        "Smernice in stalisca ATVP za udelezence na trgu kapitala glede zahtev za razkritje, ravnanja s strankami in upravljanja tveganj.",
    },
    {
      id: "AZN_PREDPISI",
      name: "AZN Predpisi",
      description:
        "Podzakonski predpisi Agencije za zavarovalni nadzor na podlagi ZZavar-1, ZPIZ-2 in ZOZP o nadzoru zavarovalnistva.",
    },
    {
      id: "AZN_SMERNICE",
      name: "AZN Smernice in stalisca",
      description:
        "Smernice, stalisca in interpretativna navodila Agencije za zavarovalni nadzor za enotno uporabo zakonodaje.",
    },
    {
      id: "BS_REGULACIJE",
      name: "BS Regulacije",
      description:
        "Regulacije Banke Slovenije o bonitetnem nadzoru kreditnih institucij, kapitalskih zahtevah in upravljanju likvidnosti.",
    },
  ];

  for (const sb of sourcebooks) {
    insertSourcebook.run(sb.id, sb.name, sb.description);
  }
}

function insertProvisions(
  db: Database.Database,
  provisions: ParsedProvision[],
): number {
  if (provisions.length === 0) return 0;

  const insert = db.prepare(`
    INSERT INTO provisions (sourcebook_id, reference, title, text, type, status, effective_date, chapter, section)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const checkExists = db.prepare(
    "SELECT id FROM provisions WHERE reference = ? LIMIT 1",
  );

  let inserted = 0;

  const tx = db.transaction(() => {
    for (const p of provisions) {
      // Skip duplicates
      const existing = checkExists.get(p.reference) as { id: number } | undefined;
      if (existing) continue;

      insert.run(
        p.sourcebook_id,
        p.reference,
        p.title,
        p.text,
        p.type,
        p.status,
        p.effective_date,
        p.chapter,
        p.section,
      );
      inserted++;
    }
  });

  tx();
  return inserted;
}

function insertEnforcementActions(
  db: Database.Database,
  actions: ParsedEnforcement[],
): number {
  if (actions.length === 0) return 0;

  const insert = db.prepare(`
    INSERT INTO enforcement_actions (firm_name, reference_number, action_type, amount, date, summary, sourcebook_references)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const checkExists = db.prepare(
    "SELECT id FROM enforcement_actions WHERE firm_name = ? AND date = ? LIMIT 1",
  );

  let inserted = 0;

  const tx = db.transaction(() => {
    for (const e of actions) {
      // Skip duplicates (same firm + date)
      const existing = checkExists.get(e.firm_name, e.date) as { id: number } | undefined;
      if (existing) continue;

      insert.run(
        e.firm_name,
        e.reference_number,
        e.action_type,
        e.amount,
        e.date,
        e.summary,
        e.sourcebook_references,
      );
      inserted++;
    }
  });

  tx();
  return inserted;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log("Slovenian Financial Regulation Ingestion Crawler");
  console.log("  ATVP (atvp.si) + AZN (a-zn.si)");
  console.log(`  Database: ${DB_PATH}`);
  console.log(`  Mode: ${dryRun ? "DRY RUN" : force ? "FORCE (clean DB)" : resume ? "RESUME" : "NORMAL"}`);
  console.log("=".repeat(70));

  const state = loadState();

  // Accumulate all scraped data before writing to DB
  const allProvisions: ParsedProvision[] = [];
  const allEnforcementActions: ParsedEnforcement[] = [];

  // -- Phase 1: ATVP e-Zakonodaja (laws and general acts) -------------------

  console.log("\n[Phase 1] ATVP e-Zakonodaja");
  console.log("-".repeat(40));

  const atvpLawUrls = await discoverAtvpLawPages();
  const effectiveMax = maxPagesOverride
    ? Math.min(maxPagesOverride, atvpLawUrls.length)
    : atvpLawUrls.length;

  for (let i = 0; i < effectiveMax; i++) {
    const url = atvpLawUrls[i]!;
    try {
      const provisions = await scrapeAtvpLawPage(url, state);
      allProvisions.push(...provisions);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  [ERROR] Failed to scrape ${url}: ${message}`);
      state.errors.push(`${url}: ${message}`);
    }
    saveState(state);
  }

  // -- Phase 2: ATVP Stalisca agencije (council positions) -----------------

  console.log("\n[Phase 2] ATVP Stalisca agencije");
  console.log("-".repeat(40));

  try {
    const atvpStalisca = await scrapeAtvpStalisca(state);
    allProvisions.push(...atvpStalisca);
    state.stalisceIngested += atvpStalisca.length;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  [ERROR] ATVP stalisca scraping failed: ${message}`);
    state.errors.push(`ATVP stalisca: ${message}`);
  }
  saveState(state);

  // -- Phase 3: ATVP Enforcement Actions ------------------------------------

  console.log("\n[Phase 3] ATVP Enforcement Actions");
  console.log("-".repeat(40));

  try {
    const atvpEnforcement = await scrapeAtvpEnforcement(state);
    allEnforcementActions.push(...atvpEnforcement);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  [ERROR] ATVP enforcement scraping failed: ${message}`);
    state.errors.push(`ATVP enforcement: ${message}`);
  }
  saveState(state);

  // -- Phase 4: AZN Podzakonski predpisi (subordinate regulations) ----------

  console.log("\n[Phase 4] AZN Podzakonski predpisi");
  console.log("-".repeat(40));

  for (const regPage of AZN_REGULATION_PAGES) {
    try {
      const provisions = await scrapeAznRegulations(regPage, state);
      allProvisions.push(...provisions);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  [ERROR] Failed to scrape ${regPage.id}: ${message}`);
      state.errors.push(`${regPage.id}: ${message}`);
    }
    saveState(state);
  }

  // -- Phase 5: AZN Stalisca agencije --------------------------------------

  console.log("\n[Phase 5] AZN Stalisca agencije");
  console.log("-".repeat(40));

  try {
    const stalisca = await scrapeAznStalisca(state);
    allProvisions.push(...stalisca);
    state.stalisceIngested += stalisca.length;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  [ERROR] AZN stalisca scraping failed: ${message}`);
    state.errors.push(`AZN stalisca: ${message}`);
  }
  saveState(state);

  // -- Phase 6: AZN Enforcement Actions -------------------------------------

  console.log("\n[Phase 6] AZN Enforcement Actions");
  console.log("-".repeat(40));

  try {
    const aznEnforcement = await scrapeAznEnforcement(state);
    allEnforcementActions.push(...aznEnforcement);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  [ERROR] AZN enforcement scraping failed: ${message}`);
    state.errors.push(`AZN enforcement: ${message}`);
  }
  saveState(state);

  // -- Phase 7: Write to database -------------------------------------------

  console.log("\n[Phase 7] Database write");
  console.log("-".repeat(40));

  console.log(`  Scraped ${allProvisions.length} provisions`);
  console.log(`  Scraped ${allEnforcementActions.length} enforcement actions`);

  if (dryRun) {
    console.log("\n  DRY RUN — no database changes made.");
    console.log("\n  Sample provisions:");
    for (const p of allProvisions.slice(0, 5)) {
      console.log(`    [${p.sourcebook_id}] ${p.reference}: ${p.title?.substring(0, 80)}`);
    }
    console.log("\n  Sample enforcement actions:");
    for (const e of allEnforcementActions.slice(0, 5)) {
      console.log(`    ${e.firm_name} (${e.date}) — ${e.action_type}`);
    }
  } else {
    const db = initDb();
    ensureSourcebooks(db);

    const provInserted = insertProvisions(db, allProvisions);
    const enfInserted = insertEnforcementActions(db, allEnforcementActions);

    state.provisionsIngested += provInserted;
    state.enforcementsIngested += enfInserted;

    console.log(`  Inserted ${provInserted} new provisions (${allProvisions.length - provInserted} duplicates skipped)`);
    console.log(`  Inserted ${enfInserted} new enforcement actions (${allEnforcementActions.length - enfInserted} duplicates skipped)`);

    // Print final counts
    const provisionCount = (
      db.prepare("SELECT count(*) as cnt FROM provisions").get() as { cnt: number }
    ).cnt;
    const sourcebookCount = (
      db.prepare("SELECT count(*) as cnt FROM sourcebooks").get() as { cnt: number }
    ).cnt;
    const enforcementCount = (
      db.prepare("SELECT count(*) as cnt FROM enforcement_actions").get() as { cnt: number }
    ).cnt;
    const ftsCount = (
      db.prepare("SELECT count(*) as cnt FROM provisions_fts").get() as { cnt: number }
    ).cnt;

    console.log(`\n  Database summary:`);
    console.log(`    Sourcebooks:          ${sourcebookCount}`);
    console.log(`    Provisions:           ${provisionCount}`);
    console.log(`    Enforcement actions:  ${enforcementCount}`);
    console.log(`    FTS entries:          ${ftsCount}`);

    db.close();
  }

  // -- Summary --------------------------------------------------------------

  saveState(state);

  console.log("\n" + "=".repeat(70));
  console.log("Ingestion complete");
  console.log(`  Total provisions scraped:    ${allProvisions.length}`);
  console.log(`  Total enforcement scraped:   ${allEnforcementActions.length}`);
  console.log(`  URLs processed:              ${state.processedUrls.length}`);
  console.log(`  Errors:                      ${state.errors.length}`);

  if (state.errors.length > 0) {
    console.log("\n  Errors encountered:");
    for (const err of state.errors) {
      console.log(`    - ${err}`);
    }
  }

  console.log(`\n  State saved to ${STATE_FILE}`);
  console.log("=".repeat(70));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
