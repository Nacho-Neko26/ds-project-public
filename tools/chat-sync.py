# -*- coding: utf-8 -*-
"""#同步：把 QQ 桥在服务器上积累的「记忆库 + 知识库」和本机这份做增量双向合并。

触发方式
  - QQ 私聊给机器人发 `#同步`：桥只写一个待同步标记（data/sync/pending.json），
    因为它不知道本机开没开机。
  - 本机计划任务 `DSH-Chat-Sync`（登录后 2 分钟 + 每 30 分钟）跑 `--watch-once`：
    看到待同步标记就同步，没有就安静退出。

同步什么（用户 2026-10-25 定：只要记忆库和知识库）
  - 记忆库：`/root/qq-agent/workspace/.dsh-meow/memory.db` ↔ 本机 `.dsh-meow/memory.db`
    七张内容表（soul/user/project/fact/lesson/topic/rules），按 id 合并、updated_at 新的赢。
    windows / dream_* 这类会话账本不参与（本机和服务器的 session id 互不相干）。
  - 知识库：`/root/qq-agent/workspace/.dsh-knowledge/*.json` ↔ 本机 `.dsh-knowledge/*.json`
    按「库 id + 节点 id」合并，节点 `at` 新的赢；links 取并集。
    selection.json（哪个库注入）属于各端本地配置，不搬。

回传方向只挑「她该知道的那部分」：soul / user / rules 三层（自我认知、用户偏好、行为准则）。
本机写代码攒下的 fact/lesson/project 条目不往服务器灌，否则每轮都会被她当长期记忆注入。

用法
  python tools/chat-sync.py --dry-run     # 只算不动
  python tools/chat-sync.py --force       # 不管有没有标记都同步
  python tools/chat-sync.py --watch-once  # 有标记才同步（计划任务用这个）
  python tools/chat-sync.py --watch       # 常驻轮询（调试用）
"""
import argparse
import base64
import datetime as dt
import json
import os
import random
import shutil
import sqlite3
import sys
import tempfile
import time

WORKSPACE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCAL_DB = os.path.join(WORKSPACE, ".dsh-meow", "memory.db")
LOCAL_KB = os.path.join(WORKSPACE, ".dsh-knowledge")
STATE_PATH = os.path.join(WORKSPACE, "sync", "state.json")
REPORT_PATH = os.path.join(WORKSPACE, "sync", "last-report.md")

REMOTE_DB = "/root/qq-agent/workspace/.dsh-meow/memory.db"
REMOTE_KB = "/root/qq-agent/workspace/.dsh-knowledge"
REMOTE_PENDING = "/root/qq-agent/data/sync/pending.json"
REMOTE_TMP_DB = "/tmp/chat-sync-copy.db"

# 好感度 / 心情（2026-10-27 用户要求一起同步）
LOCAL_PROFILES = os.path.join(WORKSPACE, "qq-agent", "workspace", "profiles")
LOCAL_EMOTION = os.path.join(WORKSPACE, "qq-agent", "data", "emotion.json")
REMOTE_PROFILES = "/root/qq-agent/workspace/profiles"
REMOTE_EMOTION = "/root/qq-agent/data/emotion.json"

TABLES = ["soul", "user", "project", "fact", "lesson", "topic", "rules"]
# 回传只挑「她该知道的那部分」：自我认知、用户偏好、行为准则。
# 本机写代码攒下的 fact/lesson/project 条目（dsh、oslab 那些）不往服务器灌，
# 否则每一轮都会被她当长期记忆注入，人设上下文被淹。
PUSH_LEVELS = {"soul", "user", "rules"}
KB_SKIP = {"selection.json"}

try:  # Windows 控制台默认 GBK，中文会炸
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def now_ts() -> int:
    return int(time.time() * 1000)


def stamp(ms: int) -> str:
    return dt.datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d %H:%M:%S")


def load_state() -> dict:
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"lastSyncAt": 0, "lastPushAt": 0, "runs": 0}


def save_state(st: dict) -> None:
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False, indent=2)
    os.replace(tmp, STATE_PATH)


# ---------- 连接 ----------

def open_client():
    sys.path.insert(0, os.path.join(WORKSPACE, "tools"))
    import rc  # noqa: E402  复用同一套 secrets 解析与密钥连接

    ip, user, pwd = rc.load_creds()
    client, _how = rc.connect(ip, user, pwd)
    return client


