import { describe, expect, it } from 'vitest';
import { inventedAddresses } from '../apps/desktop/electron/controller/url-provenance';

describe('which addresses a model may use', () => {
  it('lets a site be opened by its front page, with or without www, a port or a trailing slash', () => {
    for (const address of ['https://www.youtube.com', 'https://twitch.tv/', 'http://127.0.0.1:55983/'])
      expect(inventedAddresses(address, [])).toEqual([]);
  });
  it('refuses a path, a query or a fragment that nobody supplied or observed', () => {
    expect(inventedAddresses('https://www.gov.uk/check-uk-visa', ['Go to the UKVI website'])).toEqual(['https://www.gov.uk/check-uk-visa']);
    expect(inventedAddresses('https://www.youtube.com?search_query=cats', [])).toHaveLength(1);
    expect(inventedAddresses('open example.com/account/settings now', [])).toEqual(['example.com/account/settings']);
  });
  it('accepts an inner address the user gave or a page showed, however it was written', () => {
    expect(inventedAddresses('https://example.com/a/b', ['Open https://example.com/a/b.'])).toEqual([]);
    expect(inventedAddresses('https://example.com/a/b/', ['see example.com/a/b'])).toEqual([]);
    expect(inventedAddresses('https://example.com/a/c', ['Open https://example.com/a/b'])).toHaveLength(1);
  });
});
