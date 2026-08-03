# job-agent · 岗位抓取端（Phase 1）

半自动化英文求职 agent 的**云端一半**。每天美东下午 4 点自动抓取目标公司官方 ATS 上的新岗位，
结果 commit 回本仓库——git 的提交历史天然就是快照历史。

> **架构分工（必须理解，否则会踩坑）**
>
> | | 跑在哪 | 为什么 |
> |---|---|---|
> | 抓取岗位 | **GitHub Actions**（本仓库） | 纯 HTTP GET 公开接口，没有登录和反爬对抗，免费 cron，git 历史免费当快照 |
> | 填表投递 | **你自己的电脑** | Actions 是数据中心 IP，会被 ATS 反欺诈标记；而且投递设计上必须有人工审核点提交；EEO / 地址等 PII 也不该进仓库 |
>
> 仓库**必须设为 private**（含投递记录和公司清单）。private 仓库的 Actions 免费额度是
> 每月 2000 分钟，每天跑一次、每次几分钟，用量在 5% 以内。

---

## 快速开始

```bash
# 1. 本地先跑一次，确认能拿到数据
node scripts/scrape.mjs --verify     # 只验证 companies.csv 里的 token
node scripts/scrape.mjs              # 完整抓取，产出 out/digest.md

# 2. 编辑 data/taxonomy.json —— 改成你自己的目标岗位家族
# 3. 编辑 data/companies.csv —— 加你想去的公司
# 4. 推到 GitHub（private 仓库），Actions 会自动按点跑
```

推上去之后，到仓库的 **Settings → Actions → General → Workflow permissions**，
确认选中 **Read and write permissions**，否则 bot 无法把结果 commit 回来。

每天的结果有三个看法：直接读 `out/digest.md`；到 Actions 页面看运行摘要（digest 会渲染在那里）；
或者本地 `git pull` 之后用你的应用读 `data/jobs.json`。

---

## 文件说明

```
.github/workflows/scrape.yml   定时任务（20:17 UTC = 美东下午 4:17）
scripts/ats.mjs                6 家 ATS 的适配器 + 限流重试
scripts/normalize.mjs          地点归一化、岗位家族匹配、跨源去重
scripts/scrape.mjs             主程序：抓取 → 快照 diff → 产出
data/companies.csv             公司 → ATS token 注册表【核心资产，慢慢养】
data/taxonomy.json             岗位家族定义【先改这个】
data/state.json                每个岗位的 firstSeenAt / lastSeenAt / closedAt（自动生成）
data/jobs.json                 当前在招岗位全量（自动生成，供本地应用消费）
out/digest.md                  本次新岗位摘要（自动生成）
out/health.json                各公司抓取健康状况（自动生成）
```

---

## 关于"发布时间"的实测结论

这是整个抓取端最容易搞错的地方。实测各家 ATS 的日期字段：

| ATS | 可用字段 | 可靠性 |
|---|---|---|
| Greenhouse | `first_published` | ✅ 可靠，是真实首发时间 |
| Greenhouse | `updated_at` | ❌ 不可靠。实测同一家公司大批岗位的 `updated_at` 完全相同，是 board 级批量刷新 |
| Lever | `createdAt`（epoch 毫秒） | ✅ 可靠 |
| Ashby | `publishedAt` | ✅ 可靠 |
| Workable / Recruitee | `published_on` / `published_at` | ⚠️ 存在但未充分验证 |
| SmartRecruiters | `releasedDate` | ⚠️ 同上 |

所以程序**优先信 ATS 自报的首发时间**，没有时才退回自己观测到的 `firstSeenAt`。

但快照 diff 依然必须做，因为它能给你三件 ATS 字段给不了的东西：

1. **重发布检测** —— 公司撤下再挂回来会重置 `first_published`，但 `state.json` 记得你早就见过它
2. **幽灵岗位识别** —— 挂满 60 天没撤的岗位会被标 `isGhostSuspect`。这类岗位常年挂着实际不招人，投了纯浪费时间。这个能力只有长期自己追踪才有
3. **JD 偷偷改动** —— 内容 hash 变化会记 `contentChangedAt`，有时候是薪资区间改了

---

## 加公司的方法

打开公司 careers 页，从 URL 就能读出 ATS 和 token：

| URL 长这样 | ats | token |
|---|---|---|
| `job-boards.greenhouse.io/stripe` | greenhouse | `stripe` |
| `jobs.lever.co/palantir` | lever | `palantir` |
| `jobs.ashbyhq.com/notion` | ashby | `Notion`（**大小写敏感**） |
| `apply.workable.com/acme` | workable | `acme` |
| `acme.recruitee.com` | recruitee | `acme` |
| `jobs.smartrecruiters.com/Visa` | smartrecruiters | `Visa` |

加完跑 `npm run verify`，无效的把 `enabled` 改成 `false`（保留记录，避免下次重复试）。

**从 200 家精准目标公司起步，远胜 20000 家噪音。** 这份清单是这个工具真正的护城河，
也是唯一没法靠 AI 一次性生成的部分——值得每周花十分钟养。

---

## 硬约束

这几条是设计红线，不是可优化项：

- **不抓 LinkedIn / Indeed。** LinkedIn 用户协议 8.2 明确禁止自动化，有浏览器指纹检测和封号先例；Indeed 有 CAPTCHA 墙和隐藏资格惩罚。本仓库只打公司自己公开发布的 job board 接口
- **不绕 CAPTCHA。** 绕过验证码或其他安全机制在美国可能触及 CFAA。遇到就交给人工
- **不在 Actions 里做任何投递动作。** 数据中心 IP 会被 Greenhouse 的 IPQualityScore 之类的反欺诈系统标记
- **不把简历、EEO、SSN 等个人数据放进仓库。** 见 `.gitignore`
- **投递永远由人点最后一步。** 全自动投递工具的回复率约 1–6%，人工确认的约 5–15%，差距主要来自填表错误和乱投

---

## 下一步（Phase 2）

本地建一个 Next.js 应用，`git pull` 读 `data/jobs.json`，加上：
简历 Master Profile、ATS 兼容性检查、岗位匹配度打分、H-1B sponsor 过滤。
投递填表（Phase 3）用 Playwright，非 headless，跑在你自己机器上。
