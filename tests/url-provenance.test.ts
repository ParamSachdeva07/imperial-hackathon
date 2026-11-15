import { expect, it } from 'vitest';
import { suppliedUrls, urlIsObservedOrSupplied, ungroundedAddresses } from '../apps/desktop/electron/controller/v2/url-provenance';

it('requires exact provenance for origins, paths and query strings', () => {
  const user = ['Open https://example.test/a?q=hello&sort=recent.'];
  expect(urlIsObservedOrSupplied('https://example.test/a?q=hello&sort=recent', user, new Set())).toBe(true);
  for (const url of ['https://example.test/', 'https://example.test/a?q=hello', 'https://example.test/a?q=other', 'https://example.test.evil/'])
    expect(urlIsObservedOrSupplied(url, user, new Set())).toBe(false);
  expect(urlIsObservedOrSupplied('https://example.test/', ['Go to example.test'], new Set())).toBe(false);
  expect(urlIsObservedOrSupplied('https://example.test/private', [], new Set(['https://example.test/private']))).toBe(true);
  expect(suppliedUrls('Use "https://example.test/a" then https://other.test/b.')).toEqual(['https://example.test/a', 'https://other.test/b']);
});


it('grounds addresses in plans and typing without treating ordinary filenames as URLs', () => {
  expect(ungroundedAddresses('Visit https://invented.test/path or invented.test/path', [])).toEqual([
    'https://invented.test/path', 'invented.test/path']);
  expect(ungroundedAddresses('Read https://known.test/a?q=x.', ['Page address: https://known.test/a?q=x'])).toEqual([]);
  expect(ungroundedAddresses('Save notes.txt or draft.v1.docx and email person@example.test', [])).toEqual([]);
  expect(ungroundedAddresses('https://known.test/a', ['https://known.test/ab'])).toEqual(['https://known.test/a']);
});
