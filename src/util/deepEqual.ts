/**
 * Structural deep equality for JSON-shaped data (the parsed form of daemon
 * responses): primitives, plain objects, and arrays.
 *
 * Keys whose value is `undefined` are ignored, matching what a JSON
 * round-trip would drop. Non-plain objects (Set, Map, Date, …) are compared
 * by their own enumerable properties only, so two Dates always compare
 * equal — don't use this on values that carry state outside enumerable
 * properties.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) {
    return false;
  }
  if (aIsArray) {
    const arrA = a as unknown[];
    const arrB = b as unknown[];
    if (arrA.length !== arrB.length) {
      return false;
    }
    return arrA.every((item, i) => deepEqual(item, arrB[i]));
  }
  const recA = a as Record<string, unknown>;
  const recB = b as Record<string, unknown>;
  const keysA = definedKeys(recA);
  const keysB = definedKeys(recB);
  if (keysA.length !== keysB.length) {
    return false;
  }
  return keysA.every(
    (key) => Object.prototype.hasOwnProperty.call(recB, key) && deepEqual(recA[key], recB[key]),
  );
}

function definedKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record).filter((key) => record[key] !== undefined);
}
