import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { computePerformance } from "../src/server/predictions/service";

async function main() {
  const perf = await computePerformance();
  if (!perf) { console.log("Aucune donnée réglée."); return; }
  console.log(`Échantillon : ${perf.sample} prédictions réglées`);
  console.log(`Exactitude 1X2 : ${(perf.accuracy * 100).toFixed(2)} %`);
  console.log(`Brier Score    : ${perf.brierScore.toFixed(4)}  (référence aléatoire : 0.6667)`);
  console.log(`Log Loss       : ${perf.logLoss.toFixed(4)}  (référence aléatoire : 1.0986)`);
  console.log("\nCalibration :");
  for (const c of perf.calibration) {
    console.log(`  ${c.bin.padEnd(10)} prédit ${(c.predicted*100).toFixed(1)}%  observé ${(c.observed*100).toFixed(1)}%  n=${c.count}`);
  }
  console.log("\nPar bande de confiance :");
  for (const b of perf.byConfidence) console.log(`  ${b.band.padEnd(24)} n=${String(b.sample).padStart(3)}  exactitude ${(b.accuracy*100).toFixed(1)}%`);
  console.log("\nPar marché :");
  for (const m of perf.byMarket) console.log(`  ${m.market.padEnd(28)} n=${String(m.sample).padStart(3)}  ${(m.accuracy*100).toFixed(1)}%`);
  console.log("\nPar modèle (sur les mêmes matchs) :");
  for (const m of perf.byModel) console.log(`  ${m.label.padEnd(22)} n=${String(m.sample).padStart(3)}  exactitude ${(m.accuracy*100).toFixed(1)}%  Brier ${m.brierScore?.toFixed(4) ?? "—"}`);
  console.log("\nPar compétition :");
  for (const l of perf.byLeague) console.log(`  ${l.league.padEnd(26)} n=${String(l.sample).padStart(3)}  ${(l.accuracy*100).toFixed(1)}%`);

  const sample = await prisma.prediction.findFirst({
    where: { status: "SETTLED" },
    include: { match: { include: { homeTeam: true, awayTeam: true, league: true } }, matchResult: true, totalGoals: true, exactScore: true, btts: true, halfTime: true, teamGoals: true, modelOutputs: true },
    orderBy: { confidenceScore: "desc" },
  });
  if (sample) {
    console.log("\n=== EXEMPLE : prédiction la plus confiante ===");
    console.log(`${sample.match.homeTeam.name} vs ${sample.match.awayTeam.name} — ${sample.match.league.name}`);
    console.log(`Résultat réel : ${sample.match.homeScore}-${sample.match.awayScore}  |  Prédiction : ${sample.actualResult}  |  ${sample.isCorrect ? "✅ correcte" : "❌ incorrecte"}`);
    const mr = sample.matchResult!;
    console.log(`1X2 : dom ${(mr.homeWinProb*100).toFixed(1)}% / nul ${(mr.drawProb*100).toFixed(1)}% / ext ${(mr.awayWinProb*100).toFixed(1)}%`);
    console.log(`Confiance SOLEIL : ${sample.confidenceScore}/100 (qualité données : ${sample.dataQuality})`);
    console.log(`Accord modèles : ${((sample.modelAgreement ?? 0)*100).toFixed(0)}%`);
    console.log(`Buts attendus : ${sample.totalGoals?.expectedGoals.toFixed(2)}  |  O2.5 ${(((sample.totalGoals?.ou25Over)??0)*100).toFixed(1)}%`);
    console.log(`BTTS oui : ${(((sample.btts?.yesProb)??0)*100).toFixed(1)}%  |  Score le + probable : ${sample.exactScore?.mostLikelyScore} (${(((sample.exactScore?.mostLikelyProb)??0)*100).toFixed(1)}%)`);
    console.log(`1re MT ≥1 but : ${(((sample.halfTime?.probGoalInFirstHalf)??0)*100).toFixed(1)}%  |  2e MT ≥1 but : ${(((sample.halfTime?.probGoalInSecondHalf)??0)*100).toFixed(1)}%`);
    console.log("Poids des modèles :");
    for (const o of sample.modelOutputs.sort((a,b)=>b.weight-a.weight)) {
      const out = o.output as { applicable?: boolean; unavailableReason?: string };
      console.log(`  ${o.modelName.padEnd(12)} poids ${(o.weight*100).toFixed(1)}%  ${out.applicable === false ? "— " + out.unavailableReason : ""}`);
    }
  }
}
main().finally(() => prisma.$disconnect());