def run(client, cmd: str, timeout: int = 120) -> str:
    _in, out, err = client.exec_command(cmd, timeout=timeout)
    text = out.read().decode("utf-8", "replace")
    etext = err.read().decode("utf-8", "replace")
    if text.strip() == "" and etext.strip():
        return etext
    return text + (("\n[stderr]\n" + etext) if etext.strip() else "")


# ---------- 记忆库 ----------

def cols_of(con, table):
    return [r[1] for r in con.execute(f"PRAGMA table_info({table})")]


def pull_remote_db(client, tmpdir):
    """服务器上用 sqlite backup API 做一致性快照，再取回来（避免边写边读）。"""
    script = (
        "import sqlite3;"
        f"src=sqlite3.connect('file:{REMOTE_DB}?mode=ro',uri=True);"
        f"dst=sqlite3.connect('{REMOTE_TMP_DB}');"
        "src.backup(dst);dst.close();src.close();print('ok')"
    )
    run(client, f"python3 -c \"{script}\"")
    local = os.path.join(tmpdir, "remote.db")
    sftp = client.open_sftp()
    try:
        sftp.get(REMOTE_TMP_DB, local)
    finally:
        sftp.close()
    return local


def merge_memory(remote_path, dry_run, since_ts):
    """服务器 → 本机。返回 (新增到本机的明细, 跳过的条数)。"""
    added = []
    skipped = 0
    if not os.path.exists(remote_path):
        return added, skipped
    src = sqlite3.connect(remote_path)
    dst = sqlite3.connect(LOCAL_DB, timeout=15)
    try:
        for t in TABLES:
            try:
                rcols = cols_of(src, t)
                dcols = cols_of(dst, t)
            except sqlite3.Error:
                continue
            common = [c for c in rcols if c in dcols]
            rows = src.execute(f"SELECT {','.join(common)} FROM {t}").fetchall()
            for row in rows:
                d = dict(zip(common, row))
                rid = d.get("id")
                if not rid:
                    continue
                old = dst.execute(f"SELECT updated_at FROM {t} WHERE id=?", (rid,)).fetchone()
                if old is not None and (old[0] or 0) >= (d.get("updated_at") or 0):
                    skipped += 1
                    continue
                if not dry_run:
                    ph = ",".join("?" * len(common))
                    dst.execute(
                        f"INSERT OR REPLACE INTO {t} ({','.join(common)}) VALUES ({ph})",
                        [d[c] for c in common],
                    )
                if (d.get("updated_at") or 0) > since_ts:
                    added.append(
                        {
                            "level": t,
                            "id": rid,
                            "title": d.get("title") or "",
                            "content": (d.get("content") or "")[:120],
                            "project": d.get("project"),
                        }
                    )
        if not dry_run:
            dst.commit()
    finally:
        src.close()
        dst.close()
    return added, skipped


def collect_push_rows(since_ts, levels=None):
    """本机 → 服务器：默认只推 soul/user/rules（--push-all 时推全部层级），且比上次推送新。"""
    levels = set(levels or PUSH_LEVELS)
    out = {}
    con = sqlite3.connect(LOCAL_DB, timeout=15)
    try:
        for t in TABLES:
            if t not in levels:
                continue
            cols = cols_of(con, t)
            rows = con.execute(f"SELECT * FROM {t}").fetchall()
            picked = []
            for row in rows:
                d = dict(zip(cols, row))
                if (d.get("updated_at") or 0) <= since_ts:
                    continue
                picked.append({c: d[c] for c in cols})
            if picked:
                out[t] = picked
    finally:
        con.close()
    return out


