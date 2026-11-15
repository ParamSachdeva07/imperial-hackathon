const ADDRESS = /https?:\/\/[^\s<>"'`]+|(?<![\w@/.-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?\/[^\s<>"'`]*/giu;
const addresses = (text: string) => (text.match(ADDRESS) ?? []).map(address => address.replace(/[),.;!?]+$/u, ''));
const bare = (address: string) => address.replace(/^https?:\/\//i, '').replace(/\/+$/u, '').toLowerCase();

/**
 * Addresses in `text` that point inside a site and that nobody supplied or observed. A model may
 * name a site's front door from what it knows. A path, query or identifier is data: it has to
 * come from the user or from a page that was actually read.
 */
export function inventedAddresses(text: string, sources: Iterable<string>): string[] {
  const known = new Set([...sources].flatMap(addresses).map(bare));
  return [...new Set(addresses(text))].filter(address => /[/?#]/.test(bare(address)) && !known.has(bare(address)));
}
