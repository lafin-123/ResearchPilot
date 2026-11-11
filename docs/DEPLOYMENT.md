# 安装与配置 ResearchPilot

你可以直接安装 Windows 或 Linux 版，也可以从源码运行。第一次使用推荐安装包，开发和定制功能时再选择源码方式。

## 一、安装桌面版

### 下载安装包

### Windows x64

下载 `ResearchPilot-<版本>-windows-x64-setup.exe`，按向导选择安装目录。安装包自带应用运行环境，无需安装 Node.js。安装程序尚未签名，Windows 可能显示未知发布者提示；请核对随包提供的 SHA-256。

### Linux x64

Debian / Ubuntu 系统使用 `ResearchPilot-<版本>-linux-x64.deb`。建议 Ubuntu 22.04 或更新版本，以及已登录、解锁的桌面密钥环。

```bash
sudo apt install ./ResearchPilot-0.9.0-linux-x64.deb
```

安装后从应用菜单启动 **ResearchPilot**。其他 glibc 桌面发行版可使用 `.tar.gz` 解压版；解压后从自己的用户账户运行 `researchpilot`，不要以 root 启动，也不要为绕过启动错误添加 `--no-sandbox`。

Linux 需要系统 GTK、NSS、GBM、ALSA 和 Secret Service / KWallet 等桌面组件。`.deb` 会声明依赖；解压版由系统提供这些依赖。密钥环不可用或回退为 `basic_text` 时，应用拒绝保存模型和 SSH 密钥。部分发行版限制非特权用户命名空间，须按发行版的 Chromium/Electron 安全策略配置沙箱，不建议关闭沙箱。

两个平台均不内置 Python 或 LaTeX。论文润色的脚本检查与实验运行需要 Python 3.10+；基础文献、笔记与稿件管理可以先使用。Linux 终端中的 `research` 命令桥另需 Node.js 24+ 和 curl；应用内原生工具不依赖单独安装的 Node.js。

### 第一次打开

启动后直接进入本地工作区。你可以先整理文献、阅读 PDF、写研究笔记，再按需要配置 AI 和实验环境。

| 你想做的事 | 需要配置 |
| --- | --- |
| 文献管理、PDF 阅读、研究笔记 | 安装应用即可 |
| 与助手讨论、AI 阅读与写作 | 模型 API 地址、Key 和模型 |
| 运行 Python 实验 | Python 3.10+ 及研究所需依赖 |
| 自动研究流程 | 模型、Python、三个内置 MCP 服务 |
| 编译 LaTeX 为 PDF | LaTeX 工具链 |
| 远程实验 | SSH 主机及远端研究环境 |

## 二、接入模型

### 添加提供方

1. 打开 **设置 → 模型与偏好 → 模型与 API → 添加提供方**。
2. 选择服务商预设，或使用自定义兼容 API。
3. 填写 **基础 URL** 和 **API Key**，核对协议。
4. 点击 **获取上游模型**，勾选要使用的模型。
5. 点击 **保存所选模型**，按需设为默认。

基础 URL 填 API 根地址，例如 `https://api.example.com/v1`，具体以服务商文档为准；`/chat/completions`、`/responses` 等请求路径由应用补充。

应用支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 兼容协议。获取模型只查询列表；想确认连接能否生成内容，可主动点击 **真实调用测试**，该操作会使用少量模型额度。

上游返回的上下文、输出上限和能力信息会显示在模型列表中。若服务不提供模型列表，可以切换 **手动填写模型（可选）**，每行填写：

```text
model-id | 显示名称
```

### 分别配置写作、绘图和工程模型

在 **生成参数 → 分角色 Agent** 中，为三个角色选择提供方和模型：

| 角色 | 主要工作 |
| --- | --- |
| 写作 Agent | 文献综合、章节写作、期刊修改、审阅 |
| 绘图 Agent | 图形设计、图注和可编辑素材 |
| 工程与实验 Agent | 研究设计、代码实现、实验与分析 |

角色可以使用不同 API 和 Key，也可以共用一个提供方。选好后点击 **保存生成参数**。留空的角色沿用当前任务模型。

技能任务会进入对应角色的独立会话；研究流程按阶段交接项目产物。你可以在最近会话里继续查看各角色的工作。

### 调整问询方式

