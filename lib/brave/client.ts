// Brave Search API Client

import { AI_RESEARCH } from '@/lib/constants';

interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
}

interface BraveWebSearchResponse {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
    }>;
  };
}

export async function searchBrave(query: string): Promise<BraveSearchResult[]> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    throw new Error('BRAVE_SEARCH_API_KEY is not configured');
  }

  const params = new URLSearchParams({
    q: query,
    count: '10',
    text_decorations: 'false',
  });

  const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Brave Search API error ${response.status}: ${text}`);
  }

  const data: BraveWebSearchResponse = await response.json();

  return (data.web?.results || []).map((r) => ({
    title: r.title || '',
    url: r.url || '',
    description: r.description || '',
  }));
}

export async function searchBraveBatch(queries: string[]): Promise<Map<string, BraveSearchResult[]>> {
  const results = new Map<string, BraveSearchResult[]>();
  const rateLimit = AI_RESEARCH.BRAVE_RATE_LIMIT_PER_SEC;

  // Process in batches respecting rate limit
  for (let i = 0; i < queries.length; i += rateLimit) {
    const batch = queries.slice(i, i + rateLimit);

    const batchResults = await Promise.all(
      batch.map(async (query) => {
        try {
          const searchResults = await searchBrave(query);
          return { query, results: searchResults };
        } catch (error) {
          console.error(`Brave search failed for query "${query}":`, error);
          return { query, results: [] };
        }
      })
    );

    for (const { query, results: searchResults } of batchResults) {
      results.set(query, searchResults);
    }

    // Wait 1 second between batches to respect rate limit
    if (i + rateLimit < queries.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  return results;
}
