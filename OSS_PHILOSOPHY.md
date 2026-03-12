# Open Source Philosophy

## The Position

We open-source everything. Every line of code we write is public. The only things we keep private are runtime credentials — API keys, database passwords, Stripe secrets. The `.env` file is the business. Everything else is just instructions for how to use it.

## Why

Anyone can read the blueprint. Nobody can run it without the keys.

We sell convenience, not secrets. Our code is auditable by anyone — the billing logic, the provisioning system, the inference gateway, all of it. There are no closed doors.

## The Model

We build on open-source software (MIT-licensed). We host it as a managed service for people who'd rather pay than operate it themselves. And we open-source our entire platform layer on top — the hosting infrastructure, the multi-tenancy, the billing integration, the orchestration.

This is the same model as Red Hat, GitLab, Supabase, and PostHog. The difference is most companies keep their platform layer closed. We don't.

## The Math

- **87 public repositories, zero private.**
- Every plugin, SDK, adapter, deployment tool, and platform component is public.
- The only moat is execution: the brand, the ops, being first with a polished hosted offering.

## What This Means

- If you want to self-host, you can. The entire stack is right here.
- If you want to fork us and compete, you can. Our own license allows it.
- If you want to contribute, we welcome it.
- If you'd rather just pay us to run it for you, that's what we're here for.

## On Building On Others' OSS

We build on MIT-licensed open-source projects. The MIT license explicitly grants the right to use, copy, modify, merge, publish, distribute, sublicense, and sell copies of the software. The only obligation is preserving the copyright notice, which we do.

We go further than the license requires — we open-source every improvement, tool, and platform component we build on top. Anyone, including the original maintainers, is free to use any of it.
