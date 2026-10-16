# @mi-lu-uncle/dsh-session-delete

[English](README.md) | 简体中文 | [日本語](README.ja.md)

给 DeepSeek Harness（DSH）的会话「…」菜单加一个**「删除会话」**入口。

DSH 0.2.0-rc.2 只提供了**归档**（软删除：隐藏但保留全部数据），没有真正的删除。本插件补上这个缺失的入口——点一下即可**永久删除**一个会话及其磁盘数据。

## 功能

- 在会话行「…」菜单里，紧跟内置的 置顶 / 重命名 / Fork / 归档 之后，新增 **「删除会话」**。
- 点击后弹出确认框（显示会话标题），确认后调用宿主端删除。
- 删除会一并清理三处数据：
  1. 会话本体 `~/.dsh/sessions/<工作区>/<session-id>/`
  2. 投影缓存 `~/.dsh/storages/session_projcache/sessions/<session-id>.json`
  3. 工作区索引里该会话的登记（`sessionIds` / 归档 / 置顶标记）
- 删除成功后，打开的界面**无需刷新**即可看到该行消失（通过 `api-session/removed` 事件）。
- **自动修复默认工作区**：DSH 自带的「删除工作区」如果误删了默认工作区，会留下悬空指针、让它的会话掉进「未分组」且无法再新建会话。本插件启动时只针对**默认工作区**（由 `defaultWorkspaceId` 或上次记住的路径识别）自动重建登记并归位会话；你主动删除的其他工作区不会被"复活"。

## 安全

- **正在运行的会话拒绝删除**：用 DSH 归档同款的 `workspace/session-activity` 检测，只有真正在跑的工作（进行中的对话 turn、后台任务等）会被拦下并提示「该会话正在运行中」；已经闲下来的旧会话（哪怕仍被 DSH 保活在内存里）可以正常删除。
- 删除操作走 DSH 自己的工作区注册表写入路径（`detachSession` / `unarchiveSession` / `unpinSession`），保证持久化状态一致。
- 路由做了同源校验，仅接受来自 DSH 界面自身的请求。

## 安装

本插件面向 DSH `0.2.0-rc.2`，以本地目录方式链接进 `desktop` profile：

```sh
dsh plugin --profile desktop add "link:/绝对路径/dsh-session-delete"
```

然后**重启 DSH** 使其生效。

也可以手动改 `~/.dsh/profiles/desktop/package.json`：

```jsonc
{
  "dependencies": {
    "@mi-lu-uncle/dsh-session-delete": "link:/绝对路径/dsh-session-delete"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ... 原有 ...
        "@mi-lu-uncle/dsh-session-delete"
      ]
    }
  }
}
```

之后在 profile 目录执行 `pnpm install`，再重启 DSH。

## 用法

1. 在左侧会话列表里，把鼠标移到某个会话上，点它右侧的「…」。
2. 选 **「删除会话」**。
3. 在确认框里点 **「删除」**。

> ⚠️ 删除是**永久且不可撤销**的。建议先确认该会话确实不再需要。

## 局限 / 说明

- 这是社区插件，利用了 DSH 的公开扩展点（会话菜单槽 `sidebar.workspaces.session.menu.item` + 宿主端文件/注册表清理）。若 DSH 后续版本提供官方的「删除会话」接口，建议改用官方能力。
- 正在运行的会话被拒绝删除；如确需删除，请先停止该会话（结束/归档其工作）再删。
- 全文搜索索引是 DSH 的「可重建读模型」，删除后可能有极短暂的陈旧结果，下次重建即恢复。

## License

MIT
