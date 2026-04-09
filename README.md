# Autoforge Milestone 1

Local-first Autoforge prototype implementing the phase 1 + 2 pipeline:

- Submit task request
- Run planner -> coder -> reviewer -> rework loop
- Apply PR threshold gate
- Await human approval
- Complete after approval

## Run locally

```bash
bun install
bun test
bun run dev
```

Open `http://127.0.0.1:3000` for the minimal dashboard.

## API quickstart

Create task:

```bash
curl -X POST http://127.0.0.1:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"projectId":"autoforge","description":"Add a hello world endpoint"}'
```

Approve task:

```bash
curl -X POST http://127.0.0.1:3000/api/tasks/<TASK_ID>/approve
```

Reject task:

```bash
curl -X POST http://127.0.0.1:3000/api/tasks/<TASK_ID>/reject \
  -H "Content-Type: application/json" \
  -d '{"reason":"Needs follow-up changes"}'
```
