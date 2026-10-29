# Skill: working under TGP (Task Gate Protocol)

Use this whenever a human tells you a job runs under TGP, gives you a TGP run id, or asks you to run a TGP workflow template.

TGP is the source of truth for what you do next. You never decide the order of steps yourself. The engine shows you only the step(s) that are open right now, checks your work itself, and unlocks the next step only when the checks pass.

## 1. Start or resume

- New job: `tgp templates` to see what exists, then `tgp start <template> [--param key=value]`.
- Existing job (you were given a run id, or you lost context): `tgp next <run_id>`.
- Not sure which run: `tgp runs`, pick the one that is not `done` or `aborted`, then `tgp next <run_id>`.

Every command prints one JSON envelope:

```json
{ "run_id": "...", "state": "work", "tasks": [ ... ], "progress": { ... }, "instruction": "..." }
```

Read `state`, `tasks` and `instruction`. Follow `instruction` literally.

## 2. The loop

```
loop:
  env = tgp next <run_id>
  if env.state == "done":     summarize, share env.canvas_url, stop
  if env.state == "aborted":  stop
  if env.state in (wait, awaiting_approval, paused, blocked):
      tell the human if the instruction says so, wait env.retry_after_s seconds, continue
  for each task in env.tasks (state "work"):
      do ONLY what task.description says, until task.done_when is true
      run the exact command in task.report_with, with real evidence in --result
      if the response state is "gate_failed": read report.gate_results, fix, report again
```

## 3. Rules

1. Do ONLY the tasks in the `tasks` list of the latest response. Nothing else.
2. Never work ahead. Later steps are hidden on purpose. Do not guess them, prepare them or "save time" on them.
3. Report every task with `tgp done <run> <task> --result "<evidence>"`. Evidence means something checkable: paths written, counts, values, command output. Not "done" or "completed it".
4. If the task lists required outputs, pass each with `--output key=value`. Pass produced files with `--artifact path`.
5. The engine runs the gates. You cannot mark a task done by saying so. If a report comes back `gate_failed`, the task is still open. Read each failed gate's `detail` and `hint`, fix the actual problem, then report again. Do not argue with the gate and do not move on.
6. After `max_attempts` failed reports a task becomes `failed` and the run is `blocked`. Tell the human what went wrong and wait. Only a human can retry or skip it.
7. If you truly cannot do a task, say so: `tgp fail <run> <task> --error "<why>"`. Do not fake evidence.
8. Use `tgp skip <run> <task> --reason "..."` only when the task says `skippable: true` and skipping is right.
9. `awaiting_approval` means a human must approve on the canvas. Tell them the canvas link from the instruction, then wait and call `tgp next` again. Do nothing else meanwhile.
10. `paused` means the human paused the run. Wait. `aborted` means stop for good.
11. Long task (over 10 minutes)? Run `tgp heartbeat <run> <task>` now and then, or your lease expires and the task goes back to the queue.
12. Parallel stage with several agents: each agent passes its own `--worker <name>` on every call. Without `--worker` you receive all open lanes of the stage and may do them in any order.

## 4. After context loss

You do not need to remember anything except the run id. Run `tgp next <run_id>`. It is idempotent: it returns your current open task(s) again without side effects, including any gate failure details from your last report. `tgp status <run_id>` shows the results of finished steps if you need them.

## 5. Errors

Rejected commands return `state: "rejected"` and `error: {code, message, hint}`, plus your current tasks. Common codes:

| code | meaning | what to do |
|---|---|---|
| TASK_NOT_AVAILABLE | that task is locked, unknown or not yours to report now | `tgp next <run>` and work on what it returns |
| NOT_LEASED | task not claimed (or your lease expired) | `tgp next <run>`, then do it and report |
| RESULT_REQUIRED / OUTPUT_REQUIRED | report incomplete | add `--result` / `--output k=v` |
| RUN_PAUSED, RUN_ABORTED, RUN_DONE | run is not accepting work | wait, or stop |
| TASK_FAILED | the task failed and blocks the run | tell the human, wait |

Exit codes: 0 ok, 1 rejected, 2 usage error, 3 gate failed.
