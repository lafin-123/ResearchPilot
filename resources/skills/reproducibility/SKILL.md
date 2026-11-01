---
name: reproducibility
description: Verify local research artifact hashes, environment and rerun metadata; distinguish an inventory check from an actually reproduced experiment.
whenToUse: 交付实验、复现结果、检查 run 产物完整性或论文送审前使用。
user-invocable: true
---

# 可复现性核验

文件清单通过不等于实验已复现。只读核验脚本不会执行 manifest 中的命令，不联网、不安装依赖。

## 原生流水线执行（优先于下方 CLI 示例）

用 run_reproducibility 获取实际清单/哈希/警告，以 artifact_read 检查源和数据。不要运行 shell 命令。额外核验计算使用 experiment_create 注册你编写的代码，再用 experiment_run 明确确认执行；报告来自真实输出，以 artifact_read 读回后 project_artifact_write 原样保存。若需要实际复现，用 experiment_run 创建新 run 并比较，不能把 inventory 改称 rerun。机械报告列明 scope、实际检查、输入哈希、未验证范围及 humanReviewRequired=true。

## 操作

1. 收集实际 run ID、代码、配置、原始结果、环境版本/锁文件、seed、采样单位、运行命令、输入权限和硬件信息。环境里不要保存 API Key、口令或个人身份数据。
2. 复制 `templates/reproduction-manifest.json` 为项目内 manifest，填入相对文件路径及真实 SHA-256。使用 `Get-FileHash -Algorithm SHA256` 或标准库 hashlib 计算，绝不手填猜测的哈希。
3. 请求执行核验的确认后运行：`python -I <skill-dir>/scripts/verify_manifest.py exports/reproduction-manifest.json --root . --out exports/reproducibility.json`。
4. 对缺失、空文件、哈希漂移、跨工作区路径、遗漏环境/seed 一律报告 blocker。不要通过更新哈希隐藏意外变化；先解释变化并确认哪个版本是基准。
5. 若用户要求实际复现，先审查命令与代码、估算预算、取得运行批准；再在独立输出目录重跑。保存新的 run ID、误差容忍范围、与旧结果的比较。不得将 `rerunExecuted:false` 改写为 true 来通过流水线。
6. 交付清单、核验结果、最小重跑说明、未验证依赖及不可访问数据。只声称本次实际检查过的内容。

## 验收

哈希检查返回 0 且 JSON `status=passed`；所有失败返回非零。命令只被记录，没有被执行。对平台差异、随机性、专有数据、远程算力和无法安装的依赖给出限制。见 `evals/cases.json`。
