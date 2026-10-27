# 部署 / 升级 / 排障

## 一键部署

```bash
git clone https://github.com/Nacho-Neko26/ds-project-public.git
cd ds-project-public
sudo bash deploy/install.sh --qq <机器人QQ> --owner <号主QQ> --api-key sk-xxx [--official-key sk-官方key]
```

装完扫个码就能聊：见脚本最后打印的「7/7 接下来」。

### 脚本做了什么

| 步骤 | 动作 | 落在哪 |
|---|---|---|
| 1 | 装 Node 22 | `/usr/local/lib/nodejs` 或 apt |
| 2 | 装 Docker，起 NapCat 容器 | 容器 `napcat`，数据 `/root/napcat/data` |
| 3 | 部署桥 | `/root/qq-agent`（代码覆盖、workspace 不覆盖） |
| 4 | 装 DSH + 写凭证 + 造兼容布局 | `~/.dsh-runtime/dsh/…`、`~/.dsh/.credentials.yaml` |
| 5 | 注册 systemd `qq-bridge` | `/etc/systemd/system/qq-bridge.service` |
| 6 | 自检 | `node --check`、`src/doctor.mjs` |
| 7 | 打印扫码与运维指引 | 屏幕 |

### 幂等性

- 代码 / 人设 / 配置：每次都以仓库为准覆盖（升级就是这个逻辑）。
- `workspace/`（记忆库、好感度、表情索引、日记）：用 `cp -an`，**已有文件不覆盖**，只补缺的。
- NapCat 容器：已存在就跳过创建（容器卷里是 QQ 登录态，重建要重新扫码）。
- 凭证：已存在 `DEEPSEEK_API_KEY` 就跳过，不覆盖你的 key。脚本写三个 key：
  `DEEPSEEK_API_KEY`（跑 agent 用）、`RELAY_API_KEY`（与它同值，以后切中转不用改）、
  `DEEPSEEK_OFFICIAL_KEY`（只有它，余额播报才不会 401——中转 key 查官方余额必失败）。
- 语音：桥的语音条和「听懂语音消息」依赖本机两个服务（TTS `127.0.0.1:3911`、ASR `127.0.0.1:3912`）。
  新机器没有时脚本会自动把 `voice.enabled`/`asr.enabled` 关掉、`music.mode` 切成 `text`，
  **聊天照常，只是不发语音条、不转写语音**。要补齐见 `qq-agent/docs/qq-voice.md`。

## 手工部署（脚本跑不通时）

见 [`../docs/QQ接入与服务器部署-复刻指南.md`](../docs/QQ接入与服务器部署-复刻指南.md)，那是逐步命令版。

## 升级

```bash
cd ds-project-public && git pull
sudo bash deploy/upgrade.sh            # 只更新桥，不动 NapCat 和登录态
sudo bash deploy/upgrade.sh --dsh 0.2.1-rc.2   # 顺带升 DSH 版本（先看升级注意）
```

`upgrade.sh` 会：备份当前 `src/` + `config/` 到 `/root/qq-agent/.backup-<时间>` → 覆盖代码 → `node --check` → 重启 → 打印最后 30 行日志。
出问题就 `cp -a /root/qq-agent/.backup-*/. /root/qq-agent/ && systemctl restart qq-bridge`。

## 卸载

```bash
systemctl disable --now qq-bridge
rm -f /etc/systemd/system/qq-bridge.service
docker rm -f napcat
# 数据自己留着：/root/qq-agent/workspace、/root/napcat/data/qq
```

## 常见故障

| 症状 | 根因 | 处理 |
|---|---|---|
| 桥日志每 30 秒 `Received network error or non-101` | QQ 登录态过期，NapCat 没登上（不是端口问题，3001 还在监听） | `docker cp napcat:/app/napcat/cache/qrcode.png /root/napcat/data/qrcode.png` 重新扫码 |
| 桥起来了但不回消息 | 这个会话不在白名单里 | 看 `config/config.json` 的 `lists`/`trusted`，加上会话 key 后重启 |
| `dsh` 一跑就退出、日志空 | 用 headless profile 没挂 credentials，读不到 key | 确认 `/root/.dsh/.credentials.yaml` 存在且 600，桥启动时会把 key 写进 env |
| 回复乱、口癖重复 | 人设 / 语料的问题 | 改 `persona/persona.md`、`persona/corpus.md`，不用重启，下一轮生效 |
| 表情发不出去 | `stickers/` 没有素材文件 | 见 `qq-agent/docs/stickers-INSTALL.md` |
| 内存吃满被 OOM | 2G 内存跑 NapCat+桥+DSH 很紧 | 加 swap（脚本不自动做）：`fallocate -l 2G /swapfile && mkswap /swapfile && swapon /swapfile` |
