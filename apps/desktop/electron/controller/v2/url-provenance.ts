/** Full URLs are data, not something the navigator may construct from its world knowledge. */
export function suppliedUrls(text: string): string[] {
  return text.match(/https?:\/\/[^\s<>"'`]+/gu)?.map(url => url.replace(/[),.;!?]+$/u, '')) ?? [];
}

export function urlIsObservedOrSupplied(url: string, userText: string[], observed: Set<string>): boolean {
  // Do not decode, add a scheme, shorten the path, or match substrings of a different address.
  return observed.has(url) || userText.some(text => suppliedUrls(text).includes(url));
}

/** Keep invented addresses out of instructions and completion criteria too. Otherwise an
 * OPEN_URL check is easily bypassed by telling the navigator to type the same invented URL. */
export function ungroundedAddresses(text: string, sources: string[]): string[] {
  const addresses = (value: string) => value.match(/https?:\/\/[^\s<>"'`]+|(?<![\w@/.-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?\/[^\s<>"'`]*/giu)
    ?.map(address => address.replace(/[),.;!?]+$/u, '')) ?? [];
  const known = new Set(sources.flatMap(addresses));
  return [...new Set(addresses(text))].filter(address => !known.has(address));
}
