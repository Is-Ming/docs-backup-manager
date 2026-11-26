# docs-backup-manager

AI 开发文档统一备份工具。把各项目中**不入公开 git 仓库**的 AI 工作文件（`docs/`、`openspec/`、`AGENTS.md`、`.codebuddy/` 等）**单向、保真、自动**同步到统一的中央备份目标（默认 `~/.docs-vault`，可为本地文件夹或私有 git 仓），并定时 `commit + push` 完成异地备份。

## 核心原则

1. **单向同步**：项目 → 中央目标，永不反向
2. **零侵入**：不在项目仓库内放置任何工具自身的文件
3. **专属落点**：同步只写中央目标 `backup/<项目名>/`（README.md 索引为软件自身维护的显式例外）
4. **保真镜像**：原样复制，不改名、不转格式、不加工
5. **git 模式下 push 才算备份完成**：纯本地文件夹模式同步完成即备份完成

## 技术栈

Tauri 2 + React 19 + TypeScript + Tailwind CSS + Rust + SQLite。

UI 与工程骨架基于 [skills-manager](https://github.com/xingkongliang/skills-manager)（MIT）改造，其源码符合 MIT 协议并保留版权声明。

## 开发

```bash
npm install
npm run tauri:dev     # 开发模式
npm run tauri:build   # 打包桌面应用
```

前置要求：Node.js 20.19+、Rust 1.77.2+（MSVC）、VS Build Tools（C++ 工作负载）。

## 设计文档

完整需求分析与概要设计见知识库 `个人研发/docs-backup-manager/docs-backup-manager需求分析与概要设计.md`（v0.2）。

## 许可

MIT
