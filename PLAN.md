# Task Canvas MCP: Implementation Plan

> Goal: A VPS-hosted MCP server + live web canvas that implements a **Task Execution Protocol (TEP)**. The agent plans all tasks up front, then only ever receives work from the server, one stage at a time. Stages can contain parallel tasks. Status is visible live on a shareable canvas URL.

Audience: coding agent implementing this end-to-end.

---

## 1. Product summary

**Task Canvas** is:

1. An **MCP server** that exposes the Task Execution Protocol.
2. A **persistent run store** on a VPS.
3. A **live web canvas** (shareable link) showing every task with status indicators, including parallel lanes.

### Core idea: progressive disclosure

- **Plan phase:** the agent (or the human on the canvas) defines the full list of tasks and stages once.
- **Execute phase:** the agent can no longer read future tasks. The server hands out only the currently unlocked tasks. A stage unlocks only when every task in the previous stage is done (or skipped).
- The server response is the instruction. The agent follows the protocol output instead of its own memory of the plan.
- Only the human (canvas) sees the full plan during execution.

### Honest limit

MCP cannot force an agent to call the server. Mitigations: hidden future tasks, a consistent instruction envelope in every response, idempotent resume, and a stalled-run indicator on the canvas. README must state this plainly.

---

## 2. Naming

Protocol name candidates (pick one, document in README):

| Name | Abbrev | Note |
|------|--------|------|
| Task Execution Protocol | TEP | Recommended. Clear, neutral, pairs with MCP. |
| Task Flow Protocol | TFP | Emphasizes staged flow. |
| Task Gate Protocol | TGP | Emphasizes unlock gates. |
| Task Processing Protocol | TPP | Close to the original idea, but "processing" is vague. |

Product name stays **Task Canvas**. The MCP server is `task-canvas-mcp`, implementing TEP v1.

---

## 3. Non-goals (MVP)

- Arbitrary DAG with free-form dependencies (stages only; `depends_on` is post-MVP).
- Multi-agent editing of the same plan.
- Built-in browser automation or any agent runtime. Agents bring their own tools.
- Design polish (functional UI is enough).

---

## 4. Core concepts

| Concept | Meaning |
|--------|---------|
| **Run** | One job: `run_id`, title, status, created_at. |
| **Stage** | Ordered group. Tasks inside a stage run in parallel. Stage N+1 unlocks when all tasks in stage N are `completed` or `skipped`. |
| **Task** | One unit of work: `task_id`, `stage`, `lane`, `title`, `description`, `done_when?`, `status`, `result`, `error`, timestamps. |
| **Worker** | Optional identity (`worker_id`) of whoever holds a task. One agent can hold several tasks (using subagents) or several agents can each hold one. |
| **Lease** | A claimed task is held with an expiry. If not heartbeated or reported, it returns to `pending`. |
| **Canvas URL** | `https://<host>/r/<run_id>`: live view. |

### Plan examples

Sequential (every task its own stage):

```
stage 1: go to xxx.com
stage 2: get all images
stage 3: find images of a car
stage 4: identify car type
```

With parallel tasks:

```
stage 1: open site
stage 2: [A] get images        [B] get page text      (parallel)
stage 3: [A] find cars         [B] summarize text     (parallel)
stage 4: merge results
```

Simple input format for agents: array of stages, each stage an array of tasks. A flat list of tasks means one task per stage.

### Task statuses

- `pending`: not unlocked or not claimed
- `in_progress`: leased, show blinking green diode
- `completed`
- `failed`: error stored
- `skipped`: explicitly skipped with reason

### Run statuses

`draft` (editable, no execution) -> `active` -> `completed` | `failed` | `cancelled`. Also `paused` (human-set, no tasks handed out).

### Failure policy

Default **stop-on-fail**: a failed task blocks its stage from completing and blocks next stages. Siblings in the same stage already running may finish. Resolution options: `retry`, `skip`, `abort`. Config flag `stop_on_fail=false` lets other lanes continue.

---

## 5. Architecture

