# Sightline: Tonight's Checklist (Thu Oct 8)

More architecture work tonight has negative value. Tomorrow's unknowns are runtime unknowns. Do these, then sleep.

## In the bag now
- [ ] **Physical government-issued photo ID** (driver's license, state ID or passport). Student and digital IDs are **not** accepted.
- [ ] Laptop + charger (+ power strip if you have one), phone + charger, headphones with mic.

## Arrival
- [ ] **Leave so you're at 229 W 28th St, 11th floor by 8:00–8:15.** Build-environment access is limited to the **first 100 attendees** (organizer email, 10-08). Being #101 kills the plan before any code exists.

## Accounts (log in once tonight with the accounts you'll use tomorrow)
- [ ] **Luma:** the ticket still shows **Going / You're in**. The "update your RSVP" email is for people who *can't* attend, so don't change anything.
- [ ] **Cursor**, signed in with your registration email. Open https://cursor.com/dashboard/usage: requests should show **Free**. If not, submit the credit form linked in the official README tonight.
- [ ] **W&B** (wandb.ai) login works.
- [ ] **Cosmos Community** (community.vastdata.com) login works. Tomorrow's workshop login sends a **6-digit code to your email**, so make sure that inbox is on your phone.
- [ ] **GitHub:** create the **private** repo `sightline`, push `planning/` + `.gitignore`. Create a fine-grained PAT scoped to `sightline` only (Contents: read/write) and keep it in your password manager. You'll need it (or `gh auth login`) to clone and push from the VM.
- [ ] Video host (YouTube unlisted or Loom) logged in; screen recorder works (QuickTime ⌘⇧5, check the mic).

## Repo baseline
- [ ] Final pull of `vast-data/vast-builders-challenge`: the baseline is **`0c6b756`** (10-08 20:16). The planning docs are already updated for it: kubeconfig is `/config/${NS}-k8s.yaml`, deploy follows the current skill, the `vast-database` skills, `/build-day-quickstart`, and `/ask-cosmos` hand-off.
- [ ] Read `BUILD_DAY_PLAN.md` §4 (morning checklist) and prompts **P0, P0b, P1** once.

## Pitch (2 minutes)
- [ ] Say it out loud 3×: *"Most video AI needs someone to tell it what to look for. Sightline looks first, decides what matters, configures its own analysis, and investigates on its own. Today we pointed it at one problem: dangerous person–vehicle interactions."*

## Optional (only if it takes under 10 minutes)
- [ ] One staged phone clip for the "new footage" beat: a person walks past a slowly moving car or cart in a driveway or garage, with no bystanders. Settings → Camera → Formats → **Most Compatible** (H.264), ≤ 30 s, phone propped still.

## Do NOT do tonight
- Write application code (the event says to build during the event).
- Prepare internet or YouTube footage.
- Keep redesigning the architecture.
