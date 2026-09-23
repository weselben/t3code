import { describe, expect, it } from "@effect/vitest";
import * as NodeOS from "node:os";

import {
  buildKimiGoalPrompt,
  classifyKimiSubagentLabel,
  findKimiPlanMode,
  KIMI_DEFAULT_MODEL_SLUG,
  KIMI_SYNTHETIC_COMMANDS,
  isKimiAlreadyInPlanModeError,
  matchKimiSyntheticPrompt,
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
