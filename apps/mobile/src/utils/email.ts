/** Does this look like an address a code could be sent to? Deliberately
 *  loose — one `@`, something either side, a dot in the domain — because the
 *  SERVER decides whether the address is registered (and never says so). This
 *  only stops a typo such as "name@" going out as a request and landing the
 *  member on the code screen, waiting for mail that cannot be sent
 *  (PrimeTestLab report 7107, M-01). The callable applies the same shape. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function looksLikeEmail(value: string): boolean {
  return EMAIL_SHAPE.test(value.trim());
}
