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

// Single property research (two-pass: initial search + follow-up entity resolution)
export async function researchProperty(
  address: string,
  city: string,
  state: string,
  zip: string,
  ownerName?: string
): Promise<AIResearchResult> {
  // Pass 1: Build and run initial search queries
  const queries = buildSearchQueries(address, city, state, zip, ownerName);

  const searchResults = await Promise.all(
    queries.map((q) => searchBrave(q))
  );

  const combinedContext = queries.map((query, i) => {
    const results = searchResults[i];
    const snippets = results
      .map((r) => `- ${r.title}: ${r.description} (${r.url})`)
      .join('\n');
    return `Query: "${query}"\nResults:\n${snippets || '(no results)'}`;
  }).join('\n\n');

  // First Claude extraction
  const pass1Result = await extractWithClaude(
    [{ address, city, state, zip, owner_name: ownerName }],
    [combinedContext]
  ).then((results) => results[0]);

  // Pass 2: Follow-up queries if needed
  const followUpQueries = buildFollowUpQueries(pass1Result, city, state, ownerName);

  if (followUpQueries.length === 0) {
    return pass1Result;
  }

  const followUpResults = await Promise.all(
    followUpQueries.map((q) => searchBrave(q))
  );

  const followUpContext = followUpQueries.map((query, i) => {
    const results = followUpResults[i];
    const snippets = results
      .map((r) => `- ${r.title}: ${r.description} (${r.url})`)
      .join('\n');
    return `Query: "${query}"\nResults:\n${snippets || '(no results)'}`;
  }).join('\n\n');

  // Second Claude extraction with combined Pass 1 + Pass 2 context
  const fullContext = `=== INITIAL SEARCH RESULTS ===\n${combinedContext}\n\n=== FOLLOW-UP SEARCH RESULTS ===\n${followUpContext}`;

  const pass2Result = await extractWithClaude(
    [{ address, city, state, zip, owner_name: ownerName }],
    [fullContext]
  ).then((results) => results[0]);

  return pass2Result;
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

// Build 5-6 targeted search queries for a property
function buildSearchQueries(
  address: string,
  city: string,
  state: string,
  zip: string,
  ownerName?: string
): string[] {
  const queries: string[] = [];

  // Query 1: Target county/government property records
  queries.push(
    `"${address}" "${city}" property owner site:county OR site:gov OR "tax records" OR "assessor"`
  );

  // Query 2: Deed/title records
  queries.push(
    `"${address}" "${city}" "${state}" owner deed OR title OR "property records"`
  );

  // Query 3: General owner search
  queries.push(
    `"${address}" "${city}" "${state}" property owner name`
  );

  if (ownerName) {
    // Query 4: Deceased check
    queries.push(
      `"${ownerName}" "${city}" "${state}" obituary OR deceased OR death`
    );

    // Query 5: Family/relatives
    queries.push(
      `"${ownerName}" "${city}" "${state}" family OR wife OR husband OR son OR daughter`
    );

    // Query 6: If business, find the individual behind it
    const businessIndicators = ['llc', 'inc', 'corp', 'trust', 'ltd', 'lp', 'company', 'group', 'holdings', 'properties', 'investments', 'management', 'enterprises'];
    const isLikelyBusiness = businessIndicators.some((ind) =>
      ownerName.toLowerCase().includes(ind)
    );
    if (isLikelyBusiness) {
      queries.push(
        `"${ownerName}" registered agent OR principal OR member OR manager site:sos OR "secretary of state"`
      );
    }
  } else {
    // Without owner name, add more property-record-focused queries
    // Query 4: County assessor parcel lookup
    queries.push(
      `"${address}" "${city}" county assessor parcel owner`
    );

    // Query 5: Tax records
    queries.push(
      `"${address}" "${city}" "${state}" tax records property owner`
    );
  }

  return queries;
}

// Build follow-up queries for second-pass entity resolution
function buildFollowUpQueries(
  pass1Result: AIResearchResult,
  city: string,
  state: string,
  ownerNameProvided?: string
): string[] {
  const queries: string[] = [];

  // If entity found (business/trust) but no individual behind it, resolve the entity
  const isEntity = pass1Result.owner_type === 'business' || pass1Result.owner_type === 'trust';
  const entityName = pass1Result.business_name;
  const hasIndividual = !!pass1Result.individual_behind_business;

  if (isEntity && entityName && !hasIndividual) {
    queries.push(
      `"${entityName}" registered agent OR principal OR member OR manager`
    );
    queries.push(
      `"${entityName}" "${state}" secretary of state OR annual report OR articles of organization`
    );
    queries.push(
      `"${entityName}" owner OR founder OR president`
    );
  }

  // If Pass 1 discovered an owner name that wasn't known upfront, run deceased + family queries
  const discoveredOwner = pass1Result.owner_name;
  if (discoveredOwner && !ownerNameProvided) {
    queries.push(
      `"${discoveredOwner}" "${city}" "${state}" obituary OR deceased`
    );
    queries.push(
      `"${discoveredOwner}" "${city}" "${state}" family OR relatives`
    );
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

  const systemPrompt = `You are a property ownership research assistant. Given property addresses and web search results, extract structured information about the TRUE LEGAL OWNERS of properties.

For each record, extract:
- owner_name: The individual owner's full name, or the entity name if owned by a business/trust (if found)
- owner_type: "individual", "business", "trust", or "unknown"
- business_name: If owned by a business/LLC/trust, the entity name
- individual_behind_business: If owned by a business, the individual principal/member/registered agent/managing member
- is_deceased: true/false/null if deceased status was found in search results
- deceased_details: Brief note about deceased status if found
- relatives: Array of names of close relatives or family members found
- decision_makers: Array of names of people who may be decision makers for this property
- property_type: "residential", "commercial", "vacant_land", "multi_family", or "unknown"
- confidence: 0-100 score of how confident you are in the owner identification
- confidence_reasoning: Brief explanation of why you assigned this confidence score
- sources: Array of URLs that provided the key information

CRITICAL RULES FOR OWNER IDENTIFICATION:
- The OWNER is the person or entity that holds legal title to the property, NOT the property manager, broker, real estate agent, or listing company.
- Property management companies (e.g. "XYZ Property Management") are NOT owners unless they also hold title.
- Real estate brokers, agents, and listing sites are NOT owners.
- County assessor records, tax records, deed records, and Secretary of State filings are the most reliable sources for ownership.
- If search results show both a property management company AND a county/tax record owner, prefer the county/tax record.
- Look for patterns like "Owner: ...", "Assessed to: ...", "Grantor/Grantee: ...", "Parcel owner: ..." in county records.

CONFIDENCE SCORING GUIDELINES:
- 80-100: Owner found in county assessor, tax records, or deed records
- 60-79: Owner found in multiple consistent non-government sources
- 40-59: Owner found in a single non-government source or with some ambiguity
- 20-39: Possible owner but conflicting information or weak source
- 0-19: No owner information found or only property management/listing data

OTHER RULES:
- Only extract information actually found in the search results. Never fabricate data.
- If information is not found, use null for strings, empty arrays for arrays, "unknown" for types.
- Set confidence to 0 if no owner information was found at all.
- For deceased checks, only mark is_deceased as true if there is clear evidence (obituary, death record).
- The individual_behind_business should be the person who controls the entity (principal, registered agent, managing member), not just any employee.

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
    confidence_reasoning: null,
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
    confidence_reasoning: raw.confidence_reasoning || null,
    sources: Array.isArray(raw.sources) ? raw.sources : [],
  };
}
