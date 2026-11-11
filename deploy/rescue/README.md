# hapi Runner 带外救援通道（Out-of-Band Rescue Channel）

## 背景

2026-11-11 下午公司机负载风暴（load 39，10 核）把 runner 的 Bun 事件循环饿死了 39 分钟：进程活着，但零心跳、零日志、零重连。guard 只能看「进程在不在」，看不出事件循环已经死亡；`hapi runner stop` 走的也是同一条死循环，卡住不动——结果是**无法远程修复，用户被迫到机器前手动敲命令**。

本目录提供一条**带外救援通道**，设计原则只有一条：**救援路径上绝不能有 Bun**。

- 机器侧轮询器是纯 bash + curl + python3 + openssl（macOS 全部自带，LaunchAgent 每 60s 一次）——runner 事件循环死透了它照样活着；
- hub 侧只是 openresty 上的一个**静态文件**，无任何动态逻辑；
- 操作员经 SSH 到 hub 投递签名命令。

下次再出现「进程在但不干活」，远程两条命令即可救活，不用再到机器前。

## 架构

```
操作员 ──SSH──▶ hub (38.76.198.224, 1Panel openresty)
                 │ enqueue-rescue-cmd.sh（本仓库 deploy/rescue/）
                 │ 写宿主机 /opt/1panel/www/hapi-diag/rescue.cmd
                 ▼
        openresty 容器（容器内路径 /www/hapi-diag/）
                 │  GET https://hapi.supertoken.lol/rescue-cmd-<RANDOM_PATH>
                 ▼
        目标机 LaunchAgent（com.hapi.rescue，每 60s）
        ~/.hapi-rescue/rescue.sh
        验签 → 时间窗 → nonce 防重放 → 白名单执行 → 写 ~/.hapi/logs/rescue.log
```

通道是**命令下行单向**的：执行结果只落在机器本地 `~/.hapi/logs/rescue.log`，读结果需要再 SSH 到机器（事故场景里机器 SSH 通常仍通；`runner-status` 的价值是把**拉取瞬间**的进程/负载快照固化进日志，即使你登上去时状态已经变了）。

## 安全模型

命令文件公开挂在 443 上，安全靠以下层层叠加（缺一不可，任意单层被破都不足以注入命令）：

| # | 层 | 说明 |
|---|---|------|
| 1 | **随机 URL 路径**（等价密钥之一） | `/rescue-cmd-<RANDOM_PATH>`，`RANDOM_PATH` 为 24 位 hex 随机串，只存在于 hub 的 nginx conf 与各机器 `env.sh`，不入任何文档/git。不知道路径连命令内容都读不到 |
| 2 | **HMAC-SHA256 签名** | 对规范串 `cmd\|nonce\|ts` 用共享密钥 `RESCUE_SECRET`（32 字节 hex）签名，机器侧验签不过一律拒绝。伪造命令需要密钥本身 |
| 3 | **时间窗 600s** | `ts` 距机器当前时间超过 ±600s 拒绝（双向，容忍少量时钟偏差），过期命令自然失活 |
| 4 | **nonce 去重（防重放）** | 每条命令带唯一 nonce（8 字节 hex），执行前记入 `~/.hapi-rescue/executed.nonces`（只保留尾 100 条）；同一签名命令**每台机器至多执行一次**——即使文件一直留在 hub 被每 60s 反复拉取 |
| 5 | **白名单命令** | 仅 `restart-runner` / `kill-agents` / `runner-status` 三条，无任意执行、无参数透传；其它 cmd 一律忽略并记 `rejected unknown cmd` |
| 6 | **密钥文件权限** | hub `/root/.hapi-rescue/secret` 与机器 `~/.hapi-rescue/env.sh` 均 chmod 600 |

剩余风险说明：URL 与密钥**任一单独泄露**都不足以注入命令（前者只能读，后者找不到入口）；两者同时泄露才能伪造。轮换方法见文末。

本目录五个文件全是**模板/占位符**，不含任何真实密钥；生成出的 secret/RANDOM_PATH **永远不要**提交进 git 或贴进文档。

## wire 格式

`rescue.cmd` 内容为单行 JSON，四个字段全部是字符串（`ts` 为十进制 Unix 秒）：

```json
{"cmd": "restart-runner", "nonce": "a1b2c3d4e5f6a7b8", "ts": "1762848000", "sig": "<HMAC-SHA256-hex(  cmd|nonce|ts  , SECRET)>"}
```

## hub 侧安装（一次性）

