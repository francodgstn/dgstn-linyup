import { looksLikeEmail } from './email';

describe('looksLikeEmail', () => {
  it('accepts an ordinary address, trimmed', () => {
    expect(looksLikeEmail('you@example.com')).toBe(true);
    expect(looksLikeEmail('  first.last+tag@sub.example.ch ')).toBe(true);
    expect(looksLikeEmail('app.review@example.com')).toBe(true);
  });

  it('rejects the shapes a typo produces', () => {
    for (const value of ['', 'name', 'name@', '@example.com', 'name@example', 'name@example.c', 'name @example.com', 'name@@example.com']) {
      expect(looksLikeEmail(value)).toBe(false);
    }
  });
});
