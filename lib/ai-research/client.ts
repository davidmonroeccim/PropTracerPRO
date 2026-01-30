// AI Research Orchestrator
// Uses Brave Search + Claude to extract property owner information

import { searchBrave, searchBraveBatch } from '@/lib/brave/client';
import { AI_RESEARCH } from '@/lib/constants';
import type { AIResearchResult } from '@/types';

interface ResearchInput {
  address: string;
  city: string;
  state: string;
  zip: string;
  owner_name?: string;
}

// Single property research
export async function researchProperty(
  address: string,
  city: string,
  state: string,
  zip: string,
  ownerName?: string
): Promise<AIResearchResult> {
  // Build search queries
  const queries = buildSearchQueries(address, city, state, zip, ownerName);

  // Run all Brave searches
  const searchResults = await Promise.all(
    queries.map((q) => searchBrave(q))
  );

  // Combine all search results into a single context
  const combinedContext = queries.map((query, i) => {
    const results = searchResults[i];
    const snippets = results
      .map((r) => `- ${r.title}: ${r.description} (${r.url})`)
      .join('\n');
    return `Query: "${query}"\nResults:\n${snippets || '(no results)'}`;
  }).join('\n\n');

  // Send to Claude for extraction
  return await extractWithClaude(
    [{ address, city, state, zip, owner_name: ownerName }],
    [combinedContext]
  ).then((results) => results[0]);
}

// Batch property research
export async function researchPropertyBatch(
  records: ResearchInput[]
): Promise<AIResearchResult[]> {
  // Build all queries for all records
  const allQueries: string[] = [];
  const queryMap: Map<number, string[]> = new Map();

  for (let i = 0; i < records.length; i++) {
    const { address, city, state, zip, owner_name } = records[i];
    const queries = buildSearchQueries(address, city, state, zip, owner_name);
    queryMap.set(i, queries);
    allQueries.push(...queries);
  }

  // Run all Brave searches in batch (respects rate limits internally)
  const braveResults = await searchBraveBatch(allQueries);

  // Group search results by record
  const recordContexts: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const queries = queryMap.get(i) || [];
    const context = queries.map((query) => {
      const results = braveResults.get(query) || [];
      const snippets = results
        .map((r) => `- ${r.title}: ${r.description} (${r.url})`)
        .join('\n');
      return `Query: "${query}"\nResults:\n${snippets || '(no results)'}`;
    }).join('\n\n');
    recordContexts.push(context);
  }

  // Batch Claude calls (CLAUDE_BATCH_SIZE records per prompt)
  const batchSize = AI_RESEARCH.CLAUDE_BATCH_SIZE;
  const allResults: AIResearchResult[] = [];

  for (let i = 0; i < records.length; i += batchSize) {
    const batchRecords = records.slice(i, i + batchSize);
    const batchContexts = recordContexts.slice(i, i + batchSize);
    const batchResults = await extractWithClaude(batchRecords, batchContexts);
    allResults.push(...batchResults);
  }

  return allResults;
}

// Build 2-3 search queries for a property
function buildSearchQueries(
  address: string,
  city: string,
  state: string,
  zip: string,
  ownerName?: string
): string[] {
  const queries: string[] = [];
  const fullAddress = `${address} ${city} ${state} ${zip}`;

  // Query 1: Find property owner
  queries.push(`"${address}" ${city} ${state} property owner`);

  // Query 2: If owner name provided and looks like a business, find the individual
  if (ownerName) {
    const businessIndicators = ['llc', 'inc', 'corp', 'trust', 'ltd', 'lp', 'company', 'group', 'holdings', 'properties', 'investments', 'management', 'enterprises'];
    const isLikelyBusiness = businessIndicators.some((ind) =>
      ownerName.toLowerCase().includes(ind)
    );
    if (isLikelyBusiness) {
      queries.push(`"${ownerName}" owner principal member registered agent`);
    }
    // Query 3: Check deceased status
    queries.push(`"${ownerName}" ${city} ${state} obituary OR deceased`);
  } else {
    // Without owner name, try county records
    queries.push(`${fullAddress} county property records owner name`);
  }

  return queries;
}

