/**
 * Whether a message carries a one-time code (docs/plan-m3.md, Data: "a mark for one-time codes"; K8: "One-time codes
 * are never said by themselves"): a code word near something shaped like a code, in German or English, as services word
 * them ("Dein WhatsApp-Code: 123-456", "G-482913 ist dein Google-Bestätigungscode", "Ihre mTAN lautet 482913", "Your
 * verification code is 482913").
 *
 * - **Code words:** "Code" and its compounds ("Bestätigungscode", "Login-Code"), TAN ("mTAN", "pushTAN"), PIN, OTP,
 *   2FA, "Passcode", "Passwort", "Kennwort", "password". Not a QR code, a voucher, a postcode or an error code.
 * - **Codes:** four to eight digits, also in two groups ("123 456", "123-456"), never part of a longer number, a date, a
 *   time or a price; or capitals and digits ("X7KQ9P", at least two digits).
 * - **Near:** within 80 characters, as a code is in its sentence.
 *
 * A heuristic: a door code from a friend counts too, and is as private.
 */

const WORD = /(?<![\p{L}\p{N}])(?:[\p{L}-]*codes?|(?:m|sms|push|chip|photo|app|i|e)?-?tans?|pins?|otp|2fa|passcodes?|passwords?|[\p{L}-]*passw(?:ort|örter)|[\p{L}-]*kennw(?:ort|örter))(?![\p{L}\p{N}])/giu;
/** Compounds that name no one-time code: "QR-Code", "Gutscheincode", "Fehlercode", "Postleitzahl" is none anyway. */
const NOT_A_CODE_WORD = /^(?:qr|bar|strich|gutschein|rabatt|promo|aktions|fehler|quell|programm|farb|länder|status|html|zip|area|post|dress|source|error|country|discount|coupon|voucher)/;
/** The same as separate words before "code": "zip code", "error code", "QR Code". */
const NOT_A_CODE_BEFORE = /(?:^|[^\p{L}])(?:qr|bar|zip|area|error|source|promo|discount|coupon|voucher|dress|status|country)[ -]?$/iu;
/** Four to eight digits, alone or in two groups, never part of a longer number, a date, a time or a price. */
const DIGITS = /(?<![\p{L}\p{N}.,:/+#€$]|\d[ -])(?:\d{4,8}|\d{2,4}[ -]\d{2,4})(?![\p{L}\p{N}%€$]|[.,:/]\d|[ -]\d)/gu;
/** Capitals and digits: at least two digits and one capital. */
const MIXED = /(?<![\p{L}\p{N}])[A-Z0-9]{5,10}(?![\p{L}\p{N}])/gu;
const NEAR = 80;

export function oneTimeCode(text: string): boolean {
  if (!/\d/.test(text)) return false;
  const words: [number, number][] = [];
  for (const w of text.matchAll(WORD)) {
    const word = w[0].toLowerCase().replace(/-/g, '');
    if (NOT_A_CODE_WORD.test(word) || (/^codes?$/.test(word) && NOT_A_CODE_BEFORE.test(text.slice(Math.max(0, w.index - 12), w.index)))) continue;
    words.push([w.index, w.index + w[0].length]);
  }
  if (!words.length) return false;
  const codes: [number, number][] = [];
  for (const c of text.matchAll(DIGITS)) codes.push([c.index, c.index + c[0].length]);
  for (const c of text.matchAll(MIXED)) if ((c[0].match(/\d/g)?.length ?? 0) >= 2 && /[A-Z]/.test(c[0])) codes.push([c.index, c.index + c[0].length]);
  return codes.some(([cs, ce]) => words.some(([ws, we]) => (cs >= we ? cs - we : ws >= ce ? ws - ce : 0) <= NEAR));
}
