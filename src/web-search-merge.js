/**
 * Merge function for web search providers.
 *
 * Receives the settled child outcomes (each child provider's `WebSearchResult`
 * value, or `undefined` for a failed child) and returns one aggregated
 * `WebSearchResult`.
 */

/**
 * @param {Array<unknown|undefined>} outcomes
 * @param {import('@deepseek-ai/dsh-web').WebSearchRequest} request
 * @param {{ tolerateFailures: boolean }} options
 * @returns {import('@deepseek-ai/dsh-web').WebSearchResult}
 */
export default function merge(outcomes, request, options) {
  const defined = options.tolerateFailures
    ? outcomes.filter((o) => o !== undefined)
    : outcomes
  if (defined.length === 0) return { sources: [], truncated: false }
  if (defined.length === 1) return defined[0]

  // Merge sources: deduplicate by URL, then truncate to maxResults.
  const seen = new Set()
  const merged = []
  for (const result of defined) {
    if (result.content && !merged.__content) merged.__content = result.content
    for (const source of result.sources ?? []) {
      if (seen.has(source.url)) continue
      seen.add(source.url)
      merged.push(source)
    }
  }
  const capped = request.maxResults ? merged.slice(0, request.maxResults) : merged
  return {
    ...(merged.__content ? { content: merged.__content } : {}),
    sources: capped,
    truncated: merged.length > capped.length,
  }
}