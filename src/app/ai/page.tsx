import { Sparkles, ShieldCheck, Database, GitBranch } from "lucide-react";
import { Card, CardBody, CardHeader, CardTitle, SectionHeader } from "@/components/ui/Card";
import { SoleilChat } from "@/components/ai/SoleilChat";

/** Principe de conception affiché à l'utilisateur, avec son icône. */
function Principle({
  icon: Icon,
  title,
  detail,
}: {
  icon: typeof Sparkles;
  title: string;
  detail: string;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-soleil-500/12 text-soleil-600 dark:text-soleil-400">
          <Icon className="size-4" strokeWidth={2.1} />
        </span>
        <h3 className="text-[13px] font-semibold text-fg">{title}</h3>
      </div>
      <p className="mt-2.5 text-[12px] leading-relaxed text-fg-muted">{detail}</p>
    </Card>
  );
}

export const metadata = { title: "Soleil AI" };

export default function AIPage() {
  return (
    <div className="space-y-5">
      <SectionHeader
        title="Soleil AI"
        subtitle="Un agent d'explication rattaché aux données du moteur, jamais à des suppositions."
      />

      <Card>
        <CardHeader className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-lg bg-soleil-500/12 text-soleil-600 dark:text-soleil-400">
            <Sparkles className="size-4" strokeWidth={2.1} />
          </span>
          <div>
            <CardTitle>Poser une question</CardTitle>
            <p className="text-[11.5px] text-fg-subtle">
              Citez une équipe pour cibler une rencontre précise
            </p>
          </div>
        </CardHeader>
        <CardBody className="pb-4">
          <SoleilChat />
        </CardBody>
      </Card>

      <div className="grid gap-3 sm:grid-cols-3">
        <Principle
          icon={ShieldCheck}
          title="Aucune donnée inventée"
          detail="Une information absente produit la réponse « Donnée indisponible » plutôt qu'une estimation."
        />
        <Principle
          icon={Database}
          title="Réponses traçables"
          detail="Chaque réponse affiche les valeurs utilisées et le champ de la base dont elles proviennent."
        />
        <Principle
          icon={GitBranch}
          title="Architecture extensible"
          detail="La couche de génération est isolée : un fournisseur de modèle de langage peut être branché sur les mêmes fonctions d'accès aux données, sans modifier l'interface."
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Portée actuelle de l&apos;agent</CardTitle>
        </CardHeader>
        <CardBody className="pb-4">
          <ul className="space-y-2 text-[12.5px] leading-relaxed text-fg-muted">
            <li>
              <span className="font-medium text-fg">Implémenté :</span> réponses fondées sur les
              prédictions stockées — facteurs de la prédiction principale, marchés Over/Under,
              score exact, mi-temps, BTTS, décomposition du score de confiance, qualité des données,
              méthode du moteur.
            </li>
            <li>
              <span className="font-medium text-fg">Non implémenté dans cette version :</span>{" "}
              génération de texte par un modèle de langage, mémoire conversationnelle persistante,
              et recherche en langage naturel sur l&apos;ensemble de l&apos;historique. SOLEIL
              déclare ces limites plutôt que de les masquer derrière une réponse plausible.
            </li>
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}
