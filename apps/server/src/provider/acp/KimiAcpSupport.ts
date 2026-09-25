// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  type KimiSettings,
  ProviderDriverKind,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import type { AcpSessionMode, AcpSessionModeState } from "./AcpRuntimeModel.ts";
import type * as EffectAcpSchema from "effect-acp/schema";

const KIMI_DRIVER_KIND = ProviderDriverKind.make("kimi");
export const KIMI_DEFAULT_MODEL_SLUG =
  DEFAULT_MODEL_BY_PROVIDER[KIMI_DRIVER_KIND] ?? "kimi-code/kimi-for-coding";
const KIMI_HOME_ENV = "KIMI_CODE_HOME";
const KIMI_CREDENTIALS_RELATIVE_PATH = ["credentials", "kimi-code.json"] as const;

type KimiAcpRuntimeKimiSettings = Pick<KimiSettings, "binaryPath">;

interface KimiAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly kimiSettings: KimiAcpRuntimeKimiSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}

/** Builds the child-process command for Kimi's ACP server. */
function buildKimiAcpSpawnInput(
  kimiSettings: KimiAcpRuntimeKimiSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: kimiSettings?.binaryPath || "kimi",
    args: ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

/**
 * Spawns a scoped Kimi ACP runtime using the CLI's terminal login method.
 * Closing the required scope also owns cleanup of the child process.
 */
export const makeKimiAcpRuntime = (
  input: KimiAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildKimiAcpSpawnInput(input.kimiSettings, input.cwd, input.environment),
        authMethodId: "login",
        // Advertise form-mode elicitation so Kimi's ACP process sends
        // `session/elicitation` requests to the client instead of bailing out
        // with `methodNotFound`. The form capability is the only one Kimi
        // 0.43.x exercises today; URL elicitation stays off.
        clientCapabilities: {
          elicitation: {
            form: {},
          },
        },
        // Kimi's harness acts on its own: cron fires and background-agent
        // completions stream assistant chunks between user prompts. Without
        // this the runtime drops them and the thread never sees the update.
        passiveAssistantUpdates: true,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

/**
 * Resolves the Kimi data directory from `KIMI_CODE_HOME`, falling back to
 * `~/.kimi-code`. A leading `~` expands to the real home so the path matches
 * what the spawned CLI resolves. The returned path is never read — callers
 * only join it.
 */
function resolveKimiDataHome(environment: NodeJS.ProcessEnv | undefined): string {
  const override = environment?.[KIMI_HOME_ENV]?.trim();
  if (!override) {
    return NodePath.join(NodeOS.homedir(), ".kimi-code");
  }
  if (override === "~") {
    return NodeOS.homedir();
  }
  if (override.startsWith("~/")) {
    return NodePath.join(NodeOS.homedir(), override.slice(2));
  }
  return override;
}

/**
 * Existence of this file is the login signal (`kimi login` writes it). Never
 * read the file — it holds the access token.
 */
export function resolveKimiCredentialsPath(environment: NodeJS.ProcessEnv | undefined): string {
  return NodePath.join(resolveKimiDataHome(environment), ...KIMI_CREDENTIALS_RELATIVE_PATH);
}

/** Normalizes a model selection, using Kimi's default for missing or blank values. */
export function resolveKimiAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : KIMI_DEFAULT_MODEL_SLUG;
  return normalizeModelSlug(base, KIMI_DRIVER_KIND) ?? KIMI_DEFAULT_MODEL_SLUG;
}

/** The session's current model from the live `model` config option. */
export function currentKimiModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  const configOptions = sessionSetupResult.configOptions;
  if (!configOptions) {
    return undefined;
  }
  const modelOption = configOptions.find(
    (option) => option.category === "model" && option.type === "select",
  );
  if (!modelOption || typeof modelOption.currentValue !== "string") {
    return undefined;
  }
  return modelOption.currentValue.trim() || undefined;
}

const KIMI_PLAN_MODE_ALIASES = ["plan"];

/**
 * Resolves the plan mode from the modes the session advertises, if any.
 * The synthetic `/plan` command switches to this mode for a single turn.
 */
export function findKimiPlanMode(modeState: AcpSessionModeState): AcpSessionMode | undefined {
  return findModeByAliases(modeState.availableModes, KIMI_PLAN_MODE_ALIASES);
}

/**
 * Kimi 2.0.x applies a switch to its plan mode but still answers the
 * `session/set_config_option` request with "Internal error: Already in plan
 * mode" — the session's own reasoning stream proves the mode is active.
 * The mode-switch paths treat this defect as success.
 */
export function isKimiAlreadyInPlanModeError(causeMessage: string): boolean {
  return causeMessage.includes("Already in plan mode");
}
const KIMI_APPROVAL_MODE_ALIASES = ["default"];
const KIMI_AUTO_MODE_ALIASES = ["auto"];
const KIMI_FULL_ACCESS_MODE_ALIASES = ["yolo"];

