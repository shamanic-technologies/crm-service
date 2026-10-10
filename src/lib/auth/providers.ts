/**
 * The registered auth providers. Adding Supabase Auth / Auth0 / Firebase Auth is
 * one adapter file + one line here: the routes, sync, people source and fact
 * feed iterate this registry.
 */

import { clerk } from "./clerk.js";
import type { AuthProviderAdapter } from "./provider.js";

export const AUTH_PROVIDERS = { clerk } as const satisfies Record<string, AuthProviderAdapter>;
export type AuthProviderName = keyof typeof AUTH_PROVIDERS;
export const AUTH_PROVIDER_NAMES = Object.keys(AUTH_PROVIDERS) as AuthProviderName[];

export const isAuthProvider = (name: string): name is AuthProviderName => name in AUTH_PROVIDERS;
