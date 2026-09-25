// @effect-diagnostics globalDate:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeOS from "node:os";

import {
  buildKimiCronFireEnvelope,
  buildKimiGoalPrompt,
  classifyKimiSubagentLabel,
  findKimiPlanMode,
  KIMI_DEFAULT_MODEL_SLUG,
  KIMI_SYNTHETIC_COMMANDS,
  isKimiAlreadyInPlanModeError,
  isKimiCronToolTitle,
  matchKimiSyntheticPrompt,
  nextKimiCronFire,
  parseKimiCronCreateArgs,
  parseKimiCronCreateResult,
  resolveKimiAcpBaseModelId,
  resolveKimiCredentialsPath,
  resolveRequestedKimiModeId,
} from "./KimiAcpSupport.ts";

const KIMI_MODES = [
  { id: "default", name: "Default" },
  { id: "plan", name: "Plan" },
  { id: "auto", name: "Auto" },
  { id: "yolo", name: "YOLO" },
];

const modeState = (currentModeId: string = "default") => ({
  currentModeId,
  availableModes: KIMI_MODES,
});

describe("resolveKimiCredentialsPath", () => {
  it("honors KIMI_CODE_HOME and never reads the token file", () => {
    expect(resolveKimiCredentialsPath({ KIMI_CODE_HOME: "/custom/kimi-home" })).toBe(
      "/custom/kimi-home/credentials/kimi-code.json",
    );
  });

  it("falls back to ~/.kimi-code", () => {
    const path = resolveKimiCredentialsPath({});
    expect(path).toContain(".kimi-code");
    expect(path.endsWith("credentials/kimi-code.json")).toBe(true);
  });

  it("expands a leading ~/ in KIMI_CODE_HOME against the real home", () => {
    const home = NodeOS.homedir();
    expect(resolveKimiCredentialsPath({ KIMI_CODE_HOME: "~/.kimi-code" })).toBe(
      `${home}/.kimi-code/credentials/kimi-code.json`,
    );
    expect(resolveKimiCredentialsPath({ KIMI_CODE_HOME: "~" })).toBe(
      `${home}/credentials/kimi-code.json`,
    );
  });

  it("keeps non-tilde overrides verbatim", () => {
    expect(resolveKimiCredentialsPath({ KIMI_CODE_HOME: "/data/kimi" })).toBe(
      "/data/kimi/credentials/kimi-code.json",
    );
    // A ~ not at the start is an ordinary directory name, not a home alias.
    expect(resolveKimiCredentialsPath({ KIMI_CODE_HOME: "/srv/~/kimi" })).toBe(
      "/srv/~/kimi/credentials/kimi-code.json",
    );
  });
});

describe("resolveKimiAcpBaseModelId", () => {
  it("keeps Kimi's provider-owned model ids verbatim", () => {
    expect(resolveKimiAcpBaseModelId("kimi-code/k3-256k")).toBe("kimi-code/k3-256k");
  });

  it("falls back to the default Kimi model for empty input", () => {
    expect(resolveKimiAcpBaseModelId(undefined)).toBe(KIMI_DEFAULT_MODEL_SLUG);
    expect(resolveKimiAcpBaseModelId("   ")).toBe(KIMI_DEFAULT_MODEL_SLUG);
    expect(KIMI_DEFAULT_MODEL_SLUG).toBe("kimi-code/kimi-for-coding");
  });
});

