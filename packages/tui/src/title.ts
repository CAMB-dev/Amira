/** Display-only inline Markdown removal; identifiers and unpaired punctuation stay intact. */
export function displayTitle(title: string): string {
  return title
    .replace(/`/g, "")
    .replace(/\*\*(?=\S)(.*?\S)\*\*/g, "$1")
    .replace(/\*(?!\*)(?=\S)(.*?\S)\*(?!\*)/g, "$1")
    .replace(/(?<![\p{L}\p{N}_])__(?=\S)(.*?\S)__(?![\p{L}\p{N}_])/gu, "$1")
    .replace(/(?<![\p{L}\p{N}_])_(?!_)(?=\S)(.*?\S)_(?![\p{L}\p{N}_])/gu, "$1")
}
