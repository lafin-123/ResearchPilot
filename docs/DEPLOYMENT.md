# ResearchPilot 部署与使用教程

> 本项目是本地优先的 **Electron 桌面应用**，不是可直接部署到 Vercel、Nginx 或 Docker 的多用户网站。当前主要验证平台为 Windows x64。本文覆盖源码运行、模型接入、科研环境和 Windows 安装包构建。

## 1. 许可与安全须知

项目自有代码采用 [PolyForm Noncommercial 1.0.0](../LICENSE.md)：按许可证允许的非商业用途使用、修改与分发；许可范围外的商业使用须另获书面授权。它不是允许任意商业使用的 MIT/AGPL 项目。第三方组件仍遵循各自许可证，见 [NOTICE](../NOTICE.md) 和 [第三方声明](../THIRD_PARTY_NOTICES.md)。

- API Key 在应用内配置，不写入源码、`.env`、截图、Issue 或 GitHub。
- 模型调用和网络检索可能收费；用户发送的研究资料可能传给所选服务商。
- 本机代码执行不是操作系统沙箱。核对实验代码、数据权限和来源后再批准。
- 默认只启动本地桥接，不将端口开放到公网，不把桌面用户目录作为服务器共享目录。

## 2. 系统要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows 10/11 x64；本轮验证 Windows 11 |
| Node.js | **24 LTS 或更新且兼容的版本**，需要 `node:sqlite` |
| 包管理器 | Node 附带的 npm；使用仓库 `package-lock.json` |
| Git | 下载/更新源码时使用，也可下载 GitHub 源码 ZIP |
| Python | 基础界面不需要；实验需要 Python **3.10+**，完整流水线需在应用明确指定路径 |
| LaTeX | 仅编译 `.tex` 为 PDF 时需要；DOCX 不依赖 LaTeX |
| 网络 | 安装依赖、模型服务和外部检索时需要 |

macOS/Linux 未提供当前版本的安装包与完整回归保证，不应把 Windows 教程的命令直接当成跨平台交付承诺。

## 3. 获取源码

从本仓库 GitHub 页面点击 **Code → HTTPS** 复制地址，在终端运行 `git clone` 后进入项目根目录；也可 **Download ZIP**，解压到可写的本地目录。后续命令均在包含 `package.json` 的项目根目录执行，不是在父目录或 `src` 中执行。

