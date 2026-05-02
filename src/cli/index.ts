import { runExperimentCli } from "./experiments";

const baseUrl = process.env.AUTOFORGE_URL ?? "http://127.0.0.1:3000";

async function main(): Promise<void> {
  await runExperimentCli(process.argv.slice(2), {
    baseUrl,
    fetch,
    stdout: (text) => {
      process.stdout.write(text);
    }
  });
}

void main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
