import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toDeployableBpmn } from "@nanobpm/workflow";
import { researchAgentFlow } from "../src/model/research-agent.ts";

/** Emit the derived, deployable BPMN (with diagram interchange) so the model
 *  opens rendered in a modeller / Operate. Run: `npm run model:emit`. */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "bpmn", "research-agent.bpmn");

const xml = await toDeployableBpmn(researchAgentFlow());
await mkdir(dirname(out), { recursive: true });
await writeFile(out, xml, "utf8");
console.log(`wrote ${out} (${xml.length} bytes)`);
