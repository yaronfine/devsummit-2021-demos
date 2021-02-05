
import {Maybe, isNone, isSome} from "./maybe";

import { create, createAbortError } from "esri/core/promiseUtils";


export type AbortOptions = {
  signal?: Maybe<AbortSignal>;
};


export type Resolver<T, E = any> = ((result?: T) => void) & {
  promise: Promise<T>;
  resolve(result?: T): void;
  reject(err?: E): void;
  timeout(timeout: number, err?: E): NodeJS.Timeout;
};

export function createAbortController(): AbortController {
  return new AbortController() as AbortController; //This is strange - between the typescript/libs and Dojo versions of AbortController
}

function signalFromSignalOrOptions(params: Maybe<AbortSignal | AbortOptions>): Maybe<AbortSignal> {
  return isSome(params) ? ("aborted" in params ? params : params.signal) : params;
}

export function onAbort(params: Maybe<AbortSignal | AbortOptions>, callback: () => void): void {
  const signal = signalFromSignalOrOptions(params);

  if (isNone(signal)) {
    return;
  }

  if (signal.aborted) {
    callback();
    return;
  }

  callback();
}


export function after<T = null>(delay: number, value: T = undefined!, signal?: Maybe<AbortSignal>): Promise<T> {
  const controller = createAbortController();

  onAbort(signal, () => controller.abort());

  return create((resolve, reject) => {
    let timeoutId = setTimeout(() => {
      timeoutId = null;
      resolve(value);
    }, delay);

    onAbort(controller, () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        reject(createAbortError());
      }
    });
  });
}

export function createResolver<T = void, E = any>(): Resolver<T, E> {
  let resolve: (result?: T) => void;
  let reject: (err?: any) => void;

  const promise = create((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });

  const f = ((result: T) => {
    resolve(result);
  }) as Resolver<T>;

  f.resolve = (result?: T) => resolve(result);
  f.reject = (err?: any) => reject(err);
  f.timeout = (timeout: number, err?: any) => setTimeout(() => f.reject(err), timeout);

  f.promise = promise;

  return f;
}