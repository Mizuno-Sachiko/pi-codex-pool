# pi-codex-pool

[English](./README.md) | 简体中文

`pi-codex-pool`是[Pi](https://github.com/earendil-works/pi)的多账号与号池插件，面向ChatGPT Plus/Pro Codex账号。

通过`/subs`管理账号，通过号池模型在多个账号之间分配请求。

## 安装

需要Node.js 24或更新版本，以及最新的Pi版本。

```sh
pi install npm:pi-codex-pool
```

启用前请停用其他号池插件。

## 基本使用

添加账号、登录并查询额度：

```text
/subs add
/subs login
/subs limits
```

创建号池并选择成员账号：

```text
/pool create
/pool models
```

如果号池名为`codex-pool`，模型列表中会出现：

```text
openai-codex-2/gpt-6-astra   # 始终使用这个账号
codex-pool/gpt-6-astra       # 由号池选择账号
```

单号模型始终固定使用指定账号。号池则会根据配置的策略，在成员账号中选择。

## 号池行为

号池默认使用`round-robin`策略，优先选择并发请求较少的账号，并发数相同时按顺序轮换。也可以使用`quota-first`优先选择剩余额度较多的账号，或通过时间表、自定义脚本安排账号使用。

执行工具期间不占用并发名额，后续模型请求会尽量沿用原账号。

额度耗尽或请求限流时会更换账号；服务繁忙时保留所选账号，按Pi全局设置重试。

可以使用以下命令查看和调整号池：

```text
/pool status
/pool concurrency <number>
/pool project
```

每个账号默认允许两个并发模型请求。这个限制由共用同一Pi配置目录的窗口、对话和子代理共同使用。

通过`/subs limits`查询额度。账号发生限额错误时，号池也会更新状态。查询确认账号的订阅额度耗尽后，号池会暂停向该账号分配新请求。

本插件不会主动消耗订阅额度以外的额度。

## 子代理

子代理可以使用与主对话相同的号池模型：

```json
{
  "subagents": {
    "defaultModel": "codex-pool/gpt-6-astra",
    "defaultThinking": "high"
  }
}
```

## 许可证

采用[MIT许可证](./LICENSE)。基于[pi-multi-pass](https://github.com/hjanuschka/pi-multi-pass)和[pi-codex-multi](https://github.com/thelastbodhisattva/pi-codex-multi)开发，保留原版权声明。