```
[LLM Agent(s)] --MCP (TEP)--> [task-canvas-mcp] --DB--> [SQLite]
                                    |
                                    +--HTTP/SSE--> [Canvas web UI]
```

### Default stack

- TypeScript + official `@modelcontextprotocol/sdk`.
- One process: MCP (stdio for local, Streamable HTTP for remote) + REST + SSE for the UI.
- SQLite on a VPS volume. Single process, so no need for Postgres in MVP.
- SSE for realtime (poll fallback every 2s).
- Caddy for TLS.

### Auth (MVP)

- `run_id` is a UUID. Two secrets per run:
  - `agent_secret`: write access for MCP tools (returned once by `create_run`).
  - `owner_secret`: human edit/pause/approve on the canvas.
- Viewer link is read-only and does not contain any secret.
- MCP endpoint requires a server-level bearer token (env `MCP_TOKEN`) since many clients cannot send per-run headers. Tools also take `run_id` and `agent_secret` arguments.

---

## 6. TEP tool surface (MCP contract)

Small on purpose. Tool names can be prefixed `task_canvas_`.

### Plan phase

| Tool | Purpose |
|------|---------|
| `create_run` | Args: `title`, `stages` (array of arrays of `{title, description?, done_when?}`) or flat `tasks`, `stop_on_fail?`, `autostart?` (default true). Returns `run_id`, `canvas_url`, `agent_secret`, and the first `next_task` envelope if autostarted. |
| `start_run` | `draft` -> `active`. Only needed if `autostart=false` (human reviews plan on canvas first). |

### Execute phase

| Tool | Purpose |
|------|---------|
| `next_task` | The core loop tool. Args: `run_id`, `agent_secret`, `worker_id?`, `reports?` (array of results for tasks just finished). Applies reports, then returns the currently available tasks for this worker. |
| `heartbeat` | Optional. Extends lease for long tasks. Args: `run_id`, `task_id`. |
| `get_status` | Progress only: counts, current stage, completed task titles and results. **Never returns pending future task titles.** |
| `abort_run` | Cancels the run. |

A report item: `{task_id, status: "done" | "failed" | "skipped", result?, error?}`. `result` is required for `done`. `error` is required for `failed`.

### Response envelope (identical shape every time)

```json
{
  "run_id": "...",
  "state": "work" | "wait" | "blocked" | "paused" | "done" | "aborted",
  "tasks": [
    {"task_id": "...", "stage": 2, "title": "...", "description": "...", "done_when": "..."}
  ],
  "progress": {"completed": 3, "total": 7, "stage": 2, "stages_total": 4},
  "instruction": "Execute only these tasks. When finished, call next_task with a report for each."
}
```

States:

- `work`: tasks to do now (one, or several if the stage is parallel and no worker_id split is used).
- `wait`: other workers still hold tasks in this stage. Call `next_task` again after a delay (response includes `retry_after_s`).
- `blocked`: a task failed. `instruction` lists the allowed actions (`retry`, `skip`, `abort`) or says waiting for human on canvas.
- `paused`: human paused the run.
- `done`: all stages complete.
- `aborted`: run cancelled.

### Rules the server enforces

1. **Hidden future:** no tool returns tasks of locked stages to the agent.
2. **Stage gate:** stage N+1 is never handed out until all tasks of stage N are `completed` or `skipped`.
3. **Lease:** handing out a task sets it `in_progress` with `worker_id` and `lease_expires_at`. Reports for a task not leased to the reporter are rejected.
4. **Idempotent `next_task`:** calling it with no reports returns the tasks already leased to that worker. Context resets and retries are safe.
5. **Parallel distribution:** with `worker_id`, each caller gets distinct pending tasks from the open stage. Without `worker_id`, the caller gets all pending tasks of the open stage in one response.
6. **Evidence:** `done` requires a non-empty `result`.
7. **Expired lease:** task returns to `pending`, attempt counter increments, event logged.
8. **Failure:** per section 4 policy. Resolution happens via `next_task` reports of `retry` or `skip` (when `blocked`), or by the human on the canvas.
9. **Errors:** structured `{code, message, hint}` that tells the agent how to recover.

