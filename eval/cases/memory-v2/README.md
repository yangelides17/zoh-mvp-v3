# Memory v2 eval cases

These cases need a v2 seed mechanism in the eval harness (extend `seedSchema` to accept
`memoryVersion: "v2"` and v2-shaped memory data, then `seedV2Memory` to create pages/entries
instead of v1 pages/facts). Until that's built, they're placeholder JSON files that document
what each case tests. The v2 seed extension is a small follow-up issue.

| Case | Tests |
|------|-------|
| 001-recall-marco | Knows Marco is the coworker from Forest Park when Sam mentions running with "marc" |
| 002-friends-followup | Brings up the open followup about making friends honestly |
| 003-forget-divorce | Nothing about divorce or Karen, even when Rob mentions Emma's mom |
| 004-add-item-groceries | add_item with a Thursday date, promises only "next time I text you" |
| 005-what-you-know | Honest summary from v2 memory, asks if anything's off |
| 006-sally-rooney-followup | Finds the followup entry about the Sally Rooney book |
| 007-v1-control | V1 tester, unchanged behavior (copied from existing memory cases) |
