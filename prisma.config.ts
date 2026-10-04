import "dotenv/config";
import { defineConfig } from "prisma/config";

/**
 * Configuration Prisma.
 * `dotenv/config` est importé explicitement : sans lui, l'URL de la base
 * définie dans `.env` n'est pas visible par la CLI Prisma 7.
 */
export default defineConfig({
  schema: "./prisma/schema.prisma",
  migrations: {
    path: "./prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "",
  },
});
