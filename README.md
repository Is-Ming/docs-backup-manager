# docs-backup-manager

项目文档统一备份工具。把各项目中**不入公开 git 仓库**的工作文档与配置目录（如 `docs/`、`openspec/`、`AGENTS.md` 等，任意目录均可配置）**单向、保真、自动**同步到统一的中央备份目标（默认 `~/.docs-vault`，可为本地文件夹或私有 git 仓），并定时 `commit + push` 完成异地备份。

## 核心原则

1. **单向同步**：项目 → 中央目标，永不反向
2. **零侵入**：不在项目仓库内放置任何工具自身的文件
3. **专属落点**：同步只写中央目标 `backup/<项目名>/`（README.md 索引为软件自身维护的显式例外）
4. **保真镜像**：原样复制，不改名、不转格式、不加工
5. **git 模式下 push 才算备份完成**：纯本地文件夹模式同步完成即备份完成

## 功能一览

- **项目注册**：登记任意本地项目路径，自定义同步清单（任意目录或文件），默认模板开箱即用
- **自动同步**：托盘常驻定时同步，自动/手动模式可切换，频率可配置
- **批次备份**：一轮同步合并为 1 个 commit；中央目标为 git 仓时自动 push，失败红标、恢复后自动补推
- **状态一览**：每个项目的上次同步时间、变更统计、commit SHA、push 结果
- **双模式备份目标**：普通本地文件夹（默认）或私有 git 仓，自动检测，随时升级
- **防误删**：注册向导 dry-run 预览同步映射与将删除项，确认后才执行

## 技术栈

Tauri 2 + React 19 + TypeScript + Tailwind CSS + Rust + SQLite。

UI 与工程骨架基于 [skills-manager](https://github.com/xingkongliang/skills-manager)（MIT）改造，保留其版权声明。

## 开发

```bash
npm install
npm run tauri:dev     # 开发模式
npm run tauri:build   # 打包桌面应用
```

前置要求：Node.js 20.19+、Rust 1.77.2+（本机当前为 GNU 工具链 + MSYS2 GCC）、Windows。

## 设计文档

完整需求分析与概要设计见知识库 `个人研发/docs-backup-manager/docs-backup-manager需求分析与概要设计.md`（v0.2）。

## 许可

MIT