def push_memory(client, payload, tmpdir):
    if not payload:
        return 0
    local_json = os.path.join(tmpdir, "push.json")
    with open(local_json, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    script = f'''
import json, sqlite3
data = json.load(open('/tmp/chat-sync-push.json', encoding='utf-8'))
con = sqlite3.connect('{REMOTE_DB}', timeout=15)
n = 0
for table, rows in data.items():
    if not rows:
        continue
    cols = rows[0].keys()
    ph = ','.join('?' * len(cols))
    for d in rows:
        old = con.execute(f"SELECT updated_at FROM {{table}} WHERE id=?", (d['id'],)).fetchone()
        if old is not None and (old[0] or 0) >= (d.get('updated_at') or 0):
            continue
        con.execute(f"INSERT OR REPLACE INTO {{table}} ({{','.join(cols)}}) VALUES ({{ph}})",
                    [d[c] for c in cols])
        n += 1
con.commit()
con.close()
print(n)
'''
    sftp = client.open_sftp()
    try:
        sftp.put(local_json, "/tmp/chat-sync-push.json")
        with sftp.open("/tmp/chat-sync-push.py", "w") as f:
            f.write(script.encode("utf-8"))
    finally:
        sftp.close()
    out = run(client, "python3 /tmp/chat-sync-push.py")
    try:
        return int(str(out).strip().splitlines()[-1])
    except Exception:
        return 0


# ---------- 知识库 ----------

def load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def merge_base(local, remote):
    """同一份库：节点按 id 合并（at 新者赢），links 取并集。"""
    changed = []
    nodes = {n.get("id"): n for n in local.get("nodes", [])}
    for n in remote.get("nodes", []):
        nid = n.get("id")
        if not nid:
            continue
        old = nodes.get(nid)
        if old is None or str(n.get("at") or "") > str(old.get("at") or ""):
            nodes[nid] = n
            changed.append(n)
    links = {}
    for l in (local.get("links") or []) + (remote.get("links") or []):
        k = (l.get("from"), l.get("to"))
        if k[0] and k[1]:
            links[k] = l
    merged = dict(local)
    merged["nodes"] = list(nodes.values())
    merged["links"] = list(links.values())
    return merged, changed


def sync_knowledge(client, dry_run, since_stamp):
    added = []
    sftp = client.open_sftp()
    names = []
    try:
        names = [n for n in sftp.listdir(REMOTE_KB) if n.endswith(".json") and n not in KB_SKIP]
    except IOError:
        names = []
    os.makedirs(LOCAL_KB, exist_ok=True)
    try:
        for name in names:
            rpath = f"{REMOTE_KB}/{name}"
            local_path = os.path.join(LOCAL_KB, name)
            raw = b""
            with sftp.open(rpath, "rb") as f:
                raw = f.read()
            try:
                remote = json.loads(raw.decode("utf-8"))
            except Exception:
                continue
            local = load_json(local_path, {"nodes": [], "links": []})
            merged, changed = merge_base(local, remote)
            fresh = [n for n in changed if str(n.get("at") or "") > since_stamp]
            for n in fresh:
                added.append({"base": name, "title": n.get("title") or n.get("id"), "at": n.get("at")})
            if changed and not dry_run:
                tmp = local_path + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(merged, f, ensure_ascii=False, indent=2)
                os.replace(tmp, local_path)
    finally:
        sftp.close()
    return added


def push_knowledge(client, dry_run):
    """本机新增/更新的节点推回服务器（按 id + at 合并，服务器新就不动）。"""
    pushed = 0
    local_files = [f for f in os.listdir(LOCAL_KB) if f.endswith(".json") and f not in KB_SKIP] if os.path.isdir(LOCAL_KB) else []
    if not local_files:
        return 0
    payload = {}
    for name in local_files:
        payload[name] = load_json(os.path.join(LOCAL_KB, name), None)
        if payload[name] is None:
            payload.pop(name)
    if not payload:
        return 0
    script = f'''
import json, os
data = json.load(open('/tmp/chat-sync-kb.json', encoding='utf-8'))
os.makedirs('{REMOTE_KB}', exist_ok=True)
n = 0
for name, base in data.items():
    path = os.path.join('{REMOTE_KB}', name)
    try:
        cur = json.load(open(path, encoding='utf-8'))
    except Exception:
        cur = {{'nodes': [], 'links': []}}
    nodes = {{x.get('id'): x for x in cur.get('nodes', [])}}
    for x in base.get('nodes', []):
        nid = x.get('id')
        if not nid:
            continue
        old = nodes.get(nid)
        if old is None or str(x.get('at') or '') > str(old.get('at') or ''):
            nodes[nid] = x
            n += 1
    links = {{(l.get('from'), l.get('to')): l for l in cur.get('links', []) if l.get('from')}}
    for l in base.get('links', []):
        if l.get('from') and l.get('to'):
            links[(l['from'], l['to'])] = l
    if n:
        merged = dict(cur)
        merged['nodes'] = list(nodes.values())
        merged['links'] = list(links.values())
        tmp = path + '.tmp'
        json.dump(merged, open(tmp, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
        os.replace(tmp, path)
print(n)
'''
    local_json = os.path.join(tempfile.gettempdir(), "chat-sync-kb.json")
    with open(local_json, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    sftp = client.open_sftp()
    try:
        sftp.put(local_json, "/tmp/chat-sync-kb.json")
        with sftp.open("/tmp/chat-sync-kb-push.py", "w") as f:
            f.write(script.encode("utf-8"))
    finally:
        sftp.close()
    out = run(client, "python3 /tmp/chat-sync-kb-push.py")
    try:
        pushed = int(str(out).strip().splitlines()[-1])
    except Exception:
        pushed = 0
    return pushed


# ---------- 好感度 / 心情 ----------

def _entry_ts(v):
    """从一条档案里取最近活动时间（毫秒）。取不到就 0。"""
    if not isinstance(v, dict):
        return 0
    for k in ("lastChatAt", "updatedAt", "at", "since"):
        x = v.get(k)
        if isinstance(x, (int, float)) and x:
            return int(x)
        if isinstance(x, str):
            try:
                return int(dt.datetime.fromisoformat(x.replace("Z", "+00:00")).timestamp() * 1000)
            except Exception:
                continue
    return 0


def merge_json_map(local, remote):
    """两份 {uid: 档案} 合并：同一个 uid 取时间更新的那份，本地独有的保留。
    非 dict 的值（昵称这类纯字符串）以服务器为准。"""
    local = local if isinstance(local, dict) else {}
    remote = remote if isinstance(remote, dict) else {}
    out = dict(local)
    changed = 0
    for k, rv in remote.items():
        lv = out.get(k)
        if lv is None:
            out[k] = rv
            changed += 1
            continue
        if not isinstance(lv, dict) or not isinstance(rv, dict):
            if lv != rv:
                out[k] = rv
                changed += 1
            continue
        if rv != lv and _entry_ts(rv) >= _entry_ts(lv):
            out[k] = rv
            changed += 1
    return out, changed


def merge_profile_file(local, remote):
    """整份档案合并。group_*/private_* 是 {"people": {uid: ...}}，要往里钻一层再按 uid 合并，
    否则整块 people 会被当成一个 key，本地独有的人生效不了。"""
    local = local if isinstance(local, dict) else {}
    remote = remote if isinstance(remote, dict) else {}
    if isinstance(remote.get("people"), dict):
        rp = remote["people"]
        lp = local.get("people") if isinstance(local.get("people"), dict) else {}
        people, changed = merge_json_map(lp, rp)
        merged = dict(local)
        merged.update(remote)
        merged["people"] = people
        return merged, changed
    return merge_json_map(local, remote)


def backup_file(path, keep=5):
    """写之前留一份，只留最近 keep 份。"""
    try:
        ts = dt.datetime.now().strftime("%Y%m%d%H%M%S")
        shutil.copy2(path, f"{path}.bak-sync-{ts}")
        d = os.path.dirname(path)
        base = os.path.basename(path) + ".bak-sync-"
        olds = sorted(p for p in os.listdir(d) if p.startswith(base))
        for name in olds[:-keep]:
            try:
                os.remove(os.path.join(d, name))
            except OSError:
                pass
    except OSError:
        pass


def sync_runtime_state(client, dry_run=False):
    """服务器 -> 本机：workspace/profiles/*.json（好感度）与 data/emotion.json（心情）。
    服务器在跑，所以按服务器为准；本地独有的 uid 不丢。"""
    notes = {"profiles": 0, "emotion": False, "files": []}
    sftp = client.open_sftp()
    try:
        try:
            names = sorted(n for n in sftp.listdir(REMOTE_PROFILES) if n.endswith(".json"))
        except IOError:
            names = []
        if names:
            os.makedirs(LOCAL_PROFILES, exist_ok=True)
        for name in names:
            try:
                with sftp.open(f"{REMOTE_PROFILES}/{name}", "rb") as f:
                    remote = json.loads(f.read().decode("utf-8"))
            except Exception:
                continue
            lpath = os.path.join(LOCAL_PROFILES, name)
            local = {}
            if os.path.exists(lpath):
                try:
                    with open(lpath, encoding="utf-8") as f:
                        local = json.load(f)
                except Exception:
                    local = {}
            merged, changed = merge_profile_file(local, remote)
            if not changed and os.path.exists(lpath):
                continue
            notes["profiles"] += changed
            notes["files"].append(name)
            if dry_run:
                continue
            if os.path.exists(lpath):
                backup_file(lpath)
            with open(lpath, "w", encoding="utf-8") as f:
                json.dump(merged, f, ensure_ascii=False, indent=2)

        try:
            with sftp.open(REMOTE_EMOTION, "rb") as f:
                emo = json.loads(f.read().decode("utf-8"))
        except Exception:
            emo = None
        if emo:
            lpath = LOCAL_EMOTION
            old = load_json(lpath, None)
            if old != emo:
                notes["emotion"] = True
                if not dry_run:
                    os.makedirs(os.path.dirname(lpath), exist_ok=True)
                    if old is not None:
                        backup_file(lpath)
                    with open(lpath, "w", encoding="utf-8") as f:
                        json.dump(emo, f, ensure_ascii=False, indent=2)
    finally:
        sftp.close()
    return notes


def do_state_sync(dry_run=False):
    """只同步好感度/心情，不碰记忆和知识库。计划任务每次都能跑。"""
    client = open_client()
    try:
        return sync_runtime_state(client, dry_run)
    finally:
        client.close()


# ---------- pending 标记 ----------

def read_pending(client):
    sftp = client.open_sftp()
    try:
        with sftp.open(REMOTE_PENDING, "rb") as f:
            return json.loads(f.read().decode("utf-8"))
    except Exception:
        return None
    finally:
        sftp.close()


def clear_pending(client, when_ts):
    data = json.dumps({"clearedAt": when_ts, "clearedBy": "local"}, ensure_ascii=False)
    run(client, "mkdir -p " + os.path.dirname(REMOTE_PENDING))
    sftp = client.open_sftp()
    try:
        with sftp.open(REMOTE_PENDING, "w") as f:
            f.write(data.encode("utf-8"))
    finally:
        sftp.close()


def write_report(st, added_mem, kb_added, pushed_mem, pushed_kb, started):
    os.makedirs(os.path.dirname(REPORT_PATH), exist_ok=True)
    lines = [f"# 同步报告 · {dt.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}", ""]
    lines.append(f"- 上次同步：{stamp(st.get('lastSyncAt') or 0)}")
    lines.append(f"- 服务器 → 本机：记忆 {len(added_mem)} 条 · 知识库节点 {len(kb_added)} 个")
    lines.append(f"- 本机 → 服务器：记忆 {pushed_mem} 条 · 知识库节点 {pushed_kb} 个")
    if added_mem:
        lines += ["", "## 记忆（服务器新增）"]
        for m in added_mem[:40]:
            proj = f" · {m['project']}" if m.get("project") else ""
            lines.append(f"- [{m['level']}{proj}] {m.get('title') or m['content'][:40]}")
        if len(added_mem) > 40:
            lines.append(f"- …还有 {len(added_mem) - 40} 条")
    if kb_added:
        lines += ["", "## 知识库（服务器新增）"]
        for k in kb_added[:40]:
            lines.append(f"- {k['base']}: {k['title']}")
        if len(kb_added) > 40:
            lines.append(f"- …还有 {len(kb_added) - 40} 个")
    if not added_mem and not kb_added:
        lines += ["", "这段时间没有新东西。"]
    with open(REPORT_PATH, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return "\n".join(lines)


def notify_owner(client, text):
    """让服务器代发一句到主人私聊（本机连不到 QQ，只能借桥的 /api/action）。"""
    payload = json.dumps({"op": "text", "text": text}, ensure_ascii=False)
    b64 = base64.b64encode(payload.encode("utf-8")).decode()
    script = (
        "import base64,json,urllib.request;"
        f"d=json.loads(base64.b64decode('{b64}'));"
        "req=urllib.request.Request('http://127.0.0.1:3899/api/action',"
        "data=json.dumps(d).encode(),headers={'Content-Type':'application/json'});"
        "print(urllib.request.urlopen(req,timeout=20).read().decode())"
    )
    try:
        return run(client, 'python3 -c "' + script + '"')
    except Exception:
        return ""


def do_sync(force=False, dry_run=False, push_all=False):
    started = time.time()
    st = load_state()
    client = open_client()
    tmpdir = tempfile.mkdtemp(prefix="chat-sync-")
    try:
        pending = read_pending(client)
        if not force and not pending:
            return None
        if not force and pending and pending.get("clearedAt"):
            return None

        since_ts = 0 if force else int(st.get("lastSyncAt") or 0)
        push_since = 0 if force else int(st.get("lastPushAt") or 0)
        since_stamp = dt.datetime.fromtimestamp(since_ts / 1000).strftime("%Y-%m-%dT%H:%M:%S") if since_ts else ""

        remote_db = pull_remote_db(client, tmpdir)
        added_mem, skipped = merge_memory(remote_db, dry_run, since_ts)

        kb_added = sync_knowledge(client, dry_run, since_stamp)

        pushed_mem = 0
        pushed_kb = 0
        if not dry_run:
            rows = collect_push_rows(push_since, TABLES if push_all else PUSH_LEVELS)
            pushed_mem = push_memory(client, rows, tmpdir)
            pushed_kb = push_knowledge(client, dry_run)

        new_last = int(st.get("lastSyncAt") or 0)
        con = sqlite3.connect(LOCAL_DB)
        for t in TABLES:
            try:
                r = con.execute(f"SELECT MAX(updated_at) FROM {t}").fetchone()
                if r and r[0]:
                    new_last = max(new_last, r[0])
            except sqlite3.Error:
                pass
        con.close()

        report = write_report(st, added_mem, kb_added, pushed_mem, pushed_kb, started)
        if not dry_run:
            st["lastSyncAt"] = new_last
            st["lastPushAt"] = now_ts()
            st["runs"] = int(st.get("runs") or 0) + 1
            st["lastRunAt"] = now_ts()
            save_state(st)
            if pending:
                notify_owner(
                    client,
                    f"同步好了 · 服务器→本机 记忆{len(added_mem)}/知识{len(kb_added)}"
                    f" · 本机→服务器 {pushed_mem}/{pushed_kb}",
                )
            clear_pending(client, now_ts())
        return report
    finally:
        client.close()
        shutil.rmtree(tmpdir, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="不管有没有标记都同步（force 会把游标清零：拉取和推送都走全量）")
    ap.add_argument("--push-all", action="store_true", help="本机→服务器 推全部层级（默认只推 soul/user/rules）")
    ap.add_argument("--dry-run", action="store_true", help="只计算不写任何东西")
    ap.add_argument("--watch-once", action="store_true", help="有标记才同步（计划任务用这个）")
    ap.add_argument("--watch", action="store_true", help="常驻轮询，调试用")
    a = ap.parse_args()

    log_path = os.path.join(WORKSPACE, "sync", "last-run.log")
    os.makedirs(os.path.dirname(log_path), exist_ok=True)

    def emit(s: str) -> None:
        try:
            print(s)
        except Exception:
            pass
        try:
            with open(log_path, "a", encoding="utf-8") as f:
                f.write(s + "\n")
        except Exception:
            pass

    def one():
        emit(f"--- run @ {dt.datetime.now():%Y-%m-%d %H:%M:%S} mode="
             f"{'dry-run' if a.dry_run else ('force' if a.force else 'pending')}")
        try:
            notes = do_state_sync(dry_run=a.dry_run)
            extra = " · " + ",".join(notes["files"]) if notes["files"] else ""
            emit(f"[状态] 好感度更新 {notes['profiles']} 条{extra}"
                 f" · 心情{'已更新' if notes['emotion'] else '无变化'}")
        except Exception as e:
            emit(f"[状态] 同步失败：{e}")
        try:
            rep = do_sync(force=a.force, dry_run=a.dry_run, push_all=a.push_all)
        except Exception as e:  # 断网 / 服务器重启都不该在计划任务里刷错误窗
            emit(f"[{dt.datetime.now():%H:%M:%S}] 同步失败：{e}")
            return False
        if rep is None:
            emit("没有待同步的请求")
            return False
        emit(rep)
        return True

    if a.watch:
        while True:
            one()
            time.sleep(120)
        return
    ok = one()
    if ok is False and not a.watch_once and not a.force:
        emit("没有待同步的请求（发 #同步 让服务器打标记，或用 --force）")


if __name__ == "__main__":
    main()