```bash
# 1) 共享密钥（600 权限）
umask 077
mkdir -p /root/.hapi-rescue
openssl rand -hex 32 > /root/.hapi-rescue/secret
chmod 600 /root/.hapi-rescue/secret

# 2) 随机 URL 路径（生成后记在密码管理器里，别贴文档）
openssl rand -hex 12        # => RANDOM_PATH

# 3) 发布目录（1Panel 宿主机路径；容器内映射为 /www/hapi-diag）
mkdir -p /opt/1panel/www/hapi-diag

# 4) nginx location
#    把 nginx-rescue.conf.snippet 内容（替换掉 <RANDOM_PATH>）放进
#    /opt/1panel/www/conf.d/hapi.supertoken.lol.conf 的 :443 server {} 块内
#    （先 cp 该 conf 一个 .bak.$(date +%s) 备份，仓库铁律）
docker ps | grep openresty                     # 找容器名
docker exec <openresty容器名> nginx -t && \
  docker exec <openresty容器名> nginx -s reload

# 5) 放好操作员工具
cp enqueue-rescue-cmd.sh /root/bin/ && chmod 700 /root/bin/enqueue-rescue-cmd.sh

# 6) 验证：无命令时应返回 204
curl -sm 10 -A "hapi-rescue/1.0" -o /dev/null -w '%{http_code}\n' \
  "https://hapi.supertoken.lol/rescue-cmd-<RANDOM_PATH>"
```

注意事项：

- **必须走 CF 入口域名** `hapi.supertoken.lol`（公司机直连 nip.io 会被跨境 RST，已实测）；`Cache-Control no-store` 已在 location 里，防 CF/中间层缓存。
- **UA 必须是 `hapi-rescue/1.0`**：CF Bot Fight 会拦默认 UA（python-urllib 等），这是仓库已知坑；`rescue.sh` 已内置该 UA。
- hub 机无 jq，脚本只用 python3/openssl，均有。

## 机器侧安装（每台受管机）

```bash
# 0) 前置：机器上有 python3 / openssl / curl（macOS 自带）
# 1) 脚本与配置
mkdir -p ~/.hapi-rescue
#    从仓库 scp rescue.sh 到 ~/.hapi-rescue/rescue.sh
chmod 700 ~/.hapi-rescue/rescue.sh

cat > ~/.hapi-rescue/env.sh <<'EOF'
RESCUE_URL="https://hapi.supertoken.lol/rescue-cmd-<RANDOM_PATH>"
RESCUE_SECRET="<hub 上 /root/.hapi-rescue/secret 的同一串 hex>"
RUNNER_WORKSPACE_ROOT="/Users/80417957"   # 与该机 runner 实际运行参数一致
EOF
chmod 600 ~/.hapi-rescue/env.sh

# 2) LaunchAgent（plist 里的 <HOME> 占位符必须替换，launchd 不展开 ~ 与 $HOME）
sed "s|&lt;HOME&gt;|$HOME|g" com.hapi.rescue.plist \
  > ~/Library/LaunchAgents/com.hapi.rescue.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.hapi.rescue.plist

# 3) 验证
launchctl print gui/$(id -u)/com.hapi.rescue     # state = running/已排队
```

安装验收（在 hub 上投一条只读命令，等 70s 后上机器看日志）：

```bash
# hub:
/root/bin/enqueue-rescue-cmd.sh runner-status
# 机器:
tail -n 30 ~/.hapi/logs/rescue.log     # 应有 action=runner-status: snapshot begin/end
cat ~/.hapi-rescue/executed.nonces     # 应有 1 条 nonce
```

## 命令语义与使用

| cmd | 动作 | 适用场景 |
|-----|------|----------|
| `restart-runner` | `pkill -9` 旧 runner（含卡死实例）→ sleep 2 → 从 `RUNNER_WORKSPACE_ROOT` 以 nohup detached 重新 `hapi runner start --workspace-root ...` | 事件循环饿死/心跳停止但进程还在；`hapi runner stop` 卡死时的强制重启 |
| `kill-agents` | `pkill -9` 三类 agent 进程：`hapi cl[a]ude`、`claude --res[u]me`、`hapi ds[h]`（方括号写法防 pkill 匹配到自杀/误伤） | 负载风暴源头是失控 agent（11-11 案件：6-7 个 claude + 5 个 resume + 10 个 dsh 吃满 CPU）。杀掉后 runner 通常自行恢复 |
| `runner-status` | 只读诊断：把 pgrep（runner/各 agent 计数）与 uptime/负载快照追加进 `~/.hapi/logs/rescue.log` | 远程确认机器真实状态、事后取证 |
| `clear`（仅 hub 侧脚本） | 删除 `/opt/1panel/www/hapi-diag/rescue.cmd`，机器拉到 204 即 no-op | 收尾清理 |