describe("resolveRequestedKimiModeId", () => {
  it("maps the plan interaction mode onto Kimi's plan mode", () => {
    expect(
      resolveRequestedKimiModeId({
        interactionMode: "plan",
        runtimeMode: "auto",
        modeState: modeState(),
      }),
    ).toBe("plan");
  });

  it("maps runtime modes onto Kimi's live mode ids", () => {
    const cases: ReadonlyArray<[string, string]> = [
      ["approval-required", "default"],
      ["auto-accept-edits", "auto"],
      ["auto", "auto"],
      ["full-access", "yolo"],
    ];
    for (const [runtimeMode, expected] of cases) {
      expect(
        resolveRequestedKimiModeId({
          interactionMode: undefined,
          runtimeMode: runtimeMode as never,
          modeState: modeState(),
        }),
      ).toBe(expected);
    }
  });

  it("resolves against the live session modes instead of hardcoding ids", () => {
    const renamed = {
      currentModeId: "safe",
      availableModes: [
        { id: "safe", name: "Default" },
        { id: "deep-thought", name: "Plan" },
        { id: "fast", name: "Auto" },
        { id: "chaos", name: "YOLO" },
      ],
    };
    expect(
      resolveRequestedKimiModeId({
        interactionMode: "plan",
        runtimeMode: "approval-required",
        modeState: renamed,
      }),
    ).toBe("deep-thought");
    expect(
      resolveRequestedKimiModeId({
        interactionMode: undefined,
        runtimeMode: "full-access",
        modeState: renamed,
      }),
    ).toBe("chaos");
  });

  it("keeps the current mode when no advertised mode matches", () => {
    expect(
      resolveRequestedKimiModeId({
        interactionMode: "plan",
        runtimeMode: "full-access",
        modeState: {
          currentModeId: "default",
          availableModes: [{ id: "default", name: "Default" }],
        },
      }),
    ).toBe("default");
  });

  it("returns undefined without mode state", () => {
    expect(
      resolveRequestedKimiModeId({
        interactionMode: "plan",
        runtimeMode: "full-access",
        modeState: undefined,
      }),
    ).toBeUndefined();
  });
});

describe("classifyKimiSubagentLabel", () => {
  it("classifies Agent and AgentSwarm tool calls by title", () => {
    expect(classifyKimiSubagentLabel("Agent")).toBe("Subagent");
    expect(classifyKimiSubagentLabel(" Agent ")).toBe("Subagent");
    expect(classifyKimiSubagentLabel("agent")).toBe("Subagent");
    expect(classifyKimiSubagentLabel("AgentSwarm")).toBe("Agent swarm");
    expect(classifyKimiSubagentLabel("agentswarm")).toBe("Agent swarm");
  });

  it("leaves ordinary tool calls alone", () => {
    expect(classifyKimiSubagentLabel("Read")).toBeUndefined();
    expect(classifyKimiSubagentLabel(undefined)).toBeUndefined();
    expect(classifyKimiSubagentLabel("")).toBeUndefined();
    expect(classifyKimiSubagentLabel("Subagent")).toBeUndefined();
  });
});

describe("matchKimiSyntheticPrompt", () => {
  it("matches /plan and /goal with their arguments", () => {
    expect(matchKimiSyntheticPrompt("/plan write the parser tests")).toEqual({
      command: "plan",
      args: "write the parser tests",
    });
    expect(matchKimiSyntheticPrompt("/goal ship 1.0 by friday")).toEqual({
      command: "goal",
      args: "ship 1.0 by friday",
    });
  });

  it("matches a bare command with empty arguments", () => {
    expect(matchKimiSyntheticPrompt("/plan")).toEqual({ command: "plan", args: "" });
    expect(matchKimiSyntheticPrompt("  /goal  ")).toEqual({ command: "goal", args: "" });
  });

  it("keeps ordinary prompts and command mentions untouched", () => {
    expect(matchKimiSyntheticPrompt("how does /goal work?")).toBeUndefined();
    expect(matchKimiSyntheticPrompt("explain /plan mode")).toBeUndefined();
    expect(matchKimiSyntheticPrompt("/compact")).toBeUndefined();
    expect(matchKimiSyntheticPrompt("")).toBeUndefined();
  });
});

describe("findKimiPlanMode", () => {
  it("resolves the plan mode by alias", () => {
    expect(findKimiPlanMode(modeState("default"))?.id).toBe("plan");
  });

  it("returns undefined when no plan mode is advertised", () => {
    expect(
      findKimiPlanMode({
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Default" },
          { id: "auto", name: "Auto" },
        ],
      }),
    ).toBeUndefined();
  });
});

describe("buildKimiGoalPrompt", () => {
  it("maps the objective onto Kimi's native write-goal command", () => {
    expect(buildKimiGoalPrompt("ship 1.0 by friday")).toBe("/write-goal ship 1.0 by friday");
  });
});

describe("KIMI_SYNTHETIC_COMMANDS", () => {
  it("covers exactly the TUI commands ACP cannot reach", () => {
    expect(KIMI_SYNTHETIC_COMMANDS.map((definition) => definition.command)).toEqual([
      "plan",
      "goal",
    ]);
    for (const definition of KIMI_SYNTHETIC_COMMANDS) {
      expect(definition.description.length).toBeGreaterThan(0);
      expect(definition.inputHint.length).toBeGreaterThan(0);
    }
  });
});

