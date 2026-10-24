---
id: fnd_01M5J9Y4MARQKZ4CF6PFA0T7M7
type: finding
title: Expo push tokens expire after reinstall
summary: "After an app reinstall the Expo push token changes, and the server kept sending to dead tokens."
status: active
confidence: human
origin: local
scope: project
valid_from: 2025-09-02
recorded_at: 2025-09-02T09:00:00Z
updated_at: 2025-09-02T09:00:00Z
version: 1
author: sam
about: ["[[Expo]]"]
sources:
  - "url:https://docs.expo.example.org/push 2025-09-01"
  - "commit:b71e0aa 2025-09-02"
---

In a 300 device test, 11% of tokens were dead after one month because users reinstalled or restored phones.
The server only learned a token was dead from a delivery error 24 hours later.
One reason we looked beyond [[Expo]] for push, see [[Send push through Firebase Cloud Messaging directly]].
