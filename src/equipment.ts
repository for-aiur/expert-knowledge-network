// Compare independently of the UI locale and retain the original display value.
export function equipmentKey(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}
