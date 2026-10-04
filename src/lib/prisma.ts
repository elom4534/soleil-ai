import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * Client Prisma singleton, **instancié paresseusement**.
 *
 * Pourquoi paresseux ? Parce que de nombreux modules (moteur de prédiction,
 * fournisseurs de données, présentateur) importent indirectement ce fichier.
 * Créer le pool de connexions à l'import ferait échouer toute opération qui ne
 * touche pas la base — tests unitaires, script de calcul hors ligne, build.
 * Ici, la connexion n'est ouverte qu'au premier accès réel.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL manquant. Copiez .env.example vers .env et renseignez la chaîne de connexion.",
    );
  }
  // Le pool est dimensionné explicitement : les tâches de synchronisation
  // ouvrent peu de connexions longues, il est inutile d'en réserver davantage.
  const adapter = new PrismaPg({
    connectionString,
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
  });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

function getClient(): PrismaClient {
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = createClient();
  }
  return globalForPrisma.prisma;
}

/**
 * Proxy qui transfère tous les accès au client réel. `$disconnect` et
 * `$transaction` restent accessibles comme sur un client classique.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    const client = getClient();
    const value = Reflect.get(client, property, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
  has(_target, property) {
    return property in getClient();
  },
});

export default prisma;