function normalizeModeSearchText(mode: AcpSessionMode): string {
  return [mode.id, mode.name, mode.description]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findModeByAliases(
  modes: ReadonlyArray<AcpSessionMode>,
  aliases: ReadonlyArray<string>,
): AcpSessionMode | undefined {
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase());
  for (const alias of normalizedAliases) {
    const exact = modes.find((mode) => {
      const id = mode.id.toLowerCase();
      const name = mode.name.toLowerCase();
      return id === alias || name === alias;
    });
    if (exact) {
      return exact;
    }
  }
  for (const alias of normalizedAliases) {
    const partial = modes.find((mode) => normalizeModeSearchText(mode).includes(alias));
    if (partial) {
      return partial;
    }
  }
  return undefined;
}

/**
 * Maps T3's interaction/runtime modes onto the mode ids Kimi advertises on
 * `session/new`. Kimi has no acceptEdits equivalent: approval-required maps
 * to `default` and both auto modes map to `auto`. Aliases are resolved
 * against the live `modes` response; when none match the session's current
 * mode is kept.
 */
export function resolveRequestedKimiModeId(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  const modeState = input.modeState;
  if (!modeState) {
    return undefined;
  }

  if (input.interactionMode === "plan") {
    return (
      findModeByAliases(modeState.availableModes, KIMI_PLAN_MODE_ALIASES)?.id ??
      modeState.currentModeId
    );
  }

  switch (input.runtimeMode) {
    case "approval-required":
      return (
        findModeByAliases(modeState.availableModes, KIMI_APPROVAL_MODE_ALIASES)?.id ??
        modeState.currentModeId
      );
    case "auto-accept-edits":
    case "auto":
      return (
        findModeByAliases(modeState.availableModes, KIMI_AUTO_MODE_ALIASES)?.id ??
        modeState.currentModeId
      );
    case "full-access":
      return (
        findModeByAliases(modeState.availableModes, KIMI_FULL_ACCESS_MODE_ALIASES)?.id ??
        modeState.currentModeId
      );
    default:
      return modeState.currentModeId;
  }
}

/**
 * Selects a nonblank model only when it differs from the session's current
 * model, returning the model id in effect after the operation.
 */
export function applyKimiAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const requestedModelId = input.requestedModelId?.trim() || undefined;
  if (requestedModelId === undefined || requestedModelId === input.currentModelId) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setSessionModel(requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(requestedModelId));
}

/**
 * Kimi isolates sub-agent work behind a single `tool_call` whose title is the
 * dispatch name — there is no `_meta` linkage and no inner-activity stream.
 * Classify by title so the rows render like other providers' subagent spawns.
 */
export function classifyKimiSubagentLabel(
  title: string | undefined,
): "Subagent" | "Agent swarm" | undefined {
  const normalized = title?.trim().toLowerCase() ?? "";
  if (normalized === "agent") {
    return "Subagent";
  }
  if (normalized === "agentswarm") {
    return "Agent swarm";
  }
  return undefined;
}

/**
 * Kimi's TUI arms `/plan`, `/goal`, and `/swarm` as message commands, but its
 * ACP server advertises neither and rejects them as unknown commands. T3
 * re-publishes them as synthetic provider commands and rewrites matching
 * prompts before they reach the ACP session, so every client (web, desktop,
 * mobile) can drive the behavior without client-side changes.
 */
export type KimiSyntheticCommand = "plan" | "goal";

export interface KimiSyntheticCommandDefinition {
  readonly command: KimiSyntheticCommand;
  readonly description: string;
  readonly inputHint: string;
}

/**
 * Order matters: the composer lists commands in this order. Native Kimi
 * commands always win on a name clash, so these only fill the gaps.
 */
export const KIMI_SYNTHETIC_COMMANDS: ReadonlyArray<KimiSyntheticCommandDefinition> = [
  {
    command: "plan",
    description: "Plan the given task read-only for this turn, then return to the thread mode.",
    inputHint: "what to plan",
  },
  {
    command: "goal",
    description: "Create a goal Kimi keeps working toward across turns.",
    inputHint: "objective, optionally with a completion criterion",
  },
];

/** Matches a leading synthetic command with its argument text, if any. */
const KIMI_SYNTHETIC_COMMAND_PATTERN = /^\/(plan|goal)(?:\s+([\s\S]+))?$/;

export interface KimiSyntheticPrompt {
  readonly command: KimiSyntheticCommand;
  readonly args: string;
}

/**
 * Recognizes a prompt that starts with a synthetic Kimi command. The match is
 * anchored to the whole prompt so questions that merely mention a command are
 * forwarded to Kimi unchanged.
 */
export function matchKimiSyntheticPrompt(rawPrompt: string): KimiSyntheticPrompt | undefined {
  const match = KIMI_SYNTHETIC_COMMAND_PATTERN.exec(rawPrompt.trim());
  if (!match) {
    return undefined;
  }
  return {
    command: match[1] as KimiSyntheticCommand,
    args: (match[2] ?? "").trim(),
  };
}

