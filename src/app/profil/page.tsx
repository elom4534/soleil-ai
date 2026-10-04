import Link from "next/link";
import { Card, CardBody, CardHeader, CardTitle, SectionHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { getPlatformStats } from "@/server/predictions/queries";
import { HISTORICAL_LEAGUES } from "@/lib/constants";

export const dynamic = "force-dynamic";
export const metadata = { title: "Profil" };

export default async function ProfilePage() {
  const stats = await getPlatformStats();

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Profil & paramètres"
        subtitle="Préférences d'affichage et état du compte."
      />

      <Card>
        <CardHeader>
          <CardTitle>Compte</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3 pb-4">
          <p className="text-[12.5px] leading-relaxed text-fg-muted">
            L&apos;authentification est préparée côté serveur (sessions, rôles, protection des
            routes d&apos;administration). La lecture des prédictions reste ouverte, conformément
            à la philosophie de transparence de SOLEIL.
          </p>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">Rôle : visiteur</Badge>
            <Badge variant="outline">Sessions serveur · NextAuth</Badge>
            <Badge variant="outline">Clés API jamais exposées au client</Badge>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Apparence</CardTitle>
          <p className="mt-1 text-[12px] text-fg-muted">
            Le choix est mémorisé sur votre appareil et appliqué avant le premier rendu, sans
            clignotement.
          </p>
        </CardHeader>
        <CardBody className="pb-4">
          <ThemeToggle />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Compétitions suivies</CardTitle>
          <p className="mt-1 text-[12px] text-fg-muted">
            {HISTORICAL_LEAGUES.length} compétitions configurées pour la collecte automatique.
          </p>
        </CardHeader>
        <CardBody className="pb-4">
          <div className="flex flex-wrap gap-1.5">
            {HISTORICAL_LEAGUES.map((l) => (
              <Badge key={l.code} variant="default">
                {l.name} · {l.country}
              </Badge>
            ))}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Données de la plateforme</CardTitle>
        </CardHeader>
        <CardBody className="grid grid-cols-2 gap-4 pb-4 sm:grid-cols-4">
          <Stat label="Compétitions" value={stats.leagues} />
          <Stat label="Équipes" value={stats.teams} />
          <Stat label="Rencontres" value={stats.matches} />
          <Stat label="Prédictions" value={stats.predictions} />
        </CardBody>
      </Card>

      <p className="text-center text-[11px] text-fg-subtle">
        <Link href="/admin" className="hover:underline">
          Accéder au tableau de bord administrateur
        </Link>
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-[11.5px] text-fg-subtle">{label}</p>
      <p className="mt-1 font-mono text-[19px] font-semibold tabular-nums text-fg">
        {value.toLocaleString("fr-FR")}
      </p>
    </div>
  );
}
