# Provider auth topology

This document describes the boundary between the aquarium and provider
credentials. It intentionally contains no account identifiers, hostnames,
credential values, or private filesystem paths.

## The roster is models, not agents

`openclaw` is the agent, not a model. It routes to a model provider. The
aquarium roster is the set of model providers that the bridge reports:

| tank slot | bridge provider key | auth boundary |
|---|---|---|
| jellyfish | `minimax` | provider API key, held by the provider client |
| butterfly | `kimi` | provider subscription or API key |
| crab | `muse-bridge` | local CLI OAuth session |
| snail | `meta` | provider API key or subscription |

## Credentials stay outside this repository

Provider keys, OAuth state, bridge tokens, and hub secrets must remain in the
provider client or local secret store. They are never copied into this repo,
the PSP binary, test fixtures, or documentation.

The bridge reads its upstream secret from `TOKEN_MONITOR_SECRET`, or from the
local Token Monitor credential file when that variable is unset. See
[`.env.example`](../.env.example) for the non-secret configuration surface.

## Bridge tokens are not provider keys

A local bridge token is not interchangeable with a provider API key. Configure
provider authentication in the provider's supported client or Token Monitor;
do not put either value in `TOKEN_MONITOR_SECRET` unless it is specifically
the hub secret expected by the bridge.

## Token Monitor windows

The bridge uses the provider data exposed by Token Monitor and keeps the
session, weekly, and monthly windows distinct. A provider without a quota
window can still report activity, but its quota is displayed as unknown rather
than being invented.

## Operational guidance

- Keep `.env` files local and untracked; commit only `.env.example`.
- Prefer the host's secret manager for production deployments.
- Rotate a credential if it is ever pasted into a public issue, commit, log,
  or chat message.
- Never log authorization headers or the contents of credential files.
