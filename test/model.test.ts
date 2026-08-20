import { test } from "node:test";
import assert from "node:assert/strict";
import { toBpmn, externalJobTypes } from "@nanobpm/workflow";
import { JobTypes, researchAgentFlow } from "../src/model/research-agent.ts";

/**
 * The model derivation is a pure function of the code, so these assertions are
 * fully deterministic — no engine, no clock. They pin the shape the epic's
 * expressible-subset design promises: agent tasks with prompt bindings, a
 * parallel fork/join, a durable loop, a human gate, and a non-interrupting SLA.
 */

test("derives exactly the agent job types the workers poll", () => {
  const types = externalJobTypes(researchAgentFlow()).sort();
  assert.deepEqual(types, Object.values(JobTypes).sort());
});

test("derivation is stable (same code → identical BPMN)", () => {
  assert.equal(toBpmn(researchAgentFlow()), toBpmn(researchAgentFlow()));
});

test("emits the block-structured control-flow the model describes", () => {
  const xml = toBpmn(researchAgentFlow());
  // parallel fan-out over the two retrieval agents
  assert.ok(xml.includes("parallelGateway"), "parallel gateway");
  // the human-in-the-loop approval gate
  assert.ok(xml.includes("userTask"), "user task");
  // the non-interrupting SLA boundary on synthesize
  assert.ok(xml.includes("boundaryEvent"), "boundary event");
  assert.ok(xml.includes('cancelActivity="false"'), "non-interrupting boundary");
  assert.ok(xml.includes("timerEventDefinition"), "timer event definition");
  // an exclusive gateway for the verdict switch
  assert.ok(xml.includes("exclusiveGateway"), "exclusive gateway");
});

test("binds LLM prompt resources to the agent tasks", () => {
  const xml = toBpmn(researchAgentFlow());
  assert.ok(xml.includes('linkName="prompt"'), "linked prompt resource");
  assert.ok(xml.includes('resourceId="classify.md"'), "classify prompt");
  assert.ok(xml.includes('resourceId="synthesize.md"'), "synthesize prompt");
  // the appended-topic FEEL feeds a zeebe:ioMapping appendPrompt input
  assert.ok(xml.includes("appendPrompt"), "append prompt io");
});

test("wires the taskDefinition types to the capability tokens", () => {
  const xml = toBpmn(researchAgentFlow());
  assert.ok(xml.includes(`type="${JobTypes.classify}"`));
  assert.ok(xml.includes(`type="${JobTypes.publish}"`));
});
