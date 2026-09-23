# e2e-testing

此技能提供：**主模型编排 + ego-browser 固定脚本 + 按需 Jev 判断 + 失败诊断与修复复测**。

技能说明、通用执行器、判定器、场景契约和示例一起分发。项目安装不引用用户主目录，也不依赖某个业务仓库。新增业务只增加项目用例，无需复制一套 runner 或再创建包装技能。

## 安装

采用 [Agent Skills 标准](https://agentskills.io/specification) 和 [Vercel Skills CLI](https://github.com/vercel-labs/skills)。本仓库只有一个技能，名称为 `e2e-testing`。

### 项目安装（团队共享）

在目标项目根目录执行：

```sh
npx skills add kevinqpeng/e2e-testing --skill e2e-testing --agent codex --copy
```

把 `.agents/skills/e2e-testing/` 和生成的 `skills-lock.json` 一起提交。队友克隆后得到完整技能和脚本，不依赖你电脑里的全局文件。`--copy` 明确采用独立文件副本。

### 全局安装（个人使用）

```sh
npx skills add kevinqpeng/e2e-testing --skill e2e-testing --agent codex --global --copy
```

Codex 的该模式安装在 `~/.codex/skills/e2e-testing/`。也可去掉 `--copy` 使用安装器的默认软链接模式。若项目已有同名技能，使用该项目实际加载的副本，不混用两份脚本。

支持安装器提供的其他 Agent，例如把 `--agent codex` 换成 `--agent claude-code`；不同 Agent 的工具连接与执行能力需要分别验证。安装到其他 Agent 不等于浏览器或 Jev 已自动配置。

### 不使用安装器

克隆或下载本仓库，将**整个目录**复制到项目 `.agents/skills/e2e-testing/` 或用户 `~/.codex/skills/e2e-testing/`，而不是只复制 SKILL.md。也可将项目安装目录作为 Git submodule 管理；选择团队熟悉的一种方式即可。

### 更新

```sh
# 只更新本项目的这个技能
npx skills update e2e-testing --project
# 只更新全局的这个技能
npx skills update e2e-testing --global
```

更新后审阅 diff 和锁文件，并运行相关用例。安装命令与目录规则依据 Skills CLI；此包无 npm 运行时依赖，也不要求发布到 npm。

## 使用

在安装后的 Agent 新任务中输入：

```text
使用 $e2e-testing 测试【业务场景】的完整流程，按当前项目规则定义验收，失败时定位原因、在授权范围修复并复测，输出证据报告。
```

例如订单创建到取消、审批申请到生效、奖励配置到发放，均从当前项目契约和真实调用链确定阶段。它们不是预置业务脚本。

## 运行依赖

- Node.js **22.20.0+**（与本次验证的 Skills CLI 要求一致）。
- [Ego Lite / ego-browser](https://lite.ego.app/)：浏览器与 CLI 已安装并可运行。使用前阅读其当前技能/API；平台可用性由 Ego Lite 决定。
- Jev MCP 的 `jev_ask` 或 [TypeSafe API](https://docs.typesafe.ai/api)：仅在需要语义断言时使用；凭证通过宿主工具或环境管理，不写入仓库。

安装本技能不会自动下载浏览器、登录业务系统、安装 MCP 服务或复制 Cookie。纯硬断言用例不依赖 Jev。此 runner 运行 ego-browser 的自定义 API，不是 Playwright API。

## 独立运行示例

项目安装后，在项目根目录执行：

```sh
node .agents/skills/e2e-testing/scripts/runner.mjs \
  --scenario .agents/skills/e2e-testing/examples/page-title.mjs \
  --config .agents/skills/e2e-testing/examples/page-title.json
```

它只检查 example.com 的标题并保存截图，不代表业务 E2E 已完成。业务场景一般保存在 `tests/e2e/`，由主模型基于项目编写；环境地址来自 `--config`，通用包没有固定端口或兄弟仓库路径。

报告默认写到项目 `.e2e-artifacts/<独立运行目录>/`，请将 `.e2e-artifacts/` 加入项目 `.gitignore`。截图和业务证据仅留在本地，人工分享前仍需检查内容。完整接口见 [场景契约](references/scenarios.md)。

状态：`PASS / FAIL / INCONCLUSIVE`，退出码 `0 / 1 / 2`。需要 Jev 的用例在收到真实判断并 finalize 前不会报告通过；低置信度不会自动算通过。

## 包结构与项目场景

```text
e2e-testing/
├── SKILL.md
├── scripts/runner.mjs
├── scripts/judgments.mjs
├── references/scenarios.md
├── examples/page-title.mjs
├── examples/page-title.json
└── tests/runtime.test.mjs
```

添加业务场景时：

每个场景使用自己的目录，脚本、参数、场景说明和数据样例放在一起：

```text
tests/e2e/
├── device-query/
│   ├── scenario.mjs
│   ├── config.example.json # 可选：配置模板
│   ├── config.json       # 本机配置，可加入 .gitignore
│   ├── README.md         # 可选：补充业务前置条件
│   └── fixtures/         # 可选：此场景的数据样例
└── order-flow/
    └── scenario.mjs
```

runner 可直接接收场景目录，自动读取其中的 `scenario.mjs` 和可选 `config.json`。每个脚本导出 `name`、`title` 和 `run(task, config)`。从项目根目录运行，把证据保存在项目的 `.e2e-artifacts/`。项目保留自己的业务断言与数据；全局技能只提供通用 runner 和流程。

## 开发与验证

```sh
npm test
```

测试使用明确标记的离线浏览器/模型替身，验证项目和全局安装目录、唯一证据目录、进程失败、错误与低置信度判断、跨运行响应绑定；不冒充真实浏览器或付费模型测试。真实运行另需满足上述依赖。

MIT License.
