/**
 * Seed the Slovenian Financial Regulation database with sample provisions for testing.
 *
 * Inserts provisions from ATVP_Sklepi (capital market decisions), ATVP_Smernice,
 * and BS_Regulacije (banking supervision regulations) sourcebooks.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force   # drop and recreate
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["ATVP_DB_PATH"] ?? "data/atvp.db";
const force = process.argv.includes("--force");

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

console.log(`Database initialised at ${DB_PATH}`);

interface SourcebookRow {
  id: string;
  name: string;
  description: string;
}

const sourcebooks: SourcebookRow[] = [
  {
    id: "ATVP_SKLEPI",
    name: "ATVP Sklepi",
    description: "Sklepi Agencije za trg vrednostnih papirjev o regulaciji trga kapitala, avtorizacijah in nadzornih ukrepih.",
  },
  {
    id: "ATVP_SMERNICE",
    name: "ATVP Smernice",
    description: "Smernice ATVP za udelezence na trgu kapitala glede zahtev za razkritje, ravnanja s strankami in upravljanja tveganj.",
  },
  {
    id: "BS_REGULACIJE",
    name: "BS Regulacije",
    description: "Regulacije Banke Slovenije o bonitetnem nadzoru kreditnih institucij, kapitalskih zahtevah in upravljanju likvidnosti.",
  },
];

const insertSourcebook = db.prepare(
  "INSERT OR IGNORE INTO sourcebooks (id, name, description) VALUES (?, ?, ?)",
);

for (const sb of sourcebooks) {
  insertSourcebook.run(sb.id, sb.name, sb.description);
}

console.log(`Inserted ${sourcebooks.length} sourcebooks`);

interface ProvisionRow {
  sourcebook_id: string;
  reference: string;
  title: string;
  text: string;
  type: string;
  status: string;
  effective_date: string;
  chapter: string;
  section: string;
}

const provisions: ProvisionRow[] = [
  {
    sourcebook_id: "ATVP_SKLEPI",
    reference: "ATVP_SKLEPI 2019/1 clen.5",
    title: "Zahteve za dovoljenje za opravljanje investicijskih storitev",
    text: "Borznoposredniška druzba, ki zeli pridobiti dovoljenje za opravljanje investicijskih storitev, mora ATVP predloziti vlogo z dokazili o ustreznem kapitalu, poslovnim nacrtom in podatki o delnicarjih s kvalificiranimi deleži ter dokazili o ustrezni organizacijski strukturi.",
    type: "sklep",
    status: "in_force",
    effective_date: "2019-03-01",
    chapter: "I",
    section: "5",
  },
  {
    sourcebook_id: "ATVP_SKLEPI",
    reference: "ATVP_SKLEPI 2020/4 clen.3",
    title: "Zahteve glede razkritij za javne druzbe",
    text: "Javne druzbe, katerih vrednostni papirji so sprejeti v trgovanje na organiziranem trgu, morajo takoj objaviti notranje informacije, ki se nanasajo nanje. Odlozitev razkritja je dovoljena le, ce so izpolnjeni pogoji iz 17. clena Uredbe MAR.",
    type: "sklep",
    status: "in_force",
    effective_date: "2020-07-01",
    chapter: "II",
    section: "3",
  },
  {
    sourcebook_id: "ATVP_SKLEPI",
    reference: "ATVP_SKLEPI 2021/2 clen.7",
    title: "Obveznosti glede ravnanja s strankami — ustreznost in primernost",
    text: "Investicijska podjetja morajo pred opravljanjem storitev upravljanja portfelja ali investicijskega svetovanja pridobiti od stranke informacije o njenem znanju in financnem polozaju ter oceniti ustreznost predlagane nalozbe.",
    type: "sklep",
    status: "in_force",
    effective_date: "2021-01-01",
    chapter: "III",
    section: "7",
  },
  {
    sourcebook_id: "ATVP_SMERNICE",
    reference: "ATVP_SMERNICE 2022/1 tocka.4",
    title: "Smernice za upravljanje tveganja trzne zlorabe",
    text: "Investicijska podjetja morajo vzpostaviti ucinkovite sisteme in postopke za prepoznavanje in prijavo sumljivih nalogov in transakcij, ki bi lahko pomenili trzno zlorabo. Porocila o sumljivih transakcijah je treba predloziti ATVP takoj po zaznavi.",
    type: "smernica",
    status: "in_force",
    effective_date: "2022-01-01",
    chapter: "II",
    section: "4",
  },
  {
    sourcebook_id: "ATVP_SMERNICE",
    reference: "ATVP_SMERNICE 2023/2 tocka.2",
    title: "Smernice za razkritja trajnostnosti",
    text: "Financni udelezenci trga morajo v skladu z Uredbo SFDR razkriti informacije o vkljucevanju tveganj trajnostnosti v postopke odlocanja o nalozbanjih. Razkritja morajo biti jasna, kratka in razumljiva.",
    type: "smernica",
    status: "in_force",
    effective_date: "2023-01-01",
    chapter: "I",
    section: "2",
  },
  {
    sourcebook_id: "BS_REGULACIJE",
    reference: "BS_REGULACIJE 2020/2 clen.12",
    title: "Zahteve glede minimalnega kapitala kreditnih institucij",
    text: "Kreditne institucije morajo ves cas izpolnjevati minimalne kapitalske zahteve v skladu z Uredbo CRR. Skupna kapitalska ustreznost ne sme biti nizja od 8% tveganju prilagojenih aktiv.",
    type: "regulacija",
    status: "in_force",
    effective_date: "2020-01-01",
    chapter: "IV",
    section: "12",
  },
  {
    sourcebook_id: "BS_REGULACIJE",
    reference: "BS_REGULACIJE 2018/5 clen.8",
    title: "Zahteve glede likvidnostnega kritja",
    text: "Kreditne institucije morajo vzdrzevati zadosten obseg visoko likvidnih sredstev za pokritje neto odlivov gotovine v 30-dnevnem obdobju stresa. Koeficient likvidnostnega kritja (LCR) mora biti ves cas vsaj 100%.",
    type: "regulacija",
    status: "in_force",
    effective_date: "2018-06-01",
    chapter: "III",
    section: "8",
  },
  {
    sourcebook_id: "BS_REGULACIJE",
    reference: "BS_REGULACIJE 2022/1 clen.15",
    title: "Zahteve glede notranjega upravljanja in kontrol",
    text: "Kreditne institucije morajo vzpostaviti zanesljive ureditve notranjega upravljanja z jasno organizacijsko strukturo, ucinkovitimi postopki za upravljanje tveganj in mehanizmi notranje kontrole.",
    type: "regulacija",
    status: "in_force",
    effective_date: "2022-03-01",
    chapter: "V",
    section: "15",
  },
];

const insertProvision = db.prepare(`
  INSERT INTO provisions (sourcebook_id, reference, title, text, type, status, effective_date, chapter, section)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertAll = db.transaction(() => {
  for (const p of provisions) {
    insertProvision.run(
      p.sourcebook_id, p.reference, p.title, p.text,
      p.type, p.status, p.effective_date, p.chapter, p.section,
    );
  }
});

insertAll();

console.log(`Inserted ${provisions.length} sample provisions`);

interface EnforcementRow {
  firm_name: string;
  reference_number: string;
  action_type: string;
  amount: number;
  date: string;
  summary: string;
  sourcebook_references: string;
}

const enforcements: EnforcementRow[] = [
  {
    firm_name: "Ilirika Borznoposredniška Hisa d.d.",
    reference_number: "ATVP-2022-SK-001",
    action_type: "fine",
    amount: 25000,
    date: "2022-03-10",
    summary: "ATVP je izrekla globo zaradi krsitev pravil o razkritju notranjih informacij. Druzba ni pravocasno objavila notranjih informacij in ni ustrezno vodila evidenc oseb z dostopom do notranjih informacij.",
    sourcebook_references: "ATVP_SKLEPI 2020/4 clen.3",
  },
  {
    firm_name: "Nova Kreditna Banka Maribor d.d.",
    reference_number: "BS-2021-NUK-003",
    action_type: "restriction",
    amount: 0,
    date: "2021-11-15",
    summary: "Banka Slovenije je naklozila ukrep prepovedi izplacila dividend za obdobje enega leta zaradi pomanjkljivosti pri upravljanju kreditnega tveganja in nezadostnih rezervacij za slaba posojila.",
    sourcebook_references: "BS_REGULACIJE 2022/1 clen.15, BS_REGULACIJE 2020/2 clen.12",
  },
];

const insertEnforcement = db.prepare(`
  INSERT INTO enforcement_actions (firm_name, reference_number, action_type, amount, date, summary, sourcebook_references)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const insertEnforcementsAll = db.transaction(() => {
  for (const e of enforcements) {
    insertEnforcement.run(
      e.firm_name, e.reference_number, e.action_type, e.amount,
      e.date, e.summary, e.sourcebook_references,
    );
  }
});

insertEnforcementsAll();

console.log(`Inserted ${enforcements.length} sample enforcement actions`);

const provisionCount = (db.prepare("SELECT count(*) as cnt FROM provisions").get() as { cnt: number }).cnt;
const sourcebookCount = (db.prepare("SELECT count(*) as cnt FROM sourcebooks").get() as { cnt: number }).cnt;
const enforcementCount = (db.prepare("SELECT count(*) as cnt FROM enforcement_actions").get() as { cnt: number }).cnt;
const ftsCount = (db.prepare("SELECT count(*) as cnt FROM provisions_fts").get() as { cnt: number }).cnt;

console.log(`\nDatabase summary:`);
console.log(`  Sourcebooks:          ${sourcebookCount}`);
console.log(`  Provisions:           ${provisionCount}`);
console.log(`  Enforcement actions:  ${enforcementCount}`);
console.log(`  FTS entries:          ${ftsCount}`);
console.log(`\nDone. Database ready at ${DB_PATH}`);

db.close();
