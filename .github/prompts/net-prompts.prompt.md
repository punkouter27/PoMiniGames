---
name: "NET Prompts"
description: "Generate 50 prioritized feature, cleanup, graphics, UI/UX, and automation options for PoMiniGames."
argument-hint: "Optional focus area or game"
agent: "agent"
---

Review the project context in [README.md](../../README.md), [CAPABILITY-MAP.md](../../CAPABILITY-MAP.md), and relevant source or documentation before proposing ideas. Generate a prioritized menu of exactly 50 distinct, actionable options, grouped into the five categories below with exactly 10 options per category. Number them consecutively from 1 to 50.

The options are for the existing PoMiniGames product. Make them specific to its games, architecture, and current capabilities; favor production-ready workflows, useful integrations, open-source libraries, and changes that reduce player effort or improve reliability. Do not present generic ideas that could apply to any app. Do not implement anything: the user is choosing which ideas to pursue.

For each numbered option, include a concise title, the player or developer benefit, and a short implementation direction. Prioritize the most valuable options first within each category. Be candid about feasibility and tradeoffs; avoid proposing redundant features or technology for its own sake.

## 1. Features

Give 10 high-value new features or improvements to existing game and platform features. Favor complete player workflows and useful integrations that make the app more useful and easier to use.

## 2. Code cleanup and housekeeping

Give 10 concrete cleanup options, such as removing demonstrably unused files, endpoints, configuration, or dependencies; improving vertical-slice organization; resolving trimming and disposal issues; honoring test ceilings; simplifying UI; or moving advanced settings into the existing settings experience. Do not recommend removal without checking references and user value.

## 3. Graphics and audio

Give 10 technically grounded graphics, animation, physics, or audio options. Consider Web Audio, WebGL/WebGPU, shader effects, collision quality, performance, accessibility, and device support. Prefer ideas that fit the existing rendering and shared audio/effects architecture. Do not recommend costly or unsupported techniques such as ray tracing by default; explain when an option needs a fallback or device capability check.

## 4. UI/UX optimization

Give 10 options that measurably improve navigation, responsiveness, clarity, resilience, or interaction quality. Consider end-to-end workflow checks, prioritized defect logging, localized error recovery, pruning low-value UI, simplified navigation, responsive layouts, Radzen only where it fits existing patterns, consolidated controls, layout stability, micro-interactions, and a subtle build-version stamp.

## 5. AI and automation

Give 10 options for helpful automation, summaries, smart defaults, search, or telemetry. The project currently has no AI services and uses local/scripted game logic; treat introducing AI as an optional product decision, not an assumed direction. Prefer privacy-preserving, low-cost approaches, clearly label external service dependencies and operational costs, and include a non-AI fallback where appropriate.

End with a brief note inviting the user to select option numbers. Do not add a sixth category, extra numbered ideas, or implementation steps.
