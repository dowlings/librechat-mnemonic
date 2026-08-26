/**
 * Strip newlines and collapse whitespace in note titles.
 *
 * mnemonic's frontmatter serializer (gray-matter → yaml) emits a YAML block
 * scalar (`title: >-\n  Some title`) when the title string contains a trailing
 * newline or embedded whitespace. Naive frontmatter parsers then read the
 * title as the literal string `>-`. Sanitising before the title reaches
 * mnemonic prevents this.
 */
export function sanitizeTitle(title: string): string {
  return title.replace(/\r?\n+/g, ' ').replace(/\s+/g, ' ').trim();
}