# pi-codex-pool

English | [简体中文](./README.zh-CN.md)

A multi-account and account-pool plugin for [Pi](https://github.com/earendil-works/pi), designed for ChatGPT Plus/Pro Codex accounts.

Manage accounts with `/subs` and use pool models to distribute requests across them.

## Install

Requires Node.js 24 or newer and the latest Pi release.

```sh
pi install npm:pi-codex-pool
```

Disable other account-pool plugins before enabling this one.

## Basic usage

Add accounts, log in, and check quotas:

```text
/subs add
/subs login
/subs limits
```

Create a pool and choose its members:

```text
/pool create
/pool models
```

If the pool is named `codex-pool`, its models appear as:

```text
openai-codex-2/gpt-6-astra   # always use this account
codex-pool/gpt-6-astra       # let the pool choose an account
```

A single-account model always uses the specified account. A pool chooses among its members according to the configured strategy.

## Pool behavior

The default `round-robin` strategy prefers accounts with fewer concurrent requests and rotates between accounts with the same request count. Use `quota-first` to prefer accounts with more remaining quota, or arrange account selection with schedules or a custom script.

Tool execution does not occupy a concurrency slot. Follow-up model requests try to keep the same account.

Use these commands to inspect and adjust a pool:

```text
/pool status
/pool concurrency <number>
/pool project
```

The default limit is two concurrent model requests per account and is shared across Pi windows, conversations, and subagents using the same Pi configuration directory.

Check quotas with `/subs limits`. A limit error also updates the pool status. Once a quota check confirms that an account's subscription quota is exhausted, the pool stops assigning new requests to it.

The plugin does not proactively use quota outside the subscription allowance.

## Subagents

A subagent can use the same pool model as the main conversation:

```json
{
  "subagents": {
    "defaultModel": "codex-pool/gpt-6-astra",
    "defaultThinking": "high"
  }
}
```

Foreground subagents that inherit the Pi provider use the same pool. A separately started Pi process must load this plugin as well. Plugins that call an external CLI instead of Pi's provider system are not routed through the pool.

## License

[MIT](./LICENSE). Based on [pi-multi-pass](https://github.com/hjanuschka/pi-multi-pass) and [pi-codex-multi](https://github.com/thelastbodhisattva/pi-codex-multi), with the original copyright notice retained.