describe("isKimiAlreadyInPlanModeError", () => {
  it("matches Kimi's bogus already-in-plan-mode response", () => {
    expect(isKimiAlreadyInPlanModeError("Internal error: Already in plan mode")).toBe(true);
    expect(isKimiAlreadyInPlanModeError("Already in plan mode")).toBe(true);
  });

  it("leaves real failures alone", () => {
    expect(isKimiAlreadyInPlanModeError("Internal error")).toBe(false);
    expect(isKimiAlreadyInPlanModeError("")).toBe(false);
  });
});

describe("cron mirror helpers", () => {
  describe("isKimiCronToolTitle", () => {
    it("accepts the three cron tool titles", () => {
      expect(isKimiCronToolTitle("CronCreate")).toBe(true);
      expect(isKimiCronToolTitle("CronDelete")).toBe(true);
      expect(isKimiCronToolTitle("CronUpdate")).toBe(true);
    });

    it("rejects other titles case-sensitively", () => {
      expect(isKimiCronToolTitle("croncreate")).toBe(false);
      expect(isKimiCronToolTitle("CronList")).toBe(false);
      expect(isKimiCronToolTitle("CronCreateEx")).toBe(false);
      expect(isKimiCronToolTitle("")).toBe(false);
      expect(isKimiCronToolTitle(undefined)).toBe(false);
      expect(isKimiCronToolTitle(null)).toBe(false);
    });
  });

  describe("parseKimiCronCreateArgs", () => {
    it("parses a well-formed rawInput", () => {
      expect(
        parseKimiCronCreateArgs({
          cron: "0 9 * * 1-5",
          prompt: "standup",
          recurring: true,
        }),
      ).toEqual({ cron: "0 9 * * 1-5", prompt: "standup", recurring: true });
    });

    it("defaults recurring to false when absent or not literally true", () => {
      expect(parseKimiCronCreateArgs({ cron: "* * * * *", prompt: "tick" })).toEqual({
        cron: "* * * * *",
        prompt: "tick",
        recurring: false,
      });
      expect(
        parseKimiCronCreateArgs({ cron: "* * * * *", prompt: "tick", recurring: "true" }),
      ).toEqual({ cron: "* * * * *", prompt: "tick", recurring: false });
    });

    it("returns undefined for non-object rawInput", () => {
      expect(parseKimiCronCreateArgs(undefined)).toBeUndefined();
      expect(parseKimiCronCreateArgs(null)).toBeUndefined();
      expect(parseKimiCronCreateArgs("0 9 * * *")).toBeUndefined();
      expect(parseKimiCronCreateArgs(42)).toBeUndefined();
      expect(parseKimiCronCreateArgs(true)).toBeUndefined();
    });

    it("returns undefined when cron or prompt is missing or not a string", () => {
      expect(parseKimiCronCreateArgs({ prompt: "tick" })).toBeUndefined();
      expect(parseKimiCronCreateArgs({ cron: "* * * * *" })).toBeUndefined();
      expect(parseKimiCronCreateArgs({ cron: 5, prompt: "tick" })).toBeUndefined();
      expect(parseKimiCronCreateArgs({ cron: "* * * * *", prompt: null })).toBeUndefined();
      expect(parseKimiCronCreateArgs({})).toBeUndefined();
    });
  });

  describe("parseKimiCronCreateResult", () => {
    it("parses a complete result block", () => {
      const parsed = parseKimiCronCreateResult(
        [
          "id: 01JABC123",
          "cron: 0 9 * * 1-5",
          "recurring: true",
          "nextFireAt: 2026-09-25T09:00:00.000Z",
        ].join("\n"),
      );
      expect(parsed.jobId).toBe("01JABC123");
      expect(parsed.cron).toBe("0 9 * * 1-5");
      expect(parsed.recurring).toBe(true);
      expect(parsed.nextFireAt).toEqual(new Date("2026-09-25T09:00:00.000Z"));
    });

    it("returns empty defaults for empty text", () => {
      expect(parseKimiCronCreateResult("")).toEqual({
        jobId: undefined,
        cron: undefined,
        recurring: false,
        nextFireAt: undefined,
      });
    });

    it("skips invalid dates and leaves recurring false unless exactly true", () => {
      const parsed = parseKimiCronCreateResult(
        "nextFireAt: not-a-date\nrecurring: yes\nid: 01JXYZ\n",
      );
      expect(parsed.nextFireAt).toBeUndefined();
      expect(parsed.recurring).toBe(false);
      expect(parsed.jobId).toBe("01JXYZ");
    });

    it("ignores lines that are not key: value pairs", () => {
      const parsed = parseKimiCronCreateResult(
        ["Created cron job", "id:", "id: 01JOK", "  cron: 0 0 * * *  "].join("\n"),
      );
      expect(parsed.jobId).toBe("01JOK");
      expect(parsed.cron).toBe("0 0 * * *");
    });
  });

  describe("buildKimiCronFireEnvelope", () => {
    it("builds the exact five-line envelope", () => {
      expect(
        buildKimiCronFireEnvelope({
          jobId: "01JABC",
          cron: "0 9 * * 1-5",
          prompt: "run the standup check",
          recurring: true,
        }),
      ).toBe(
        [
          '<cron-fire jobId="01JABC" cron="0 9 * * 1-5" recurring="true" coalescedCount="1" stale="false">',
          "<prompt>",
          "run the standup check",
          "</prompt>",
          "</cron-fire>",
        ].join("\n"),
      );
    });

    it("embeds the prompt verbatim, including quotes and newlines", () => {
      const prompt = 'say "hi"\nand <bye>';
      const envelope = buildKimiCronFireEnvelope({
        jobId: "01JQ",
        cron: "* * * * *",
        prompt,
        recurring: false,
      });
      expect(envelope).toBe(
        [
          '<cron-fire jobId="01JQ" cron="* * * * *" recurring="false" coalescedCount="1" stale="false">',
          "<prompt>",
          prompt,
          "</prompt>",
          "</cron-fire>",
        ].join("\n"),
      );
      expect(envelope.split("\n").length).toBe(6);
    });
  });

  describe("nextKimiCronFire", () => {
    it("fires every minute for a fully starred expression", () => {
      const after = new Date(2026, 8, 24, 10, 7, 42);
      const next = nextKimiCronFire("* * * * *", after);
      expect(next).toEqual(new Date(2026, 8, 24, 10, 8, 0));
    });

    it("resolves exact minute and hour fields", () => {
      const after = new Date(2026, 8, 24, 10, 7, 0);
      expect(nextKimiCronFire("30 9 * * *", after)).toEqual(new Date(2026, 8, 25, 9, 30, 0));
    });

    it("supports step, range, and list fields", () => {
      const after = new Date(2026, 8, 24, 10, 7, 0);
      expect(nextKimiCronFire("*/15 * * * *", after)).toEqual(new Date(2026, 8, 24, 10, 15, 0));
      expect(nextKimiCronFire("0 9-17 * * *", after)).toEqual(new Date(2026, 8, 24, 11, 0, 0));
      expect(nextKimiCronFire("8,10 * * * *", after)).toEqual(new Date(2026, 8, 24, 10, 8, 0));
    });

    it("applies OR semantics when both day-of-month and day-of-week are restricted", () => {
      const after = new Date(2026, 0, 1, 12, 0, 0);
      const next = nextKimiCronFire("0 12 15 * 3", after);
      expect(next).toEqual(new Date(2026, 0, 7, 12, 0, 0));
    });

    it("applies AND semantics when only one day field is restricted", () => {
      const after = new Date(2026, 0, 1, 12, 0, 0);
      expect(nextKimiCronFire("0 12 15 * *", after)).toEqual(new Date(2026, 0, 15, 12, 0, 0));
      const thursday = new Date(2026, 0, 1, 12, 0, 0);
      expect(nextKimiCronFire("0 12 * * 4", thursday)).toEqual(new Date(2026, 0, 8, 12, 0, 0));
    });

    it("returns undefined for invalid expressions", () => {
      const after = new Date(2026, 8, 24, 10, 0, 0);
      expect(nextKimiCronFire("0 9 * *", after)).toBeUndefined();
      expect(nextKimiCronFire("x 9 * * *", after)).toBeUndefined();
      expect(nextKimiCronFire("*/0 * * * *", after)).toBeUndefined();
      expect(nextKimiCronFire("5-1 * * * *", after)).toBeUndefined();
      expect(nextKimiCronFire("   ", after)).toBeUndefined();
    });

    it("returns undefined when nothing matches within a year", () => {
      expect(nextKimiCronFire("0 0 29 2 *", new Date(2023, 5, 1))).toEqual(
        new Date(2024, 1, 29, 0, 0, 0),
      );
      const after = new Date(2026, 8, 24, 10, 0, 0);
      expect(nextKimiCronFire("0 0 30 2 *", after)).toBeUndefined();
    });
  });
});
