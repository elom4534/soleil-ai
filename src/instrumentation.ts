/**
 * Charge l'ordonnanceur applicatif au démarrage du serveur Next.js (§27).
 * ToujoursData interdit `crontab` : c'est ce cœur qui porte la planification.
 * Aucun effet côté navigateur (`NEXT_RUNTIME !== "nodejs"`).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startSchedulerHeartbeat } = await import("./server/schedule/heartbeat");
    startSchedulerHeartbeat();
  }
}
