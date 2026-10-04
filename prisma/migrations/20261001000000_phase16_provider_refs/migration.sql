-- Phase 16 — §17 : conservation des identifiants fournisseur.
-- L'identité d'une équipe ou d'une compétition repose sur l'identifiant publié
-- par la source ; cet identifiant doit donc être conservé tel quel, sans
-- remplacer la clé interne (slug / code) qui relie l'historique.
ALTER TABLE "Team"   ADD COLUMN IF NOT EXISTS "providerRefs" JSONB;
ALTER TABLE "League" ADD COLUMN IF NOT EXISTS "providerRefs" JSONB;