// Call Claude to extract structured data from search results
async function extractWithClaude(
  records: ResearchInput[],
  contexts: string[]
): Promise<AIResearchResult[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }

  // Build the prompt
  const recordEntries = records.map((r, i) => {
    return `--- RECORD ${i + 1} ---
Address: ${r.address}, ${r.city}, ${r.state} ${r.zip}
Known Owner: ${r.owner_name || '(unknown)'}
Search Results:
${contexts[i]}`;
  }).join('\n\n');

  const systemPrompt = `You are a property research assistant. Given property addresses and web search results, extract structured information about property owners.

For each record, extract:
- owner_name: The individual owner's full name (if found)
- owner_type: "individual", "business", "trust", or "unknown"
- business_name: If owned by a business/LLC/trust, the entity name
- individual_behind_business: If owned by a business, the individual principal/member/registered agent
- is_deceased: true/false/null if deceased status was found in search results
- deceased_details: Brief note about deceased status if found
- relatives: Array of names of close relatives or family members found
- decision_makers: Array of names of people who may be decision makers for this property
- property_type: "residential", "commercial", "vacant_land", "multi_family", or "unknown"
- confidence: 0-100 score of how confident you are in the owner identification
- sources: Array of URLs that provided the key information

IMPORTANT RULES:
- Only extract information actually found in the search results. Never fabricate data.
- If information is not found, use null for strings, empty arrays for arrays, "unknown" for types.
- Set confidence to 0 if no owner information was found at all.
- For deceased checks, only mark is_deceased as true if there is clear evidence (obituary, death record).
- The individual_behind_business should be the person who controls the entity, not just any employee.

Respond with a JSON array of objects, one per record. Return ONLY the JSON array, no other text.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: AI_RESEARCH.CLAUDE_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Extract property owner information from these ${records.length} record(s):\n\n${recordEntries}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Claude API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  const content = data.content?.[0]?.text || '[]';

  // Parse the JSON response
  let parsed: AIResearchResult[];
  try {
    // Extract JSON from response (Claude may wrap in markdown code blocks)
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error('No JSON array found in Claude response');
    }
    parsed = JSON.parse(jsonMatch[0]);
  } catch (parseError) {
    console.error('Failed to parse Claude response:', content);
    // Return empty results for all records
    return records.map(() => emptyResult());
  }

  // Validate and normalize results
  return records.map((_, i) => {
    const result = parsed[i];
    if (!result) return emptyResult();
    return normalizeResult(result);
  });
}

function emptyResult(): AIResearchResult {
  return {
    owner_name: null,
    owner_type: 'unknown',
    business_name: null,
    individual_behind_business: null,
    is_deceased: null,
    deceased_details: null,
    relatives: [],
    decision_makers: [],
    property_type: 'unknown',
    confidence: 0,
    sources: [],
  };
}

function normalizeResult(raw: Partial<AIResearchResult>): AIResearchResult {
  return {
    owner_name: raw.owner_name || null,
    owner_type: (['individual', 'business', 'trust', 'unknown'].includes(raw.owner_type || '') ? raw.owner_type : 'unknown') as AIResearchResult['owner_type'],
    business_name: raw.business_name || null,
    individual_behind_business: raw.individual_behind_business || null,
    is_deceased: typeof raw.is_deceased === 'boolean' ? raw.is_deceased : null,
    deceased_details: raw.deceased_details || null,
    relatives: Array.isArray(raw.relatives) ? raw.relatives : [],
    decision_makers: Array.isArray(raw.decision_makers) ? raw.decision_makers : [],
    property_type: (['residential', 'commercial', 'vacant_land', 'multi_family', 'unknown'].includes(raw.property_type || '') ? raw.property_type : 'unknown') as AIResearchResult['property_type'],
    confidence: typeof raw.confidence === 'number' ? Math.min(100, Math.max(0, raw.confidence)) : 0,
    sources: Array.isArray(raw.sources) ? raw.sources : [],
  };
}
