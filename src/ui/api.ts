import { isMessage, type Locale, type Message } from '../i18n/messages';
import type { Profile } from '../worker/db';

export type Session = { user: Profile | null };

export async function request<T>(path: string, method = 'GET', body?: unknown, locale?: Locale, allowValidation = false): Promise<T> {
  const response = await fetch('/api' + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(locale ? { 'X-EKN-Language': locale } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok && !(allowValidation && response.status === 422 && data.errors)) throw new Error(data.code);
  return data as T;
}

export function message(error: unknown): Message {
  return error instanceof Error && isMessage(error.message) ? error.message : 'failure';
}