仓库地址：[lafin-123/ResearchPilot](https://github.com/lafin-123/ResearchPilot)。克隆后进入目录：

```bash
git clone https://github.com/lafin-123/ResearchPilot.git
```

```bash
cd ResearchPilot
```

建议源码目录与个人研究数据目录分开，不放在只读系统目录内。

检查工具版本：

```bash
node --version
```

```bash
npm --version
```

```bash
git --version
```

## 4. 安装依赖与启动

首次安装和按 lockfile 复现安装使用：

```bash
npm ci
```

安装会下载依赖和 Electron，并运行本项目声明的安装脚本。不要跳过失败继续运行，也不要用关闭 TLS 验证来解决网络问题。

当前 `.npmrc` 使用国内 npm/Electron 镜像，`strict-ssl=true`。若所处网络无法访问镜像，可在审阅后改用官方 npm registry 和 Electron 下载源；不要向不可信镜像提供账户凭据。npm 对 `electron_mirror` 等字段可能给出弃用提示，提示本身不等于安装失败，以退出码和 Electron 下载结果为准。

开发启动：

```bash
npm run dev
```

它会先构建本地 MCP 服务，再启动 Electron 与开发构建。首次进入本地工作区无需注册/登录应用账户。关闭终端或应用会停止本次开发运行；未保存的内存草稿应先保存。

生产构建与本机预览：

```bash
npm run build
```

```bash
npm run preview
```

`out/renderer` 只是桌面渲染进程输出，依赖安全预加载与主进程，**不能直接当独立网站发布**。`npm run preview` 不是供公网访问的 SaaS 服务。

## 5. 配置模型 API 与 Key

1. 打开 **模型与设置 → 模型与 API → 添加提供方**。
2. 选择预设或兼容 API，填写正确协议、基础 URL 和自己的 Key。基础 URL 不要包含 `/chat/completions`、`/responses`、`/messages` 或 `/models` 请求尾路径。
3. 点击 **获取上游模型** 或 **获取模型并继续**。应用只查询上游模型列表，不自动发付费推理。
4. 勾选要使用的模型，点击 **保存所选模型**。可设置默认提供方。
5. 如上游不提供列表，可切换 **手动填写模型（可选）**，每行 `model-id` 或 `model-id | 显示名称`，以服务商实际文档为准。
6. **真实调用测试** 是独立操作，会向第一项所选模型发短请求并消耗少量额度；列表可见、Key 已保存不等于模型可推理。

支持应用现有的 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 兼容协议；自定义网关不等于自动支持所有私有协议。公网 API 必须 HTTPS，本机服务可使用 loopback HTTP。模型能力/上下文来自上游明确返回，不根据名称猜测。

### 三角色 Agent

在设置的 **生成参数 → 分角色 Agent** 中，分别选择：

- 写作 Agent：文献综合、论文与期刊修订。
- 绘图 Agent：图表、图注、演示素材。
- 工程与实验 Agent：设计、实现、运行与分析。

每个角色可选不同提供方，各自使用对应的 URL/Key。角色仅引用提供方ID，不把Key复制到提示。配置后点击 **保存生成参数**。未单独配置角色时沿用任务模型；三个角色都有效时不依赖无关默认Key。

科研流水线按阶段串行交接、角色独立会话，不是多角色并发覆盖同一文稿。技能准备只放草稿，用户发送才开始。问询方式可选少打断、关键处询问或先问清楚，但执行/联网/外发审批不被取消。

## 6. Python、MCP 与完整科研流程

### Python

安装官方 Python 3.10+，确认是真实解释器而非 Microsoft Store 占位程序：

```bash
python --version
```

在 **模型与设置 → 运行环境** 保存实际 `python.exe` 路径。示例仅为路径形式，不代表本机一定存在：`C:\Python312\python.exe`。完整流水线必须显式配置可运行解释器；仅检测到 uv 不满足此条件。

所需 numpy/pandas/matplotlib 等依赖按自己的研究环境安装；应用不会替你安装整套深度学习环境。可使用独立虚拟环境，并把该环境解释器路径填入设置。不要把虚拟环境或真实数据提交到本仓库。

### MCP

打开 **MCP 工具连接**，启用随应用打包的三个服务，并主动运行连接测试。测试启动真实本地 stdio 服务，但不调用付费模型。启用不等于连接成功。

- 文献与证据：本地检索、DOI、全文分页、经审批的作者指南获取。
- 文稿与表达：读取、审阅、经审批写稿。
- 实验与图表：运行记录、代码登记/执行、结构化图表和产物。

不在 MCP 配置中填写陌生 shell/npm 安装命令。106个技能是本地方法、模板与检查资源，不意味着所有统计方法已原生实现或依赖已安装。

### 启动研究

在 **使用准备检查** 核对模型/角色、Python、MCP和项目目录。随后输入研究问题和真实数据来源，启动流程。遇到缺失证据、依赖或审批会暂停/失败，不应把未运行结果写进论文。

本地文献、笔记与阅读不要求先配置模型。全文页提取读取关联PDF文字层，扫描页需额外OCR/视觉核对；作者指南抓取仅访问指定公网HTTPS链接，不使用浏览器登录态，不自动跟随重定向。

## 7. LaTeX 与 SSH（按需）

- DOCX和结构化SVG/PPTX不需要LaTeX或Python。
- 需要TeX编译时自行安装TeX Live/MiKTeX，并配置/检测 `xelatex`、`pdflatex` 或 `latexmk`；中文通常需要XeLaTeX及相应宏包。
- SSH仅用于你有权限的远程算力；在应用添加主机和认证信息，第一次连接核对主机指纹。不要将私钥、密码、known_hosts或远程部署文件上传GitHub。
- 依赖、GPU驱动、数据及资源预算在远端预先准备。当前原生自动研究工具的受限本地实验执行不等于自动切换SSH执行。

## 8. 验证安装

不使用真实模型Key的检查：

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run test:e2e
```

端到端需要可用Windows桌面，会启动真实Electron，并在 `test-results/` 创建隔离数据库。请勿在无图形桌面的服务器上把失败简单视为业务故障。测试报告、截图、合成Key与临时数据均不应作为生产配置。

`test:live`、`scripts/live-*.mjs` 和网关探针是维护者可选的真实调用验证，可能收费；不要把它们当普通部署步骤，也不要为了跑通测试在公开仓库填写Key。

## 9. 构建 Windows 安装包

使用Windows x64桌面环境，先确保依赖安装、类型检查和测试通过。仅构建解包目录：

```bash
npm run package:dir
```

构建NSIS安装程序：

```bash
npm run package:win
```

输出在 `release/`，安装包名称形式为 `ResearchPilot-<package.json版本>-setup.exe`。构建需要下载Electron Builder相关工具并可能编译原生模块；如预编译依赖不可用，可能需要Visual Studio C++构建工具/Python环境。源码版本字段不等于已发布Release；以GitHub Release实际附件和校验值为准。

安装包附带 LICENSE、NOTICE和第三方声明。仓库不直接上传 `node_modules`、`out`、`release`；有正式安装包时通过GitHub Releases分发，不将个人工作区打包。当前默认没有代码签名：Windows可能提示未知发布者，应核对发布来源与SHA256，而不是关闭安全软件。

## 10. 数据、备份与升级

- 默认工作区在当前用户文档目录的 `ResearchPilot` 下；项目已有目录不会因修改默认根目录自动迁移。
- 应用数据库/密钥在Electron用户数据目录中（Windows通常在用户AppData下）；具体路径受应用与旧版兼容状态影响，不要直接覆盖。
- 使用 **备份与恢复** 导出单项目 `.rpbackup`，保存到可信位置。它未加密，恢复新建副本；不包含Key、聊天、SSH配置、流水线和隐藏运行配置。
- 升级前保存内存草稿并备份资料；退出应用后再升级，不删除旧用户目录来“修复”启动问题。
- 开发隔离环境变量 `RESEARCHPILOT_USER_DATA` / `RESEARCHPILOT_WORKSPACE_ROOT` 仅用于测试开发，打包应用不接受该覆盖。

## 11. 常见故障

| 症状 | 排查 |
| --- | --- |
| `node:sqlite` 不存在 | 用Node24+，关闭旧终端再检查版本 |
| Electron或依赖下载失败 | 检查代理、镜像和TLS；不要关闭strict-ssl |
| PowerShell阻止npm.ps1 | 可在终端运行 `npm.cmd` 对应命令，不必全局降低执行策略 |
| 模型列表为空 | 核对基础URL、协议、Key和上游列表支持；可手动填真实模型ID |
| HTTP401/403/429 | 检查Key权限/有效期、账户模型授权、额度或限流；不静默换模型 |
| 找不到Python | 显式选择真实解释器，核对3.10+及所需包 |
| 项目目录不可用 | 恢复原目录/权限后在准备检查明确重试；不要创建空目录冒充原资料 |
| LaTeX预览失败 | 检查真实编译日志、工具链和宏包，DOCX仍可独立使用 |
| 指南抓取被拒绝 | 使用最终官方HTTPS链接；禁止私网、登录页面与自动重定向，可提供指南正文 |
| PDF没有提取文字 | 扫描/图像页没有文字层，需OCR或视觉核对；不是已全文核验 |

## 12. 发布仓库的文件边界

仅发布源码、内置资源、合成测试及文档。`.gitignore` 排除了依赖/构建、真实研究交付物、测试工作区、数据库、密钥、agent本机配置、known-hosts和独立运维目录。提交前仍须审阅 `git diff --cached`，忽略规则不是自动安全审计，也不能撤销已经公开的敏感信息。历史验证文档引用的本机 `test-results/`、`deliverables/` 未作为源码发布附件。
