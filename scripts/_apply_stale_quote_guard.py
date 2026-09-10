from pathlib import Path
import subprocess


def replace_once(path: str, old: str, new: str):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}")
    p.write_text(text.replace(old, new, 1))


replace_once(
    "worker/watchdog.ts",
    '''    const railwayToken = process.env.RAILWAY_API_TOKEN?.trim();
    const railwayServiceId = process.env.RAILWAY_SERVICE_ID?.trim();
    if (alerted && railwayToken && railwayServiceId) {
      try {
        const restart = await restartRailwayService(railwayToken, railwayServiceId);
        console.warn("[scalper-watchdog] railway_restart", restart);
      } catch (error) {
''',
    '''    const railwayToken = process.env.RAILWAY_API_TOKEN?.trim();
    const currentRailwayServiceId = process.env.RAILWAY_SERVICE_ID?.trim();
    const currentRailwayServiceName = process.env.RAILWAY_SERVICE_NAME?.trim();
    const railwayWorkerServiceId = process.env.SCALPER_WORKER_SERVICE_ID?.trim()
      || (currentRailwayServiceName === "scalper-worker" ? currentRailwayServiceId : undefined);
    if (alerted && railwayToken && railwayWorkerServiceId) {
      try {
        const restart = await restartRailwayService(railwayToken, railwayWorkerServiceId);
        console.warn("[scalper-watchdog] railway_restart", restart);
      } catch (error) {
''',
)

replace_once(
    "README.md",
    '- `RAILWAY_SERVICE_ID` — ID del servizio Railway da riavviare (`scalper-worker`). Il watchdog risolve l\'environment del servizio, prova `serviceInstanceRedeploy` e usa `deploymentRestart` come fallback.\n',
    '- `RAILWAY_SERVICE_ID` — variabile automatica Railway che identifica **il servizio corrente**. Sul servizio separato `scalper-watchdog` identifica quindi il watchdog e non deve essere usata come target del restart.\n- `SCALPER_WORKER_SERVICE_ID` — ID reale di `scalper-worker` quando il watchdog gira in un servizio separato; è il target usato per `serviceInstanceRedeploy`, con `deploymentRestart` come fallback.\n',
)

changed = set(subprocess.check_output(["git", "diff", "--name-only"], text=True).splitlines())
allowed = {"worker/watchdog.ts", "README.md"}
if changed != allowed:
    raise SystemExit(f"unexpected changed files: {sorted(changed)}")
if "src/lib/server/scalperStrategy.ts" in changed:
    raise SystemExit("strategy changed unexpectedly")
print("Changed:", sorted(changed))