### Human controls (canvas only)

Pause/resume, edit or reorder pending tasks and stages, insert a task, approve or reject a task marked `needs_approval`, retry/skip failed tasks, abort. The agent just receives the updated next tasks.

### Optional MVP+

- `needs_approval` task flag: after the agent reports `done`, the task stays `awaiting_approval` until the human approves on the canvas.
- Agent-added tasks: `next_task` accepts `add_tasks` appended to the current or next stage, only if run setting `allow_agent_additions` is true.
- `depends_on` per task (full DAG).

---

## 7. HTTP API (canvas)

Base: `/api/v1`

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/runs/:run_id` | Full snapshot for the viewer (human view includes all tasks). |
| `GET` | `/runs/:run_id/events` | SSE stream of status changes. |
| `POST` | `/runs` | Human-created run. |
| `PATCH` | `/runs/:run_id/plan` | Edit pending tasks/stages (owner secret). |
| `POST` | `/runs/:run_id/start` / `pause` / `resume` / `abort` | Owner secret. |
| `POST` | `/runs/:run_id/tasks/:task_id/{retry,skip,approve,reject}` | Owner secret. |

All mutations go through one domain service shared with MCP tools.

---

## 8. Data model

```text
runs
  id, title, status, stop_on_fail, allow_agent_additions,
  agent_secret_hash, owner_secret_hash, version INT,
  created_at, updated_at, expires_at

tasks
  id, run_id FK, stage INT, lane INT, title, description, done_when,
  status, needs_approval BOOL, worker_id NULL, lease_expires_at NULL,
  attempts INT, result NULL, error NULL, started_at, finished_at
  UNIQUE(run_id, stage, lane)

events
  id, run_id FK, task_id NULL, type, payload JSON, created_at
```

Indexes: `(run_id, stage, status)`, `(run_id, created_at)` on events. `version` is bumped on each mutation for optimistic concurrency in the canvas editor. All claim/report operations run in a single transaction.

---

## 9. Canvas UI (MVP)

Route: `/r/:run_id`

- Header: title, run status, progress bar, copy-link button.
- Layout: **stages as columns or rows, parallel tasks stacked inside the stage** (lanes). Locked stages are dimmed.
- Task block: index, title, description (collapsed), status chip, worker id, elapsed time, result/error.
- Visual states:
  - `pending`: muted gray
  - `in_progress`: highlighted plus **blinking green diode**
  - `completed`: solid green check
  - `failed`: red plus error text
  - `skipped`: dashed
  - `awaiting_approval`: amber with approve/reject buttons (owner)
- Stalled indicator: if the run is `active` and no agent call for N minutes, show "agent idle".
- Event timeline panel from the `events` table.
- Owner mode: edit plan in `draft`, pause, edit pending tasks, retry/skip, start.
- Viewer mode: read-only.
- Live updates via SSE, poll fallback.

Keep it minimal: one HTML+JS page or a small Svelte/React app.

---

## 10. Agent UX flow

**Agent plans, then executes:**

1. `create_run({title, stages})` -> receives `canvas_url` (show it to the user) and the first `next_task` envelope.
2. Loop:
   - Execute the tasks in the envelope using the agent's own tools.
   - Call `next_task({reports: [...]})`.
   - Handle `state`: `work` continue, `wait` sleep and retry, `blocked` follow instruction, `done` finish.
3. Final summary uses `get_status`.

**Human plans:** user builds the plan on the canvas, clicks Start, pastes the run id and agent secret (or a one-line prompt generated by the canvas) into the agent chat.

**Parallel with multiple agents:** each agent calls `next_task` with its own `worker_id` and receives different tasks of the open stage.

**Parallel with one agent:** the envelope contains all tasks of the stage. The agent may run them with subagents and report all together or one by one.

Example user prompt the product must support:

> use task-canvas-mcp to do: 1. go to xxx.com 2. get all images 3. find images of a car 4. identify car type

The canvas should generate a copyable "agent instruction snippet" explaining the loop, to paste into agent rules.

---

## 11. Project layout

```text
task-canvas-mcp/
  README.md
  PLAN.md
  package.json
  src/
    server.ts            # HTTP + MCP mount
    mcp/tools.ts         # tool handlers (thin)
    domain/protocol.ts   # TEP state machine, all enforcement
    db/schema.sql
    db/client.ts
    api/routes.ts
  web/
    index.html | app/
  deploy/
    Caddyfile
    docker-compose.yml
  tests/
    protocol.test.ts     # stage gate, lease, idempotency, parallel, failure
