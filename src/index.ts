#!/usr/bin/env node

/**
 * Slovenian Financial Regulation MCP — stdio entry point.
 *
 * Provides MCP tools for querying ATVP (Agencija za trg vrednostnih papirjev)
 * and BS (Banka Slovenije) regulations: sklepi, smernice, regulacije,
 * enforcement actions, and currency checks.
 *
 * Tool prefix: si_fin_
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  listSourcebooks,
  searchProvisions,
  getProvision,
  searchEnforcement,
  checkProvisionCurrency,
} from "./db.js";
import { buildCitation } from "./utils/citation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback to default
}

const SERVER_NAME = "slovenian-financial-regulation-mcp";

// ─── Tool definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "si_fin_search_regulations",
    description:
      "Full-text search across Slovenian financial regulation provisions. Returns matching ATVP sklepi on capital markets, ATVP smernice, and BS regulacije on banking supervision.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query in Slovenian (e.g., 'kapitalske zahteve', 'trg vrednostnih papirjev', 'bonitetni nadzor')",
        },
        sourcebook: {
          type: "string",
          description: "Filter by sourcebook ID (e.g., ATVP_SKLEPI, ATVP_SMERNICE, BS_REGULACIJE). Optional.",
        },
        status: {
          type: "string",
          enum: ["in_force", "deleted", "not_yet_in_force"],
          description: "Filter by provision status. Defaults to all statuses.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "si_fin_get_regulation",
    description:
      "Get a specific Slovenian financial regulation provision by sourcebook and reference. Accepts references like 'ATVP_SKLEPI 2019/1 clen.5' or 'BS_REGULACIJE 2020/2 clen.12'.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sourcebook: {
          type: "string",
          description: "Sourcebook identifier (e.g., ATVP_SKLEPI, BS_REGULACIJE)",
        },
        reference: {
          type: "string",
          description: "Full provision reference (e.g., 'ATVP_SKLEPI 2019/1 clen.5')",
        },
      },
      required: ["sourcebook", "reference"],
    },
  },
  {
    name: "si_fin_list_sourcebooks",
    description:
      "List all Slovenian financial regulation sourcebooks with their names and descriptions. Covers ATVP and BS regulatory output.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "si_fin_search_enforcement",
    description:
      "Search ATVP and BS enforcement actions — ukrepi, sankcije, and prepovedi. Returns matching enforcement decisions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g., firm name, type of breach, 'zloraba trga')",
        },
        action_type: {
          type: "string",
          enum: ["fine", "ban", "restriction", "warning"],
          description: "Filter by action type. Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "si_fin_check_currency",
    description:
      "Check whether a specific Slovenian financial regulation provision reference is currently in force. Returns status and effective date.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: {
          type: "string",
          description: "Full provision reference to check",
        },
      },
      required: ["reference"],
    },
  },
  {
    name: "si_fin_about",
    description: "Return metadata about this MCP server: version, data source, tool list.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// ─── Zod schemas for argument validation ────────────────────────────────────

const SearchRegulationsArgs = z.object({
  query: z.string().min(1),
  sourcebook: z.string().optional(),
  status: z.enum(["in_force", "deleted", "not_yet_in_force"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetRegulationArgs = z.object({
  sourcebook: z.string().min(1),
  reference: z.string().min(1),
});

const SearchEnforcementArgs = z.object({
  query: z.string().min(1),
  action_type: z.enum(["fine", "ban", "restriction", "warning"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const CheckCurrencyArgs = z.object({
  reference: z.string().min(1),
});

// ─── Helper ──────────────────────────────────────────────────────────────────

function textContent(data: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}

function errorContent(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

// ─── Server setup ────────────────────────────────────────────────────────────

const server = new Server(
  { name: SERVER_NAME, version: pkgVersion },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case "si_fin_search_regulations": {
        const parsed = SearchRegulationsArgs.parse(args);
        const results = searchProvisions({
          query: parsed.query,
          sourcebook: parsed.sourcebook,
          status: parsed.status,
          limit: parsed.limit,
        });
        return textContent({ results, count: results.length });
      }

      case "si_fin_get_regulation": {
        const parsed = GetRegulationArgs.parse(args);
        const provision = getProvision(parsed.sourcebook, parsed.reference);
        if (!provision) {
          return errorContent(
            `Provision not found: ${parsed.sourcebook} ${parsed.reference}`,
          );
        }
        const _citation = buildCitation(
          parsed.reference,
          (provision as Record<string, unknown>).title as string || `${parsed.sourcebook} ${parsed.reference}`,
          "si_fin_get_regulation",
          { sourcebook: parsed.sourcebook, reference: parsed.reference },
        );
        return textContent({ ...provision as Record<string, unknown>, _citation });
      }

      case "si_fin_list_sourcebooks": {
        const sourcebooks = listSourcebooks();
        return textContent({ sourcebooks, count: sourcebooks.length });
      }

      case "si_fin_search_enforcement": {
        const parsed = SearchEnforcementArgs.parse(args);
        const results = searchEnforcement({
          query: parsed.query,
          action_type: parsed.action_type,
          limit: parsed.limit,
        });
        return textContent({ results, count: results.length });
      }

      case "si_fin_check_currency": {
        const parsed = CheckCurrencyArgs.parse(args);
        const currency = checkProvisionCurrency(parsed.reference);
        return textContent(currency);
      }

      case "si_fin_about": {
        return textContent({
          name: SERVER_NAME,
          version: pkgVersion,
          description:
            "Slovenian Financial Regulation MCP server. Provides access to ATVP (Agencija za trg vrednostnih papirjev) sklepi on capital markets and BS (Banka Slovenije) regulacije on banking supervision.",
          data_sources: [
            "ATVP (https://www.atvp.si/)",
            "Banka Slovenije (https://www.bsi.si/)",
          ],
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
        });
      }

      default:
        return errorContent(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorContent(`Error executing ${name}: ${message}`);
  }
});

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} v${pkgVersion} running on stdio\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
