# DeepSeek Router (DSH Standard) — SillyTavern 移植版

把 [yjh051108/dsh-router-standard](https://github.com/yjh051108/dsh-router-standard)（DeepSeek Harness 的任务感知推理模式路由器）移植为 SillyTavern UI 扩展，在酒馆里对 DeepSeek 系模型实现同效果的提示层优化。

界面默认中文（酒馆语言为 English 时自动切换英文）；详细用法见 **[使用说明](使用说明.md)**。

上游的核心实测结论：DeepSeek 模型沿 react↔spec 轴的行为是**量子化的三个稳定档位**（spec 深度推理 / mixed 摇摆 / react 快循环），档位之间存在相变，而触发主导因素是**一句 persona 系统提示**；档位选择必须由外部决定——模型自己不可信。本扩展把这套路由机制搬到酒馆的最终提示数组上。

## 机制映射

| 上游（DSH 插件） | 本扩展（酒馆） |
| --- | --- |
| 首个模型请求注入 persona | `CHAT_COMPLETION_PROMPT_READY` 钩子改写最终消息数组（每次生成都幂等重放，酒馆的提示装配是无状态的） |
| 会话首条用户消息分类（spec/react/weak） | 对**存储聊天**的首条用户消息分类（跳过角色示例对话），结果锁定在该聊天的 metadata 中 |
| persona 句按模型族选择（v4-pro 强吸引子 / v4-flash 弱吸引子 / kimi·qwen 等弱分类器族） | 同一套 `PERSONAS` 表 + `modelFamily()` 从当前连接的模型 ID 识别 |
| standard 模式：系统提示还原为 RL 训练句 | 同名模式：把最终提示里**所有 system 消息折叠为一句** `You are a helpful software engineer assistant.` |
| 反空转锚点（距窗口尾 8/20/36 条用户消息处追加 `[n]: ...`） | 同一套锚点；窗口几何改为用最终消息数组计算（酒馆已按 token 预算裁剪过该数组） |
| 深度自适应引导（react/weak 快收敛 / spec 决断收束） | 同一套引导句，作为末尾 system 消息注入 |
| 首次持久工具调用后路由器停机 | 不适用（酒馆无工具面）；改为分类一次锁定、可手动重分类 |

## 安装

**扩展面板安装（推荐）**：酒馆「扩展」→ Install extension → 填 `https://github.com/nevermindblackarts-sketch/st-deepseek-router`，重启酒馆或刷新页面后在「扩展」面板中看到 **DeepSeek Router (DSH Standard)**。

手动安装：

```sh
cd <酒馆目录>/public/scripts/extensions/third-party
git clone https://github.com/nevermindblackarts-sketch/st-deepseek-router
```

注意：仓库名即扩展目录名（`st-deepseek-router`），改动模板路径时需保持一致。运行测试：`npm test`（Node 20+，21 个用例）。

## 使用

面板第一项是**总开关**（标题旁常显 启用中/已停用 徽标），关闭即停止一切注入。默认模式 `auto`：每个聊天首次生成时，取首条用户消息分类出 spec / react / weak，锁定档位并注入对应 persona 句。可切换：模式（auto / spec / react / weak / standard）、注入位置、锚点与收敛引导开关（引导行并入最后一条用户消息，操作约束不占 system 面）、实验性思维链格式约束（默认关，仅思考型模型，文本可自定义）、persona 覆写，并实时显示路由状态。

⚠️ **standard 模式会把所有 system 消息替换为 RL 训练句，角色卡不会到达模型**——只适合纯助手/工具型用法，RP 聊天勿开。

各项设置的详细说明、按用途选模式的建议、persona 覆写写法与 FAQ 见 **[使用说明](使用说明.md)**。

## 与上游的差异

1. `router-core.js` 为逐字移植，仅两处改动：锚点/引导的窗口几何改由最终提示数组计算（上游用 token 配置估算）；`WEAK_RE` 修复了 `\b` 包裹中文分支导致永不匹配的问题（`\b` 对非 ASCII 字符不成立），中文问候/总结/轻任务现在能正确分到 weak 档。
2. 新增 `replaceSystemWithCore`（standard 模式的系统消息折叠）。
3. 上游的首次工具调用停机、dev_router_status 状态命令、工具面注入不适用酒馆，未移植；状态改为面板实时显示。

## 许可

MIT。上游路由逻辑版权 (c) 2026 yjh051108（[dsh-router-standard](https://github.com/yjh051108/dsh-router-standard)），移植部分同许可证。
