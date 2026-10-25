import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { askUserQuestionTool } from "../src/agent/tools.ts";

const prompt = (name: string) => readFileSync(new URL(`../src/agent/prompts/${name}`, import.meta.url), "utf8");

test("teaching discovery keeps attempts ungraded and clues learner-requested", () => {
	const discovery = prompt("teacher/28-predictions.md");
	assert.match(discovery, /ask_user_question.*free text and no options/);
	assert.match(discovery, /Do NOT use `quiz`, `explain`, or `type: "predict"`/);
	assert.match(discovery, /additional clue ONLY when he requests one/);
	assert.match(discovery, /Keep the solution hidden until he reaches the target or explicitly gives up/);
	assert.match(discovery, /On explicit give-up, explain the derivation/);
	assert.match(discovery, /normal post-explanation check/);
	assert.match(discovery, /Probe assessments and practice mechanics are unchanged/);
});

test("shared tool and teaching policies agree on the derivation exception", () => {
	assert.match(prompt("shared/20-question-tools.md"), /Teacher-only exception/);
	const teaching = prompt("teacher/20-teaching.md");
	assert.match(teaching, /free-text `ask_user_question` without options/);
	assert.doesNotMatch(teaching, /use `quiz`, not `ask_user_question`/);
	assert.doesNotMatch(teaching, /ask_user_question.*arrives behind the button/);
	assert.match(prompt("teacher/10-planning.md"), /tasks and clues do not move the map/);
	assert.match(askUserQuestionTool.description, /no committed answer is revealed/);
	assert.match(askUserQuestionTool.description, /pre-explanation derivation task/);
});