# 回滚说明（選品腳本 · 採集監控心跳）

本文件夹用于 **随时把選品腳本回退到「内置心跳前」的纯净版**，不影响主文件 `shopee-selector.user.js` 的线上服务。

## 当前线上状态

| 位置 | 版本 | 说明 |
|---|---|---|
| `shopee-selector.user.js`（main 分支） | **v4.2.4** | 含「4181 採集監控心跳」，三个标签自动上报状态 |
| Git 标签 `rollback-v4.2.3` | v4.2.3 | 内置心跳前的最后已知良好版（纯净，仅采集） |
| Git 标签 `v4.2.4-heartbeat` | v4.2.4 | 含心跳版快照，便于后续再切回 |
| `rollback/shopee-selector.v4.2.3.user.js`（本文件同目录） | v4.2.3 | 与 `rollback-v4.2.3` 标签逐字节一致，可直接拖进油猴安装 |

> 心跳只读取選品腳本写在 `sessionStorage` 的状态并上报 4181，不改写真库、不干扰采集逻辑。
> 如 v4.2.4 在你机器上出现采集异常 / 卡死 / 油猴报错，按下面任一方式回退即可。

## 方式 A：最快回退（油猴直接装，无需 git）

1. 打开本目录的文件 `shopee-selector.v4.2.3.user.js`，全选复制其内容；
   或访问 raw 直链（与标签同内容）：
   `https://raw.githubusercontent.com/lihui9986/shopee/rollback-v4.2.3/shopee-selector.user.js`
2. 油猴 → 新增脚本 → 粘贴 → 保存。**版本号 4.2.3 < 4.2.4，会自动覆盖旧脚本。**
3. **⚠️ 关键一步**：在该脚本的设置里**关闭「自动更新 / 检查更新」**（否则油猴会按 `@updateURL` 把 4.2.4 又拉回来）。
   - 或者：把脚本头部的 `@updateURL` 改成上面那条 `rollback-v4.2.3` 直链，它就会固定停在 4.2.3。
4. 三个 shopee 标签各刷新一次。此时 4181 后台会显示「0 个标签连线」（属正常，因为纯净版不再上报心跳）。

## 方式 B：永久回退 main（让所有自动更新都回到 4.2.3）

适合你希望「全仓库默认就是安全版」时。把 v4.2.3 推回 main：

```bash
# 取回纯净版内容（base64 后 PUT 回 main，使 @updateURL 永久服务 4.2.3）
gh api repos/lihui9986/shopee/contents/shopee-selector.user.js?ref=rollback-v4.2.3 \
  --jq '.content' > /tmp/v423.b64
gh api -X PUT repos/lihui9986/shopee/contents/shopee-selector.user.js \
  -f message="回退到 v4.2.3（移除内置心跳）" \
  -f content=@/tmp/v423.b64 \
  -f sha=<当前 main 文件的 blob sha>
```

执行后所有人油猴自动更新都会落到 4.2.3。

## 恢复心跳版

修复问题后，把 main 推回 v4.2.4（或更高）即可；或把本仓库 `shopee-selector.user.js`（v4.2.4）拖进油猴覆盖并重新开启自动更新。

## 验证

- 回退成功：油猴里脚本版本显示 `4.2.3`，控制台不再出现 `[選品監控]` 相关日志。
- 心跳恢复：安装 v4.2.4 并在三个标签刷新后，4181 后台「前端採集監控」出现三张状态卡。

## 关键标识

- main 当前提交：`0df02fceee895deedbb83d23c07c2543592fae99`（v4.2.4）
- 纯净版提交：`09e574eb8a9c368176015a2e708a0ef5ab013c4f`（v4.2.3）
- 心跳块标识：`內建採集監控心跳 v1.0`（存在于 v4.2.4，v4.2.3 无此字样）
