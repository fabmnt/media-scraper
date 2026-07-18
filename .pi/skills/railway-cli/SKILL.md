---
name: railway-cli
description: Operate Railway from the command line to inspect projects, services, deployments, logs, metrics, variables, domains, and resources; deploy local code; provision infrastructure; and troubleshoot build or runtime failures. Use whenever a task requires Railway CLI state or mutations, especially deployment and production-resource work.
compatibility: Requires the Railway CLI and either interactive Railway login or RAILWAY_TOKEN/RAILWAY_API_TOKEN authentication.
---

# Railway CLI

Use the Railway CLI for operations that depend on the current repository, its linked project, local deployments, exact command output, SSH, or `railway run`.

Official references:

- CLI: <https://docs.railway.com/cli>
- Deploying: <https://docs.railway.com/cli/deploying>
- Variables: <https://docs.railway.com/cli/variable>
- Logs: <https://docs.railway.com/cli/logs>

## Resource model

Railway resources are scoped as workspace → project → environment → service → deployment. Most commands use the project, environment, and service linked to the current directory. Explicit `--project`, `--environment`, and `--service` scopes override linked context.

## Preflight

For inspection, configuration, and debugging work, establish the executable, authentication, version, and linked scope before mutation:

```bash
command -v railway
railway --version
railway whoami --json
railway status --json
```

If the CLI is unavailable, install it using one of Railway's official methods:

```bash
npm install --global @railway/cli
# or on macOS
brew install railway
```

For an interactive local session, use `railway login`. Use `railway login --browserless` only on a genuinely headless machine. In CI or unattended execution, use exactly one token type:

- `RAILWAY_TOKEN`: project-scoped operations
- `RAILWAY_API_TOKEN`: account/workspace-scoped operations

Never print, persist, or commit token or secret values. Never read `.env` merely to discover secrets when Railway references or existing configuration are sufficient.

If the user asks to deploy the current directory, `railway up` may be run directly because it handles authentication and project/service setup. Do not add a redundant failing `whoami` preflight in that flow.

## Operating rules

1. Prefer `--json` for bounded reads and machine-readable results.
2. Resolve the exact project, environment, and service before every mutation.
3. When several services could match, inspect with `railway service list --json`; do not guess.
4. State the intended scope before changing production resources or configuration.
5. Require explicit user confirmation before destructive actions such as deleting services, deployments, databases, buckets, volumes, domains, or variables.
6. Do not use `--yes` to bypass destructive confirmations unless the user explicitly authorized that exact action.
7. After every mutation, perform a scoped read-back to verify it.
8. Never claim deployment success until its terminal status is `SUCCESS`. A detached upload only proves the build was queued.
9. Prefer committed, reviewable application configuration over ad hoc production changes when the requested behavior belongs in source control.
10. Before changing concurrency or resource-sensitive behavior, inspect both Railway metrics/limits and the application's actual bottlenecks. Treat CPU, memory, database connections, Redis load, external subprocesses, and persistent-volume semantics as separate constraints.

## Common inspections

```bash
railway status --json
railway whoami --json
railway project list --json
railway service list --json
railway deployment list --json
railway metrics --service <service> --since 1h --json
railway logs --service <service> --lines 200 --json
railway logs --service <service> --build --latest --lines 200 --json
railway logs --service <service> --http --since 1h --json
railway variable list --service <service> --json
railway domain list --service <service> --json
```

Use longer metrics windows when making capacity decisions; compare idle, normal, and peak periods where possible. Use `railway <command> --help` when the installed CLI's syntax differs from documentation—the installed version is authoritative.

## Deployments

Deploy source from the current repository with `railway up`, not `railway deploy` (`deploy` installs templates):

```bash
railway up --service <service> --environment <environment>
railway up --detach --service <service> --environment <environment>
```

For a detached deployment, poll the newest scoped deployment:

```bash
railway deployment list --service <service> --environment <environment> --json
```

Report `SUCCESS` as deployed. For `FAILED` or `CRASHED`, inspect build and runtime logs. Report any other state exactly rather than treating it as success.

## Variables and local commands

```bash
railway variable list --service <service> --environment <environment> --json
railway variable set KEY=value --service <service> --environment <environment>
printf %s "$SECRET_VALUE" | railway variable set SECRET_KEY --stdin --service <service> --environment <environment>
railway variable delete KEY --service <service> --environment <environment>
railway run --service <service> --environment <environment> -- <command>
```

Variable mutations can stage or trigger deployments. Verify the resulting variable/deployment state. Avoid placing sensitive values directly in command text when stdin is supported because shell history and tool logs may retain arguments.

## Services and infrastructure

```bash
railway add --service <name> --json
railway add --database postgres --json
railway add --database redis --json
railway domain list --service <service> --json
railway logs --service <service> --network --lines 200 --json
```

Always inspect existing services before provisioning to avoid duplicates.

## Resource-aware application changes

When asked to tune throughput based on Railway resources:

1. Inspect linked context and identify the relevant service.
2. Query service metrics over a representative period and inspect recent logs/deployments.
3. Inspect source code to find current limits and why they exist.
4. Preserve data-integrity constraints; increase parallelism only around work that is safe to overlap.
5. Prefer a bounded, configurable limit with a conservative default. If runtime resource detection is appropriate, cap it and reserve headroom for the API, database clients, queues, and subprocess peaks.
6. Use platform-provided limits when available. If only runtime CPU/memory detection is available, document that it reflects container limits and add explicit environment overrides.
7. Run the project's lint, typecheck, build, and requested checks before proposing deployment.
8. If the user requested a PR rather than deployment, do not mutate production behavior directly; commit the source-controlled change and open the PR after verification.

## Completion response

Summarize:

1. Action and exact Railway scope.
2. Observed result or status, omitting secrets.
3. Source changes and verification performed.
4. Next action, such as a PR link, deployment approval, or a concrete unresolved blocker.
