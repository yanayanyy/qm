import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import {
  DEFAULT_AGENT_MODEL_ID,
  auxiliaryModelFor,
  getRequiredModel,
  setProviderBaseUrls,
  setProviderWireModels,
} from "../src/model/pi-models.ts";

test("buildApp injects gateway base url and wire models into model resolution", () => {
  buildApp(
    testConfig({
      providerBaseUrls: { anthropic: "https://gateway.example.com" },
      providerWireModels: {
        anthropic: { slots: { opus: "glm-5.2", haiku: "glm-4.5-air" }, fallback: "glm-5.2" },
      },
    }),
  );
  try {
    const agent = getRequiredModel(DEFAULT_AGENT_MODEL_ID);
    assert.equal(agent.baseUrl, "https://gateway.example.com", "agent model follows the gateway");
    assert.equal(agent.id, "glm-5.2", "agent model id is rewritten to the opus slot wire name");
    assert.equal(agent.contextWindow, 1_000_000, "context window is preserved for budget math");

    const auxId = auxiliaryModelFor(DEFAULT_AGENT_MODEL_ID);
    const aux = getRequiredModel(auxId);
    assert.equal(aux.id, "glm-4.5-air", "auxiliary model follows the haiku slot wire name");
    assert.equal(aux.baseUrl, "https://gateway.example.com", "auxiliary model follows the gateway");
  } finally {
    setProviderBaseUrls({});
    setProviderWireModels({});
  }
});
