// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Basic two-number arithmetic helpers.
 */

export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

export function divide(a: number, b: number): number {
  if (b === 0) throw new Error("Division by zero");
  return a / b;
}

/** Returns true when n is a prime number (n >= 2). */
export function isPrime(n: number): boolean {
  if (!Number.isInteger(n) || n < 2) return false;
  if (n === 2) return true;
  if (n % 2 === 0) return false;
  const limit = Math.sqrt(n);
  for (let d = 3; d <= limit; d += 2) {
    if (n % d === 0) return false;
  }
  return true;
}

/** Returns all prime numbers from 2 through limit (inclusive). */
export function findPrimesUpTo(limit: number): number[] {
  if (!Number.isInteger(limit) || limit < 2) return [];
  const primes: number[] = [];
  for (let n = 2; n <= limit; n++) {
    if (isPrime(n)) primes.push(n);
  }
  return primes;
}

/** Returns true when n is an even integer. */
export function isEven(n: number): boolean {
  return Number.isInteger(n) && n % 2 === 0;
}

/** Returns all even numbers from 0 through limit (inclusive). */
export function findEvenNumbersUpTo(limit: number): number[] {
  if (!Number.isInteger(limit) || limit < 0) return [];
  const evens: number[] = [];
  for (let n = 0; n <= limit; n += 2) {
    evens.push(n);
  }
  return evens;
}