同一区域提供 **少打断、关键处询问、先问清楚** 三档。普通的语言、篇幅和格式偏好可以使用默认值；需要明确研究事实时，助手仍会询问。准备单个技能任务时，也能临时选择另一档。

## 三、配置实验环境

### 选择 Python

安装 [Python](https://www.python.org/downloads/windows/) 3.10 或更新版本。打开终端检查：

```bash
python --version
```

然后在 **设置 → 模型与偏好 → 运行环境 → Python 解释器路径** 中填写实际 `python.exe` 路径并保存。使用虚拟环境时，填写虚拟环境中的解释器路径即可。

实验需要的 numpy、pandas、matplotlib 等依赖，安装到你选用的 Python 环境中。完整研究流程使用这里明确配置的解释器，因此即使系统里已经检测到 Python 或 uv，也请保存一次解释器路径。

### 启用 MCP 工具

打开 **设置 → 工具连接**，启用并测试三个内置服务：

- **文献与证据**：文献检索、来源读取、PDF 全文分页和作者指南获取。
- **文稿与表达**：读取稿件、表达审阅和文稿写入。
- **实验与图表**：实验登记与执行、运行产物、结构化图表。

MCP 是助手与项目工具之间的连接层。连接测试使用本地服务，不调用模型。配置完成后，**设置 → 环境检查** 页面会汇总模型、Python、工具和项目目录状态。

### LaTeX 和远程算力

编译 `.tex` 时，可安装 TeX Live 或 MiKTeX，并在运行环境中设置编译命令。中文论文通常使用 XeLaTeX。DOCX 和结构化图表导出可以独立使用。

需要远程实验时，在 **SSH 主机** 中添加地址、用户名与认证方式，核对首次连接的主机指纹，并在远端准备好依赖和数据。实验台可选择已配置的远程主机。

## 四、开始第一个研究项目

1. 创建项目，填写名称和研究目标。
2. 在 **文献资料** 中搜索来源、添加 DOI、导入 BibTeX 或关联 PDF。
3. 用 **研究笔记** 记录问题、阅读摘记和实验观察。
4. 打开 **助手 → 技能库**，按类别选择任务；目标、输入与输出的补充字段可以直接跳过。
5. 点击 **放入助手草稿**，检查内容后发送。

如果希望连贯推进，在工作台输入研究主题，点击 **一键开始研究**。流程会依次保留文献、方案、实验、分析、图表和稿件产物。执行代码或外部操作时，按界面提示检查并确认。

例如，可以从这样一个小任务开始：

> 请整理本项目已有文献，比较它们的方法和实验条件，给出三个值得进一步验证的问题，并标注依据。

## 五、从源码运行

### 准备环境

安装 Node.js 24+ 和 Git，使用 Windows 或 Linux 桌面环境。Node.js 版本可这样查看：

```bash
node --version
```

获取项目并进入目录：

```bash
git clone https://github.com/lafin-123/ResearchPilot.git
```

```bash
cd ResearchPilot
```

安装锁定版本的依赖：

```bash
npm ci
```

启动开发版：

```bash
npm run dev
```

该命令会构建本地 MCP 服务，然后打开 Electron 应用。依赖安装过程会下载 Electron；仓库目前配置了国内 npm/Electron 镜像，网络问题的处理方式见下方常见问题。

### 构建与预览

```bash
npm run build
```

```bash
npm run preview
```

ResearchPilot 由 Electron 主进程、预加载层和 React 界面组成。部署单位是桌面应用，`out/renderer` 需与主进程一起运行。

### 真实模型验证脚本

真实模型脚本不会使用内置私人测试端点。运行前需在当前终端设置 `RESEARCHPILOT_API_KEY`、`RESEARCHPILOT_API_BASE` 和 `RESEARCHPILOT_MODEL`，分别提供自己的凭据、兼容端点和准确模型 ID；这些脚本会产生实际 API 调用费用，不属于普通测试必需步骤。网关探测脚本另使用 `RESEARCHPILOT_API_ORIGIN`。阅读验证还需 `RESEARCHPILOT_REFERENCE_DB` 指向 `test-results` 内自己准备的隔离文献数据库，只读复用参考文献。

不要将这些值提交到仓库。普通桌面回归使用本地模拟模型，无需真实凭据。

### 运行检查

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run test:e2e
```

端到端测试会在 Windows 桌面启动真实应用，并在 `test-results/` 中创建独立测试工作区。日常安装与使用不需要运行测试。

## 六、构建安装包

在项目根目录完成依赖安装后，运行：

```bash
npm run package:win
```

安装程序输出到 `release/`，命名为 `ResearchPilot-<版本>-windows-x64-setup.exe`。

只需要解包后的应用目录时，使用：

```bash
npm run package:dir
```

Linux x64 的 `.deb` 和 `.tar.gz` 使用独立依赖暂存目录构建，避免将 Windows 原生模块误打进 Linux 包：

```bash
npm run package:linux
```

此命令会下载 Linux Electron 和所需的 Linux x64 生产依赖，检查关键 ELF 二进制、资源和归档权限后生成安装包。Windows 主机上的交叉构建只证明产物结构正确，不能代替 Linux 桌面运行验证。

打包过程会下载 Electron Builder 工具。若某个原生依赖需要本机编译，再根据错误提示安装对应平台的编译工具。许可证和第三方声明会随应用打包。

发布前还应检查助手运行依赖，而不只是窗口能否打开。DSH 的部分运行契约由上游声明为 peer，本项目将已使用的版本显式固定到生产依赖，避免打包器漏收。可对解包后的 Windows 应用运行依赖闭包审计和隔离的本地模拟上游测试：

```bash
node --experimental-import-meta-resolve scripts/validate-packaged-dependencies.mjs --app-root release/win-unpacked/resources/app --compare-root .
```

```bash
node scripts/smoke-packaged-agent.mjs release/win-unpacked/ResearchPilot.exe
```

路径需按本次实际输出目录调整。第二条命令不执行安装向导，使用独立数据目录和本地模拟模型，检查真实 SDK 启动、流式请求与回复保存。

## 七、备份与升级

项目通常位于当前用户文档目录下的 `ResearchPilot` 文件夹。可在设置中修改新项目的默认位置，已有项目继续使用原目录。

升级前，保存正在编辑的草稿，并在 **备份与恢复** 导出需要保留的项目。`.rpbackup` 可以恢复为独立副本，适合迁移和核对研究资料；模型 Key、聊天和 SSH 配置需另外管理。备份含研究内容，请保存在可信位置。

下载新安装包后，退出应用再更新，保留原有数据目录。更多保存范围见 [数据管理说明](TECHNICAL_NOTES.md#数据与草稿)。

## 常见问题

| 遇到的问题 | 处理方式 |
| --- | --- |
| PowerShell 提示无法运行 `npm.ps1` | 使用 `npm.cmd ci`、`npm.cmd run dev` 等对应命令 |
| 依赖或 Electron 下载失败 | 检查当前网络和代理；若镜像不可达，可改用官方 registry/下载源，保持 TLS 校验开启 |
| npm 出现 `electron_mirror` 配置提示 | 先查看安装退出码与 Electron 下载结果，提示本身不等于失败 |
| `node:sqlite` 不存在 | 更新到 Node.js 24+，重新打开终端确认版本 |
| 安装后助手报 `ERR_MODULE_NOT_FOUND`，包含 `cordis-plugin-group` | 旧安装包漏收了助手运行依赖，需要更新完整安装包；不要在用户数据或安装目录中手动安装 npm 包。发布前应运行打包依赖审计与实际助手回复测试。 |
| 获取不到模型列表 | 核对 URL、协议、Key；服务没有列表接口时使用手动模型入口 |
| 模型返回 401 / 403 / 429 | 分别检查凭据、模型权限、额度和限流状态 |
| Python 检查失败 | 选择实际解释器，检查版本和所需依赖，避开 Microsoft Store 的占位程序 |
| 项目目录不可用 | 找回原目录或修复权限，然后在准备检查中点击重试初始化 |
| PDF 提取没有文字 | 该页可能是扫描图像，改用 OCR 或视觉阅读；阅读器仍可添加页面批注 |
| 作者指南链接无法获取 | 使用最终的官方 HTTPS 链接，或将指南正文提供给助手 |
| LaTeX 编译失败 | 查看编译日志，检查工具链和缺失宏包；DOCX 写作可继续使用 |

## 进一步阅读

- [功能总览](../README.md)
- [技术说明与数据管理](TECHNICAL_NOTES.md)
- [许可证](../LICENSE.md)：项目自有代码采用 PolyForm Noncommercial 1.0.0，商业用途请联系维护者授权。