/**
 * Maps the synthetic `/goal` command onto Kimi's own advertised
 * `write-goal` command — the same goal-authoring flow Kimi's TUI runs when
 * a prompt is turned into a goal. Kimi executes it natively; the user's
 * prompt is forwarded verbatim.
 */
export function buildKimiGoalPrompt(args: string): string {
  return `/write-goal ${args}`;
}

/** True when a tool_call notification belongs to Kimi's cron scheduler. */
export function isKimiCronToolTitle(title: string | undefined | null): boolean {
  return title === "CronCreate" || title === "CronDelete" || title === "CronUpdate";
}

export interface KimiCronCreateArgs {
  readonly cron: string;
  readonly prompt: string;
  readonly recurring: boolean;
}

/** Parses the streamed `rawInput` of a Kimi CronCreate tool call. */
export function parseKimiCronCreateArgs(raw: unknown): KimiCronCreateArgs | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.cron !== "string" || typeof record.prompt !== "string") {
    return undefined;
  }
  return { cron: record.cron, prompt: record.prompt, recurring: record.recurring === true };
}

export interface KimiCronCreateResult {
  readonly jobId: string | undefined;
  readonly cron: string | undefined;
  readonly recurring: boolean;
  readonly nextFireAt: Date | undefined;
}

/** Parses the `key: value` result block of a completed Kimi CronCreate call. */
export function parseKimiCronCreateResult(contentText: string): KimiCronCreateResult {
  const result: { jobId?: string; cron?: string; recurring?: boolean; nextFireAt?: Date } = {
    recurring: false,
  };
  for (const line of contentText.split("\n")) {
    const match = /^([a-zA-Z]+):\s*(.+)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    const [, key, value] = match;
    if (key === undefined || value === undefined) {
      continue;
    }
    if (key === "id") {
      result.jobId = value;
    } else if (key === "cron") {
      result.cron = value;
    } else if (key === "recurring") {
      result.recurring = value === "true";
    } else if (key === "nextFireAt") {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        result.nextFireAt = parsed;
      }
    }
  }
  return result as KimiCronCreateResult;
}

/**
 * Rebuilds the `<cron-fire>` envelope Kimi's TUI delivers when a cron fires.
 * The mirrored fire reuses the exact format so the agent sees a familiar
 * prompt.
 */
export function buildKimiCronFireEnvelope(input: {
  readonly jobId: string;
  readonly cron: string;
  readonly prompt: string;
  readonly recurring: boolean;
}): string {
  return [
    `<cron-fire jobId="${input.jobId}" cron="${input.cron}" recurring="${input.recurring}" coalescedCount="1" stale="false">`,
    "<prompt>",
    input.prompt,
    "</prompt>",
    "</cron-fire>",
  ].join("\n");
}

function parseKimiCronField(field: string): ((value: number) => boolean) | undefined {
  if (field === "*") {
    return () => true;
  }
  const stepMatch = /^\*\/(\d+)$/.exec(field);
  if (stepMatch) {
    const step = Number(stepMatch[1]);
    if (step <= 0) {
      return undefined;
    }
    return (value) => value % step === 0;
  }
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const low = Number(range[1]);
      const high = Number(range[2]);
      if (high < low) {
        return undefined;
      }
      for (let value = low; value <= high; value++) {
        values.add(value);
      }
      continue;
    }
    if (!/^\d+$/.test(part)) {
      return undefined;
    }
    values.add(Number(part));
  }
  return (value) => values.has(value);
}

/**
 * Computes the next fire time of a 5-field cron expression (minute hour
 * day-of-month month day-of-week, local time) after `after`. Restricted
 * day-of-month and day-of-week follow standard cron's OR semantics.
 */
export function nextKimiCronFire(cron: string, after: Date): Date | undefined {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    return undefined;
  }
  const minute = parseKimiCronField(fields[0]!);
  const hour = parseKimiCronField(fields[1]!);
  const dayOfMonth = parseKimiCronField(fields[2]!);
  const month = parseKimiCronField(fields[3]!);
  const dayOfWeek = parseKimiCronField(fields[4]!);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
    return undefined;
  }
  const cursor = new Date(after.getTime());
  cursor.setSeconds(0, 0);
  for (let step = 0; step < 366 * 24 * 60; step++) {
    cursor.setMinutes(cursor.getMinutes() + 1);
    if (!month(cursor.getMonth() + 1) || !hour(cursor.getHours()) || !minute(cursor.getMinutes())) {
      continue;
    }
    const domRestricted = fields[2] !== "*";
    const dowRestricted = fields[4] !== "*";
    const dayOk =
      domRestricted && dowRestricted
        ? dayOfMonth(cursor.getDate()) || dayOfWeek(cursor.getDay())
        : dayOfMonth(cursor.getDate()) && dayOfWeek(cursor.getDay());
    if (!dayOk) {
      continue;
    }
    return new Date(cursor.getTime());
  }
  return undefined;
}
