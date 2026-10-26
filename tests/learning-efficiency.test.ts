import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const prompt = (file: string) => read(`src/agent/prompts/${file}`);

test("the shared objective values durable learning per time, not effort or haste", () => {
  const system = read("src/agent/system-prompt.md");
  assert.match(system, /Optimize durable, usable learning gained per learner time spent/);
  assert.match(system, /not learning per unit of effort/);
  assert.match(system, /Preserve productive struggle when its learning gain justifies his time/);
  assert.match(system, /impose no time or attempt limit/);
  assert.match(system, /every-step graded checks, the final synthesis exercise, and required practice retests/);
  assert.match(prompt("teacher/05-method.md"), /shortest effective route/);
  assert.doesNotMatch(prompt("teacher/05-method.md"), /there is no schedule to keep and nothing to rush/);
});

test("probing stops once the goal prerequisites are demonstrated", () => {
  const probe = prompt("prober/10-probe-doctrine.md");
  assert.match(probe, /sufficient prerequisites for the goal, no failure ceiling is needed/);
  assert.match(probe, /not exhaustive measurement or ever-harder questions/);
});

test("practice and presentation optimize learning yield rather than throughput", () => {
  const practice = prompt("practice/10-doctrine.md");
  assert.match(practice, /decision points per minute only as a design proxy/);
  assert.match(practice, /never hurry attempts to improve throughput/);
  assert.match(practice, /least revealing help that actually unblocks/);
  assert.match(practice, /retest every miss, every hint-heavy item, and every surrendered problem/);
  assert.match(prompt("shared/40-formatting.md"), /minimum helpful structure/);
  assert.match(prompt("teacher/50-demos.md"), /Dynamic content alone does not require a demo/);
});