```

---

## 12. Implementation phases

### Phase 0: Skeleton
- Repo, lint, env (`PORT`, `DB_PATH`, `PUBLIC_BASE_URL`, `MCP_TOKEN`), `GET /health`.

### Phase 1: Domain + DB
- Schema, migrations.
- `protocol.ts` with transactional `next_task` (apply reports, unlock stage, lease, envelope).
- Unit tests for every rule in section 6.

### Phase 2: MCP server
- Tools from section 6, stdio plus Streamable HTTP.
- `canvas_url = ${PUBLIC_BASE_URL}/r/${run_id}`.

### Phase 3: Canvas UI
- Read-only live view with stages/lanes and diode.
- Owner controls: pause, retry/skip, edit pending, start.

### Phase 4: Deploy
- Docker Compose, Caddy TLS.
- Smoke test from a real MCP client (Cursor / Claude Desktop config in README).

### Phase 5: Harden (post-MVP)
- Rate limits, retention, webhooks on fail, `depends_on`, approvals, artifact attachments.

---

## 13. Acceptance criteria (MVP done when)

1. Agent creates a run with 4 stages and gets a working canvas URL plus first task.
2. No tool response ever contains titles of locked stages (verified by test).
3. Canvas shows pending -> blinking in-progress -> completed/failed in realtime.
4. Stage 2 is never handed out while any stage 1 task is not `completed`/`skipped`.
5. A stage with 2 parallel tasks hands both to a single caller, or one each to two `worker_id`s, and the next stage unlocks only after both report.
6. `next_task` without reports is idempotent and returns the same leased tasks.
7. Expired lease returns a task to `pending`.
8. A failed task yields `state: blocked` with recovery options and halts later stages (stop-on-fail).
9. Reporting `done` without `result`, or for a task not leased to the reporter, is rejected with a clear error.
10. Human pause on the canvas makes `next_task` return `paused`.
11. README documents MCP config for the VPS endpoint.
12. Tests cover all enforcement rules without UI.

---

## 14. README must include

- What Task Canvas and TEP are (one paragraph) plus the honest limit.
- Env vars.
- Local run and Docker deploy.
- Example MCP client config.
- Example agent prompt and the copyable instruction snippet.
- Tool reference and response envelope.

---

## 15. Open decisions (implementer picks defaults, documents them)

| Decision | Default for MVP |
|----------|-----------------|
| Language | TypeScript + official MCP SDK |
| DB | SQLite on VPS volume |
| Remote transport | Streamable HTTP (SSE if SDK requires) |
| Parallelism model | Stages with parallel lanes |
| Failure policy | Stop-on-fail |
| Lease duration | 10 minutes, extendable via `heartbeat` |
| Agent-added tasks | Off |
| Protocol name | TEP |

---

## 16. Reminders for the coding agent

- Do not build a general agent runtime.
- Do not scrape websites inside this project.
- Do not weaken the hidden-future or stage-gate rules for convenience.
- Keep the response envelope shape stable and identical across tools.
- Prefer structured errors (`code`, `message`, `hint`) agents can recover from.

---

## 17. First commit checklist

- [ ] `protocol.ts` with tests: stage gate, lease, idempotency, parallel, failure
- [ ] `next_task` MCP tool wired to the domain
- [ ] `GET /r/:run_id` live canvas with stages, lanes, diode
- [ ] `PUBLIC_BASE_URL` canvas links
- [ ] Docker deploy files
- [ ] README with agent usage example
