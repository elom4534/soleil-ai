/** Registre des fournisseurs — §29 « architecture multi-source ». */

import { footballDataCoUkProvider } from "./footballDataCoUk";
import { theSportsDbProvider } from "./theSportsDb";
import { footballDataOrgProvider } from "./footballDataOrg";
import type { DataProvider } from "./types";

/** Tous les fournisseurs connus, triés par priorité. */
export const PROVIDERS: DataProvider[] = [
  footballDataCoUkProvider,
  theSportsDbProvider,
  footballDataOrgProvider,
].sort((a, b) => a.priority - b.priority);

export function getProvider(name: string): DataProvider | undefined {
  return PROVIDERS.find((p) => p.name === name);
}

/** Fournisseurs réellement utilisables (clé présente, service actif). */
export function configuredProviders(): DataProvider[] {
  return PROVIDERS.filter((p) => p.isConfigured());
}

export * from "./types";
