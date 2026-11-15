/** Shorten text without cutting a surrogate pair in half: a lone half is not valid UTF-8 on the wire. */
export function clip(text: string, length: number): string {
  if (text.length <= length) return text;
  return text.slice(0, length - 1).replace(/[\uD800-\uDBFF]$/, '') + '…';
}
