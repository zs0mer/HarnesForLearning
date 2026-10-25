<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/lh_banner_dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/lh_banner_light.png">
    <img src="docs/assets/lh_banner_light.png" alt="LearnHarness" width="640">
  </picture>
</p>

<p align="center"><strong>An agent harness for learning.</strong></p>

<p align="center">
  <a href="https://learnharness.ai">Download</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="docs/development.md">Documentation</a> ·
  <a href="https://github.com/amosblomqvist/learnharness/issues">Issues</a>
</p>

LearnHarness uses AI agents to plan and teach lessons from your current understanding to your goal. It builds a detailed picture of what you understand and how you reason. That picture is updated as you learn.

Instead of just giving you an explanation, it uses your answers and thinking to decide what you need next. Teaching builds understanding one reasoning step at a time. Practice makes it usable. A persistent knowledge graph carries it across sessions.

![LearnHarness teaching session](docs/assets/teaching-session.png)

## How it works

1. **Measure.** Before teaching, the agent finds where your understanding ends on each part the lesson depends on. Your answers, confidence, and thinking show it where to start.
2. **Plan.** It works out a dependency map from that starting point to your goal. You can see the plan, and the lesson adapts when your understanding turns out different.
3. **Teach.** Each step builds on something you already understand. You predict, get an explanation, and check your understanding. Confusions are repaired before anything is built on them. The aim is for the goal to feel obviously true, not merely familiar.
4. **Practice.** Separate sessions pose varied problems that require the right knowledge to come to mind without being named first. Problems and hints adapt to your reasoning.

**Think out loud.** The thinking fields let you explain your reasoning, uncertainties, and reactions in your own words. This is how the agent gets a detailed picture rather than just a record of right and wrong answers. You can type or use dictation.

The agent can also research questions in the background, create visual explanations, and build interactive demonstrations.

## Knowledge that carries forward

What you are taught accumulates as propositions and reasoning chains: individual claims and the premises that lead to them. The graph shows this structure, with links back to the source sessions. You can also import notes.

Future teaching sessions can read the graph instead of starting from scratch. Practice sessions can draw their material from it. It stores the ideas and their connections, not ratings of your ability.

Two additional Markdown documents under the data directory's `memory/` folder carry your learner profile:

- **Teaching guide:** how to teach you, including explicit preferences and evidence-grounded adjustments.
- **Knowledge overview:** broad topics rated on a decimal 0–5 scale: 0 unaware, 1 aware of its existence, 2 encountered it and can derive parts, 3 can recall parts and derive most, 4 can recall or derive almost everything, and 5 mastered. Missing topics are unassessed, not zero. Optional confidence describes uncertainty in the assessment, separately from the rating.

Both documents are included in full in each probing, teaching, and practice request. Agents retrieve detailed graph evidence and past session messages selectively; existing session records remain the event history, without duplicate Markdown transcripts.

A separate background updater runs after completed assessments, assessed answers, practice conclusions, and explicit teaching-preference changes. It uses the Cheap model slot unless you choose a dedicated learner-memory model in settings. These are additional provider calls with tracked usage. Missing models or credentials defer updates; teaching continues with the latest committed memory. Existing historical sessions are not automatically backfilled into ratings, and a graph entry alone is not evidence of mastery.

Deleting a session retains its learned preferences, ratings, and notes, but removes that session's memory evidence references—even when its graph traces are deleted. Session deletion is not a “forget learner profile” operation; there is currently no in-app profile-reset control. The external LearnHarness skill can read the profile and retrieve selected history, but does not edit it.

![LearnHarness knowledge graph](docs/assets/knowledge-graph.png)

## Download and get started

**[Download from learnharness.ai](https://learnharness.ai)** · [GitHub Releases](https://github.com/amosblomqvist/learnharness/releases)

- **macOS (Apple Silicon):** signed and notarized DMG. Drag the app to Applications.
- **Windows (x64):** run the installer. It is currently unsigned; Windows may show an “unknown publisher” or SmartScreen warning.
- **Linux (x64):** make the AppImage executable and open it, or install the Debian/Ubuntu `.deb`.

Add your provider API key and choose your models, then start a session with what you want to understand. LearnHarness supports 30+ provider options, including OpenAI, Anthropic, Google, DeepSeek, and OpenRouter. Optional dictation and web search use separate service keys.

**GitHub Copilot subscription (desktop):** open Providers → Subscriptions → Connect GitHub Copilot. Review the consent notice, then enter the displayed device code at GitHub. The SDK uses its bundled OAuth client and may enable eligible model policies. Consent covers interactive lessons and background work. Credentials use OS-backed encrypted storage; only models available to the connected account appear in the picker. Copilot limits and premium-request charges apply; the app displays subscription usage, not inferred API charges. One GitHub.com account is supported at a time; GitHub Enterprise and externally launched development servers are not supported. Disconnect removes local credentials; revoke the app separately in GitHub settings if needed.

All three platforms support in-app updates.

## Your keys, your data

- **Your keys and models.** No LearnHarness subscription or markup. You pay your providers for usage; a live cost meter shows model costs.
- **Local storage.** Your chats, graph, settings, and API keys live on your machine. Learning records are plain files you can inspect.
- **External services.** Models run through your configured providers. Model requests send the context needed for the task; web research and dictation also contact external services. Local storage does not mean offline processing.
- **Inspectable behavior.** System prompts are visible and editable. The app is open source under the AGPL-3.0 license.

## Development and support

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # deterministic, no LLM, no network
```

See the [development guide](docs/development.md), [architecture](docs/architecture.md), and [desktop release guide](docs/desktop-release.md).

Questions, bug reports, and feature requests: [GitHub Issues](https://github.com/amosblomqvist/learnharness/issues).

## License

[AGPL-3.0](LICENSE)

The app is free and open forever. If we ever charge for anything, it will be for convenience — managed keys, hosting — never for features you can run locally.