时间线：投递后机器在 **≤60s** 内拉取执行；签名有效期 **600s**；每条签名命令每台机器**至多执行一次**（nonce 去重）。重复投递同一 cmd 会生成新 nonce/ts，等于再次执行。

事故重现时的推荐序列（load 风暴 + runner 卡死，即 11-11 场景）：

```bash
/root/bin/enqueue-rescue-cmd.sh runner-status   # 1. 固化现场快照
/root/bin/enqueue-rescue-cmd.sh kill-agents     # 2. 杀掉吃 CPU 的失控 agent
/root/bin/enqueue-rescue-cmd.sh restart-runner  # 3. 强杀并重启卡死的 runner
/root/bin/enqueue-rescue-cmd.sh clear           # 4. 收尾
```

**与 guard.sh 的关系**：`restart-runner` 与既有 guard.sh 60s 巡检是双保险——本命令提供确定性的「立即强杀+重启」，即使脚本里的 start 万一失败，guard 也会在下一轮把 runner 拉起来（11-11 事故里 guard 就这样接过手）。两者幂殊途同归，不会互相打架。

**多台机器**：同一 URL+secret 下所有机器都会各自执行一次该命令（适合 fleet 级 kill-agents）。若要精确只打某一台，为该机单独部署一组 RANDOM_PATH+env.sh。

## 故障排查

| 症状 | 排查 |
|------|------|
| 投递后机器没动作 | ① hub：`cat /opt/1panel/www/hapi-diag/rescue.cmd` 文件在不在；② 手动 curl URL（带 UA `hapi-rescue/1.0`）看能否拿到 body/204；③ 机器：`launchctl print gui/$(id -u)/com.hapi.rescue` 看 job 是否在跑；④ 机器：`tail ~/.hapi/logs/rescue.log` |
| `rescue.log` 完全没有输出 | 正常——空响应/过期/重复 nonce 都是静默退出（防 launchd 日志刷屏）。投一条 `runner-status` 即可确认通路 |
| 拉到 403/503 或一段 HTML | CF 拦截（UA 不对）或 RANDOM_PATH 与 nginx conf 不匹配；JSON 解析失败时机器静默忽略 |
| 日志出现 `rejected bad signature` | 机器 `RESCUE_SECRET` 与 hub `/root/.hapi-rescue/secret` 不一致（或有人篡改 payload） |
| 日志出现 `rejected unknown cmd` | 有人投了白名单之外的 cmd（已忽略，未执行） |
| 签名有效但就是不执行 | ts 超出 ±600s：机器与 hub 时钟偏差过大，校时（NTP）后重新投递 |
| 命令只执行了一次，想再来一次 | 预期行为（nonce 去重）；重新 enqueue 会生成新 nonce |
| launchd 报 no such file | plist 里 `<HOME>` 占位符没替换，或 `~/.hapi-rescue/rescue.sh` 未就位 |
| 想看机器上已消费的 nonce | `cat ~/.hapi-rescue/executed.nonces`（尾 100 条） |

边界说明：本通道救的是「runner 死、机器活」；机器整体断电/断网/SSH 全断时任何远程手段都无效。

## 轮换与卸载

```bash
# 轮换 secret：hub 重生成 /root/.hapi-rescue/secret -> scp 同步各机器 env.sh -> 完成（旧签名自动失效）
# 轮换 RANDOM_PATH：hub nginx conf 改 location + reload -> 各机器 env.sh 改 RESCUE_URL -> enqueue clear

# 机器侧卸载
launchctl bootout gui/$(id -u)/com.hapi.rescue
rm ~/Library/LaunchAgents/com.hapi.rescue.plist ~/.hapi-rescue/rescue.sh ~/.hapi-rescue/env.sh
# hub 侧卸载：删掉 nginx location（reload）+ /root/bin/enqueue-rescue-cmd.sh + /root/.hapi-rescue/
```

## 本目录文件

| 文件 | 侧 | 用途 |
|------|----|------|
| `README.md` | — | 本 SOP |
| `nginx-rescue.conf.snippet` | hub | openresty location 片段（含 `<RANDOM_PATH>` 替换规则与安装说明） |
| `enqueue-rescue-cmd.sh` | hub | 操作员投递工具（签名+原子写入+clear） |
| `rescue.sh` | 机器 | 60s 轮询器（验签/防重放/白名单执行） |
| `com.hapi.rescue.plist` | 机器 | LaunchAgent 定义（`<HOME>` 占位符安装时替换） |
