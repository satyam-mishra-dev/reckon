import { clsx, type ClassValue } from 'clsx';

/** Conditional class join. No tailwind-merge — variants are authored to not collide. */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
