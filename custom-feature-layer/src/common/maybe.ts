interface NeverBase {
  [index: number]: Never;
  [index: string]: Never;
}

interface NeverIndexableBase {
  [index: number]: Never;
}

type Never = NeverBase & { __strictNever: "never" };
type NeverIndexable = NeverIndexableBase & { __strictNever: "never" };

/**
 * Maybe adds type safety for nullable values and can be easily
 * replaced with --strictNullChecks in the future. Currently that
 * option can not be enabled progressively:
 *
 *   https://github.com/Microsoft/TypeScript/issues/8405
 *
 * Once strict null checks are enabled, isSome and isNone can be inlined
 * and unwrap / expect can be replaced with the non-null assertion operator (!).
 */
export type Maybe<T> = T | None;

// creating a union with Never, rather than just aliasing it, means
// that 'None' is shown in compiler messages.
export type None = (NeverIndexable & { __strictNone: "none" }) | null | undefined;

export const none: None = null;

/** True if x holds a value. */
export function isSome<T>(x: Maybe<T>): x is T {
  return x != null;
}

/** True if x doesn't hold a value. */
export function isNone<T>(x: Maybe<T>): x is None {
  return x == null;
}

/** True if x is undefined. */
export function isUndefined<T>(x: Maybe<T>): x is None {
  return x === undefined;
}

/** Maps Maybe(value) to Maybe(op(value)). If value is None, op is not executed and None is returned. */
export function applySome<T, R>(maybeValue: Maybe<T>, op: (someValue: T) => R): Maybe<R> {
  if (isSome(maybeValue)) {
    return op(maybeValue);
  }

  return null;
}

/** Helper function to unwrap a Maybe into its value or a raw null/undefined value. */
export function unwrap<T>(x: Maybe<T>): T | null | undefined {
  return x as any;
}

type Closure<T> = () => T;

/** @return value if defined, otherwise def */
export function unwrapOr<T>(value: Maybe<T>, def: T | Closure<T>): T {
  if (isSome(value)) {
    return value;
  }

  if (typeof def === "function") {
    return (def as Closure<T>)();
  }

  return def;
}

/** call destroy on the given maybe, if it is set. */
export function destroyMaybe<T extends { destroy: () => void }>(object: Maybe<T>): null {
  if (isSome(object)) {
    object.destroy();
  }
  return null;
}

/** call dispose on the given maybe, if it is set. */
export function disposeMaybe<T extends { dispose: () => void }>(object: Maybe<T>): null {
  if (isSome(object)) {
    object.dispose();
  }
  return null;
}

/** call remove on the given maybe, if it is set. */
export function removeMaybe<T extends { remove: () => void }>(object: Maybe<T>): null {
  if (isSome(object)) {
    object.remove();
  }
  return null;
}

export function nullifyNonnullableForDispose<T>(_object: T): T {
  return (null as any) as T;
}

/** Combines mapping the values of an array to a Maybe<T> with filtering out the values mapped to None. */
export function mapSome<T, Q>(input: Array<T>, mapCb: (entry: T) => Maybe<Q>): Array<Q> {
  const result = new Array<Q>();
  input.forEach((v) => {
    const mappedV = mapCb(v);
    if (isSome(mappedV)) {
      result.push(mappedV);
    }
  });
  return result;
}

/** Map a function over input if isSome holds */
export function mapMany<T, Q>(input: Array<Maybe<T>>, func: (some: T) => Q): Array<Maybe<Q>> {
  const result = new Array<Maybe<Q>>();

  for (const value of input) {
    result.push(mapOr(value, null, func));
  }

  return result;
}

/** forEach a function over input if isSome holds */
export function forEachSome<T>(input: Array<Maybe<T>>, func: (some: T) => any): void {
  for (const value of input) {
    mapOr(value, null, func);
  }
}

export function mapOr<T, Q>(value: Maybe<T>, def: Q, func: (some: T) => Q): Q {
  if (isSome(value)) {
    return func(value);
  }

  return def;
}

export function andThen<T, Q>(input: Maybe<T>, func: (some: T) => Q): Maybe<Q> {
  if (isSome(input)) {
    return func(input);
  }

  return null;
}

/** Combines mapping the values of an array to a Maybe<T> with returning the first entry mapped to Some. */
export function mapSomeFirst<T, Q>(input: Array<T>, mapCb: (entry: T) => Maybe<Q>): Maybe<Q> {
  for (const v of input) {
    const mappedV = mapCb(v);
    if (isSome(mappedV)) {
      return mappedV;
    }
  }
  return null;
}

export type AsSome<T> = T extends Maybe<infer U> ? Exclude<Maybe<U>, None> : T;

export function get<T, K0 extends keyof T>(value: Maybe<T>, key0: K0): Maybe<T[K0]>;

export function get<T, K0 extends keyof T, K1 extends keyof AsSome<T[K0]>>(
  value: Maybe<T>,
  key0: K0,
  key1: K1
): Maybe<AsSome<AsSome<T[K0]>[K1]>>;

export function get<T, K0 extends keyof T, K1 extends keyof AsSome<T[K0]>, K2 extends keyof AsSome<AsSome<T[K0]>[K1]>>(
  value: Maybe<T>,
  key0: K0,
  key1: K1,
  key2: K2
): Maybe<AsSome<AsSome<AsSome<T[K0]>[K1]>[K2]>>;

export function get<
  T,
  K0 extends keyof T,
  K1 extends keyof AsSome<T[K0]>,
  K2 extends keyof AsSome<AsSome<T[K0]>[K1]>,
  K3 extends keyof AsSome<AsSome<AsSome<T[K0]>[K1]>[K2]>
>(value: Maybe<T>, key0: K0, key1: K1, key2: K2, key3: K3): Maybe<AsSome<AsSome<AsSome<AsSome<T[K0]>[K1]>[K2]>[K3]>>;

/**
 * Allows to access nested properties given a sequence of property names.
 * Checks for None at each step and stops, returning None, if necessary.
 *
 * @param value The initial object to start with.
 * @param keys A sequence of property names to access.
 */
export function get<T>(value: Maybe<T>, ...keys: string[]): any {
  let result: any = value;
  let i = 0;

  while (i < keys.length && result) {
    result = result[keys[i++]];
  }

  return result;
}

/*
 * Mark fields as null in a dispose/destroy method for GC/error catching of usage-after-destroy
 * Once our code is strictNull compatible, we should catch here all errors of non-null
 */

export function assumeNonNull<T>(v: T | null | undefined): T {
  return v!;
}
